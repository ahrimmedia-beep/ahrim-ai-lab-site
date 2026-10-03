// The OpenAI Realtime data channel protocol, as pure functions.
//
// During a call the browser and OpenAI exchange JSON events over a WebRTC data
// channel. The React hook (examples/useWebRTCVoice.ts) owns the side effects: the
// peer connection, the microphone track, timers and React state. Every decision
// it makes from an incoming event is made here instead:
//
//   raw message -> parseServerEvent -> reduceServerEvent -> list of effects
//
// The hook only runs the effects. That keeps the call flow testable in Node.

/** The data channel OpenAI Realtime reads client events from and writes server events to. */
export const DATA_CHANNEL_LABEL = "oai-events";

// --- Timings -----------------------------------------------------------------------

/**
 * Wait after the agent's audio track is attached to the <audio> element before the
 * agent speaks. The browser's echo canceller needs a reference signal from the
 * speakers first. Without the warm-up the greeting leaks from the speakers into the
 * microphone and the agent interrupts itself on its first sentence.
 */
export const ECHO_WARMUP_MS = 800;

/**
 * Wait after the greeting before voice detection is switched on and the mic opens.
 * The tail of the agent's speech finishes playing and the echo canceller settles.
 */
export const OPEN_MIC_DELAY_MS = 600;

/** Time for the agent to finish its goodbye after it calls the endCall tool. */
export const END_CALL_DELAY_MS = 2500;

// --- Voice activity detection --------------------------------------------------------

/**
 * Server VAD settings for the listening phases.
 *
 * threshold 0.9 is high on purpose: speaker echo usually arrives about 20 dB below
 * direct speech, so the high bar cuts it. silence_duration_ms 1200: even when echo
 * passes the threshold it comes in bursts, and it cannot hold 1.2 s of continuous
 * sound to close a turn.
 */
export const VAD_SETTINGS = {
  type: "server_vad",
  threshold: 0.9,
  prefix_padding_ms: 300,
  silence_duration_ms: 1200,
  create_response: true,
} as const;

// --- Client events (browser -> OpenAI) ---------------------------------------------

export type ClientEvent = { type: string; [key: string]: unknown };

/**
 * The agent speaks first, in character. A short user message is added to the
 * conversation and a response is requested, so the model answers it with its own
 * greeting instead of reading a fixed line. The kickoff text depends on the agent
 * and is kept with the private persona settings.
 */
export function greetingKickoff(text: string): ClientEvent[] {
  return [
    {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    },
    { type: "response.create" },
  ];
}

/** Drops whatever noise or echo the input buffer collected during the greeting. */
export function clearInputBuffer(): ClientEvent {
  return { type: "input_audio_buffer.clear" };
}

/**
 * Switches server VAD on. The session itself starts with `turn_detection: null`
 * (set by the token route), so the agent cannot be cut off by its own echo while
 * it greets.
 *
 * interruptResponse false: the agent cannot be interrupted until the user has
 * really spoken. true: normal conversation, the user can cut in.
 */
export function turnDetectionUpdate(interruptResponse: boolean): ClientEvent {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      audio: {
        input: {
          turn_detection: { ...VAD_SETTINGS, interrupt_response: interruptResponse },
        },
      },
    },
  };
}

/** Reply to a tool call, so the model can go on and say "done" in its own words. */
export function functionCallOutput(callId: string | undefined, output: unknown): ClientEvent {
  return {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify(output),
    },
  };
}

// --- Server events (OpenAI -> browser) ---------------------------------------------

export type ServerEvent =
  | { type: "transcript"; role: "user" | "assistant"; text: string }
  | { type: "function_call"; name: string; args: Record<string, unknown> }
  | { type: "response_done" }
  | { type: "input_committed" }
  | { type: "error"; raw: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

/**
 * Reads one data channel message. Returns null for anything the call flow does not
 * use: broken JSON, audio deltas, session acks, empty transcripts, a tool call
 * whose arguments are not a JSON object.
 */
export function parseServerEvent(data: unknown): ServerEvent | null {
  if (typeof data !== "string") return null;
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(msg)) return null;

  switch (msg.type) {
    // What the user said, from the input transcription model.
    case "conversation.item.input_audio_transcription.completed": {
      const text = trimmedText(msg.transcript);
      return text ? { type: "transcript", role: "user", text } : null;
    }
    // What the agent said.
    case "response.audio_transcript.done": {
      const text = trimmedText(msg.transcript);
      return text ? { type: "transcript", role: "assistant", text } : null;
    }
    case "response.function_call_arguments.done": {
      const { name, arguments: argsJson } = msg;
      if (typeof name !== "string" || !name || typeof argsJson !== "string" || !argsJson) {
        return null;
      }
      let args: unknown;
      try {
        args = JSON.parse(argsJson);
      } catch {
        return null;
      }
      return isRecord(args) ? { type: "function_call", name, args } : null;
    }
    case "response.done":
      return { type: "response_done" };
    case "input_audio_buffer.committed":
      return { type: "input_committed" };
    case "error":
      return { type: "error", raw: msg };
    default:
      return null;
  }
}

