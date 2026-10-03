// Call lifecycle helpers for the in-browser voice call.
//
// The React hook (examples/useWebRTCVoice.ts) keeps the status, the timer and the
// error text in React state. The rules behind them live here as plain functions,
// so they can be tested in Node without a browser, a microphone or React.

export type VoiceStatus = "idle" | "connecting" | "live" | "ended" | "error";

/** Hard cap on one demo call. The hook ends the call itself when it is reached. */
export const DEFAULT_LIMIT_SECONDS = 120;

/** A second press on "Call" while a call is starting or running is ignored. */
export function canStartCall(status: VoiceStatus): boolean {
  return status !== "connecting" && status !== "live";
}

/** "mm:ss" for the on-screen call timer. */
export function formatTimer(seconds: number): string {
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/** Share of the time limit already used, 0..1, for the progress ring. */
export function callProgress(seconds: number, limitSeconds: number): number {
  return Math.min(1, seconds / limitSeconds);
}

/** True once a live call reaches its time limit. */
export function shouldAutoEnd(status: VoiceStatus, seconds: number, limitSeconds: number): boolean {
  return status === "live" && seconds >= limitSeconds;
}

/**
 * Network drop detection for `pc.onconnectionstatechange`.
 *
 * "closed" is left out on purpose: the peer connection reaches it when the hook
 * itself hangs up, and that is a normal end, not an error.
 */
export function isConnectionLost(state: RTCPeerConnectionState): boolean {
  return state === "failed" || state === "disconnected";
}

// --- Headphones ------------------------------------------------------------------

// "\u043d\u0430\u0443\u0448\u043d" is the Russian stem for "headphones", as some
// systems name output devices in the user's language.
const HEADPHONES_LABEL =
  /headphone|headset|bluetooth|airpod|earphone|earbuds|\u043d\u0430\u0443\u0448\u043d/i;

export type AudioDevice = { kind: string; label: string };

/**
 * Best guess whether the visitor listens through headphones, from the device labels
 * of `navigator.mediaDevices.enumerateDevices()`. The page uses it to suggest
 * headphones, because speakers feed the agent's voice back into the microphone.
 *
 * Returns null when it cannot tell: browsers hide device labels until the page has
 * microphone permission, so an empty label means "unknown", not "no headphones".
 */
export function detectHeadphones(devices: readonly AudioDevice[]): boolean | null {
  const outputs = devices.filter((d) => d.kind === "audiooutput");
  const allEmpty = outputs.every((d) => !d.label);
  if (allEmpty) return null;
  return outputs.some((d) => HEADPHONES_LABEL.test(d.label));
}

// --- Microphone ------------------------------------------------------------------

/**
 * Mono, 16 kHz and every echo and noise flag the browser offers.
 *
 * Mono at 16 kHz is close to the format the model works with, and the browser's
 * echo canceller does a better job when it does not have to resample and downmix
 * a stereo track. The goog* keys are Chrome-only legacy flags (typing noise filter,
 * high-pass filter for fan hum). They are deprecated but still honoured, and other
 * browsers ignore them.
 */
export const MIC_CONSTRAINTS = {
  echoCancellation: { ideal: true },
  noiseSuppression: { ideal: true },
  autoGainControl: { ideal: true },
  channelCount: { ideal: 1 },
  sampleRate: { ideal: 16000 },
  googEchoCancellation: true,
  googEchoCancellation2: true,
  googAutoGainControl: true,
  googNoiseSuppression: true,
  googNoiseSuppression2: true,
  googHighpassFilter: true,
  googTypingNoiseDetection: true,
} as MediaTrackConstraints;

// --- Errors ----------------------------------------------------------------------

export const ERROR_MESSAGES = {
  noMediaDevices: "Microphone is not available. Open the site over HTTPS.",
  noWebRTC: "Your browser does not support WebRTC. Try Chrome or Safari.",
  tokenFailed: "Could not get a session token.",
  connectionLost: "The connection dropped. Check your internet and try again.",
  unstableNetwork: "The network is unstable, please try again.",
  generic: "Connection error.",
  micBlocked:
    "The microphone is blocked. Allow access in the browser settings, or leave your number and we will call you.",
  micNotFound: "No microphone found. Connect a headset or use the form below.",
} as const;

/**
 * Turns whatever `startCall` threw into one line for the visitor.
 *
 * getUserMedia reports permission and hardware problems as DOMException names.
 * Both the current names and the legacy ones from older browsers are mapped.
 * Every other error keeps its own message: the hook throws plain Errors with
 * ERROR_MESSAGES text, and the token route returns a ready message in its body.
 */
export function toUserMessage(err: unknown): string {
  let msg = err instanceof Error ? err.message : ERROR_MESSAGES.generic;
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
      msg = ERROR_MESSAGES.micBlocked;
    } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
      msg = ERROR_MESSAGES.micNotFound;
    }
  }
  return msg;
}
