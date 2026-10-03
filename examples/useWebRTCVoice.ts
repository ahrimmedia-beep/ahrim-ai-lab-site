// Excerpt from the site: lib/useWebRTCVoice.ts, the React hook behind the voice demo.
// It runs one call: microphone, session token, RTCPeerConnection, SDP exchange with
// OpenAI Realtime, the data channel and cleanup. The decisions it makes live in
// src/ as pure functions with tests; this file only runs their side effects.
// Not compiled in this repository: it needs React and a browser.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_LIMIT_SECONDS,
  ERROR_MESSAGES,
  MIC_CONSTRAINTS,
  callProgress,
  canStartCall,
  detectHeadphones,
  formatTimer,
  isConnectionLost,
  shouldAutoEnd,
  toUserMessage,
  type VoiceStatus,
} from "../src/call-state.ts";
import {
  DATA_CHANNEL_LABEL,
  ECHO_WARMUP_MS,
  INITIAL_PHASE,
  createGreetingGate,
  greetingKickoff,
  parseServerEvent,
  reduceServerEvent,
  routeToolCall,
  type CallPhase,
  type LeadData,
} from "../src/realtime-events.ts";
import { GREETING_KICKOFF } from "./personas"; // private: the first line the "caller" says, per agent
import { trackGoal } from "./analytics"; // private: web analytics goals

export type { VoiceStatus, LeadData };

export interface TranscriptItem {
  role: "user" | "assistant";
  text: string;
  ts: number;
}

type Bot = "outbound" | "inbound";

// GA Realtime API: the SDP offer goes to /v1/realtime/calls and the SDP answer comes
// back with 201. The model comes from the ephemeral session, so there is no ?model=.
const OPENAI_REALTIME_URL = "https://api.openai.com/v1/realtime/calls";

const SDP_FETCH_TIMEOUT_MS = 15_000;