// --- Call flow ---------------------------------------------------------------------

/**
 * Where the call is in its echo protection sequence.
 *
 * - greeting: VAD is off and the mic is muted. The agent says hello.
 * - guarded:  VAD is on, the mic is open, but the agent cannot be interrupted yet.
 * - open:     the user has spoken once for real, so barge-in is allowed.
 */
export type CallPhase = "greeting" | "guarded" | "open";

export const INITIAL_PHASE: CallPhase = "greeting";

export type Effect =
  | { kind: "transcript"; role: "user" | "assistant"; text: string }
  | { kind: "tool_call"; name: string; args: Record<string, unknown> }
  | { kind: "send"; event: ClientEvent }
  /** Wait delayMs, send the event, then unmute the mic unless the user muted it. */
  | { kind: "open_mic"; delayMs: number; event: ClientEvent }
  | { kind: "log_error"; event: unknown };

export type Step = { phase: CallPhase; effects: Effect[] };

/** The whole call flow: given the current phase and one server event, what to do next. */
export function reduceServerEvent(phase: CallPhase, event: ServerEvent): Step {
  switch (event.type) {
    case "transcript":
      return { phase, effects: [{ kind: "transcript", role: event.role, text: event.text }] };

    case "function_call":
      return { phase, effects: [{ kind: "tool_call", name: event.name, args: event.args }] };

    case "response_done":
      // Only the first finished response matters: that is the greeting.
      if (phase !== "greeting") return { phase, effects: [] };
      return {
        phase: "guarded",
        effects: [
          { kind: "send", event: clearInputBuffer() },
          { kind: "open_mic", delayMs: OPEN_MIC_DELAY_MS, event: turnDetectionUpdate(false) },
        ],
      };

    case "input_committed":
      // A committed buffer means server VAD heard real speech, not echo. From then
      // on the user may interrupt the agent. The update is sent again on later
      // turns too; it is idempotent.
      if (phase === "greeting") return { phase, effects: [] };
      return { phase: "open", effects: [{ kind: "send", event: turnDetectionUpdate(true) }] };

    case "error":
      return { phase, effects: [{ kind: "log_error", event: event.raw }] };
  }
}

/**
 * The agent may greet only when both are true: the data channel is open, and the
 * remote audio track has played for ECHO_WARMUP_MS. They happen in either order,
 * so each signal reports whether the greeting should go now.
 */
export function createGreetingGate() {
  let channelOpen = false;
  let audioReady = false;
  return {
    channelOpened(): boolean {
      channelOpen = true;
      return channelOpen && audioReady;
    },
    audioWarmedUp(): boolean {
      audioReady = true;
      return channelOpen && audioReady;
    },
  };
}

// --- Tools ---------------------------------------------------------------------------

/** What the agent collects with its saveLead tool. Only shown on the page. */
export interface LeadData {
  client_name?: string;
  contact?: string;
  messenger?: string;
  temperature?: string;
  budget?: string;
  object_type?: string;
  comment?: string;
}

export type ToolAction =
  | { kind: "save_lead"; lead: LeadData; reply: ClientEvent }
  | { kind: "end_call"; delayMs: number }
  | { kind: "none" };

/** Maps a tool call from the model to what the page should do. */
export function routeToolCall(name: string, args: Record<string, unknown>): ToolAction {
  if (name === "saveLead") {
    const callId = typeof args.call_id === "string" ? args.call_id : undefined;
    return {
      kind: "save_lead",
      lead: args as LeadData,
      reply: functionCallOutput(callId, { status: "ok" }),
    };
  }
  if (name === "endCall") {
    // Let the agent finish its goodbye, then hang up.
    return { kind: "end_call", delayMs: END_CALL_DELAY_MS };
  }
  return { kind: "none" };
}