export function useWebRTCVoice({
  bot,
  limitSeconds = DEFAULT_LIMIT_SECONDS,
}: {
  bot: Bot;
  limitSeconds?: number;
}) {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [seconds, setSeconds] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [leadData, setLeadData] = useState<LeadData | null>(null);
  const [usingHeadphones, setUsingHeadphones] = useState<boolean | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const micTrackRef = useRef<MediaStreamTrack | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Current mute state for the data channel handler, which outlives renders.
  const isMutedRef = useRef(false);
  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  // Headphones hint (label heuristic, see detectHeadphones).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!cancelled) setUsingHeadphones(detectHeadphones(devices));
      } catch {
        setUsingHeadphones(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    pcRef.current?.close();
    pcRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    micTrackRef.current = null;
    dcRef.current = null;
    if (audioRef.current) {
      audioRef.current.srcObject = null;
      audioRef.current = null;
    }
  }, []);

  // Call timer.
  useEffect(() => {
    if (status !== "live") {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setSeconds(0);
      return;
    }
    timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [status]);

  // End the call at the time limit.
  useEffect(() => {
    if (shouldAutoEnd(status, seconds, limitSeconds)) {
      cleanup();
      setStatus("ended");
      trackGoal("demo_completed");
    }
  }, [seconds, status, limitSeconds, cleanup]);

  // Release the mic and the connection on unmount.
  useEffect(() => () => cleanup(), [cleanup]);

  const handleToolCall = useCallback(
    (name: string, args: Record<string, unknown>) => {
      const action = routeToolCall(name, args);
      if (action.kind === "save_lead") {
        setLeadData(action.lead);
        dcRef.current?.send(JSON.stringify(action.reply));
      }
      if (action.kind === "end_call") {
        setTimeout(() => {
          cleanup();
          setStatus("ended");
        }, action.delayMs);
      }
    },
    [cleanup],
  );

  const startCall = useCallback(async () => {
    if (!canStartCall(status)) return;
    setStatus("connecting");
    setErrorMsg(null);
    setTranscript([]);
    setLeadData(null);

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(ERROR_MESSAGES.noMediaDevices);
      }
      if (typeof RTCPeerConnection === "undefined") {
        throw new Error(ERROR_MESSAGES.noWebRTC);
      }

      // Ask for the mic first: if the visitor says no, no paid session is created.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
      streamRef.current = stream;

      // Short-lived key for this one session. The OpenAI key never leaves the server.
      const tokenRes = await fetch("/api/realtime-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bot }),
      });
      if (!tokenRes.ok) {
        const err = await tokenRes.json().catch(() => ({}));
        throw new Error(err.error || ERROR_MESSAGES.tokenFailed);
      }
      const { clientSecret } = (await tokenRes.json()) as { clientSecret: string };

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      pc.onconnectionstatechange = () => {
        if (isConnectionLost(pc.connectionState)) {
          cleanup();
          setErrorMsg(ERROR_MESSAGES.connectionLost);
          setStatus("error");
        }
      };

      // Important: no AudioContext for audio meters here. Routing the remote stream
      // through createMediaStreamSource breaks the browser's echo cancellation: it
      // loses the link between speaker output and mic input, speaker echo reaches
      // OpenAI and the agent interrupts itself. A plain <audio> element keeps it.
      const audio = new Audio();
      audio.autoplay = true;
      audioRef.current = audio;

      // The agent greets once the data channel is open AND the remote track has
      // warmed up the echo canceller (see createGreetingGate).
      const gate = createGreetingGate();
      const greet = () => {
        for (const event of greetingKickoff(GREETING_KICKOFF[bot])) {
          dc.send(JSON.stringify(event));
        }
      };

      pc.ontrack = (e) => {
        audio.srcObject = e.streams[0];
        // Give the echo canceller a reference signal before the agent speaks.
        setTimeout(() => {
          if (gate.audioWarmedUp()) greet();
        }, ECHO_WARMUP_MS);
      };

      // The mic stays off until the greeting is over: a second guard on top of
      // echo cancellation. The reducer opens it.
      const micTrack = stream.getAudioTracks()[0];
      micTrack.enabled = false;
      micTrackRef.current = micTrack;
      pc.addTrack(micTrack);

      const dc = pc.createDataChannel(DATA_CHANNEL_LABEL);
      dcRef.current = dc;

      dc.addEventListener("open", () => {
        if (gate.channelOpened()) greet();
      });

      let phase: CallPhase = INITIAL_PHASE;
      dc.addEventListener("message", (e) => {
        const event = parseServerEvent(e.data);
        if (!event) return;
        const step = reduceServerEvent(phase, event);
        phase = step.phase;

        for (const effect of step.effects) {
          switch (effect.kind) {
            case "transcript":
              setTranscript((t) => [...t, { role: effect.role, text: effect.text, ts: Date.now() }]);
              break;
            case "tool_call":
              handleToolCall(effect.name, effect.args);
              break;
            case "send":
              dc.send(JSON.stringify(effect.event));
              break;
            case "open_mic":
              setTimeout(() => {
                dc.send(JSON.stringify(effect.event));
                if (micTrackRef.current && !isMutedRef.current) {
                  micTrackRef.current.enabled = true;
                }
              }, effect.delayMs);
              break;
            case "log_error":
              console.error("[voice] error", effect.event);
              break;
          }
        }
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      let sdpRes: Response;
      try {
        sdpRes = await fetch(OPENAI_REALTIME_URL, {
          method: "POST",
          body: offer.sdp,
          headers: {
            Authorization: `Bearer ${clientSecret}`,
            "Content-Type": "application/sdp",
          },
          signal: AbortSignal.timeout(SDP_FETCH_TIMEOUT_MS),
        });
      } catch {
        throw new Error(ERROR_MESSAGES.unstableNetwork);
      }
      if (!sdpRes.ok) throw new Error(ERROR_MESSAGES.unstableNetwork);

      const answerSdp = await sdpRes.text();
      // The connection may have closed while the fetch was running (network drop,
      // unmount, cleanup from onconnectionstatechange). setRemoteDescription would
      // then throw "signalingState is 'closed'".
      if (pc.signalingState === "closed") return;
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      setStatus("live");
      trackGoal("demo_started", { bot });
    } catch (err) {
      cleanup();
      setErrorMsg(toUserMessage(err));
      setStatus("error");
      trackGoal("demo_error", { bot });
    }
  }, [bot, cleanup, status, handleToolCall]);

  const toggleMute = useCallback(() => {
    if (!micTrackRef.current) return;
    const newMuted = !isMuted;
    micTrackRef.current.enabled = !newMuted;
    setIsMuted(newMuted);
  }, [isMuted]);

  const endCall = useCallback(() => {
    cleanup();
    setStatus("ended");
    trackGoal("demo_completed");
  }, [cleanup]);

  const resetCall = useCallback(() => {
    cleanup();
    setStatus("idle");
    setErrorMsg(null);
    setIsMuted(false);
    setTranscript([]);
    setLeadData(null);
  }, [cleanup]);

  return {
    status,
    timerText: formatTimer(seconds),
    progress: callProgress(seconds, limitSeconds),
    errorMsg,
    isMuted,
    toggleMute,
    transcript,
    leadData,
    usingHeadphones,
    startCall,
    endCall,
    resetCall,
  };
}
