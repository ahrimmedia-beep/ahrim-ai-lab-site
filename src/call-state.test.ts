// Run with `npm test` (node:test, no extra framework: Node strips the types itself).
import assert from "node:assert/strict";
import { test } from "node:test";
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
} from "./call-state.ts";

// --- Status and timer --------------------------------------------------------------

test("a call can start from idle, ended or error, but not twice", () => {
  const expected: Record<VoiceStatus, boolean> = {
    idle: true,
    ended: true,
    error: true,
    connecting: false,
    live: false,
  };
  for (const [status, allowed] of Object.entries(expected)) {
    assert.equal(canStartCall(status as VoiceStatus), allowed, status);
  }
});

test("the timer is zero-padded mm:ss", () => {
  assert.equal(formatTimer(0), "00:00");
  assert.equal(formatTimer(9), "00:09");
  assert.equal(formatTimer(59), "00:59");
  assert.equal(formatTimer(60), "01:00");
  assert.equal(formatTimer(125), "02:05");
  assert.equal(formatTimer(600), "10:00");
});

test("progress grows with time and stops at 1", () => {
  assert.equal(callProgress(0, 120), 0);
  assert.equal(callProgress(60, 120), 0.5);
  assert.equal(callProgress(120, 120), 1);
  assert.equal(callProgress(500, 120), 1);
});

test("a live call ends itself at the time limit", () => {
  assert.equal(shouldAutoEnd("live", DEFAULT_LIMIT_SECONDS - 1, DEFAULT_LIMIT_SECONDS), false);
  assert.equal(shouldAutoEnd("live", DEFAULT_LIMIT_SECONDS, DEFAULT_LIMIT_SECONDS), true);
  assert.equal(shouldAutoEnd("live", DEFAULT_LIMIT_SECONDS + 5, DEFAULT_LIMIT_SECONDS), true);
});

test("only a live call is auto-ended, whatever the counter says", () => {
  for (const status of ["idle", "connecting", "ended", "error"] as const) {
    assert.equal(shouldAutoEnd(status, 999, DEFAULT_LIMIT_SECONDS), false, status);
  }
});

// --- Connection state --------------------------------------------------------------

test("failed and disconnected peer connections count as a dropped call", () => {
  assert.equal(isConnectionLost("failed"), true);
  assert.equal(isConnectionLost("disconnected"), true);
});

test("our own hang-up (closed) and normal states are not errors", () => {
  for (const state of ["new", "connecting", "connected", "closed"] as const) {
    assert.equal(isConnectionLost(state), false, state);
  }
});

// --- Headphones --------------------------------------------------------------------

test("a known headphone label on an output device is detected", () => {
  for (const label of ["AirPods Pro", "Bluetooth Speaker", "USB Headset", "Wired Headphones", "Galaxy Earbuds"]) {
    assert.equal(detectHeadphones([{ kind: "audiooutput", label }]), true, label);
  }
});

test("the label match ignores case", () => {
  assert.equal(detectHeadphones([{ kind: "audiooutput", label: "BLUETOOTH HEADPHONES" }]), true);
});

test("a Russian-language headphone label is detected", () => {
  // Russian for "Headphones (USB)", written with escapes to keep the sources ASCII.
  const label = "\u041d\u0430\u0443\u0448\u043d\u0438\u043a\u0438 (USB)";
  assert.equal(detectHeadphones([{ kind: "audiooutput", label }]), true);
});

test("built-in speakers alone mean no headphones", () => {
  const devices = [
    { kind: "audiooutput", label: "MacBook Pro Speakers" },
    { kind: "audioinput", label: "MacBook Pro Microphone" },
  ];
  assert.equal(detectHeadphones(devices), false);
});

test("a headset microphone does not count, only output devices do", () => {
  const devices = [
    { kind: "audioinput", label: "USB Headset Microphone" },
    { kind: "audiooutput", label: "Built-in Speakers" },
  ];
  assert.equal(detectHeadphones(devices), false);
});

test("hidden labels (no mic permission yet) mean unknown, not false", () => {
  const devices = [
    { kind: "audiooutput", label: "" },
    { kind: "audiooutput", label: "" },
  ];
  assert.equal(detectHeadphones(devices), null);
});

test("no output devices at all means unknown", () => {
  assert.equal(detectHeadphones([]), null);
  assert.equal(detectHeadphones([{ kind: "audioinput", label: "Microphone" }]), null);
});

// --- Microphone --------------------------------------------------------------------

test("the mic is requested as mono 16 kHz with echo cancellation", () => {
  const c = MIC_CONSTRAINTS as Record<string, unknown>;
  assert.deepEqual(c.channelCount, { ideal: 1 });
  assert.deepEqual(c.sampleRate, { ideal: 16000 });
  assert.deepEqual(c.echoCancellation, { ideal: true });
  assert.deepEqual(c.noiseSuppression, { ideal: true });
  assert.equal(c.googEchoCancellation, true);
});

// --- Errors ------------------------------------------------------------------------

test("a blocked microphone maps to the permission message, old and new names", () => {
  for (const name of ["NotAllowedError", "PermissionDeniedError"]) {
    assert.equal(toUserMessage(new DOMException("denied", name)), ERROR_MESSAGES.micBlocked, name);
  }
});

test("a missing microphone maps to the no-mic message, old and new names", () => {
  for (const name of ["NotFoundError", "DevicesNotFoundError"]) {
    assert.equal(toUserMessage(new DOMException("none", name)), ERROR_MESSAGES.micNotFound, name);
  }
});

test("any other DOMException keeps its own message", () => {
  assert.equal(toUserMessage(new DOMException("Device is busy", "NotReadableError")), "Device is busy");
});

test("plain errors pass their message through", () => {
  assert.equal(toUserMessage(new Error(ERROR_MESSAGES.unstableNetwork)), ERROR_MESSAGES.unstableNetwork);
  assert.equal(toUserMessage(new Error("Daily limit reached")), "Daily limit reached");
});

test("a thrown non-error gets the generic message", () => {
  for (const thrown of ["boom", 42, null, undefined, { message: "fake" }]) {
    assert.equal(toUserMessage(thrown), ERROR_MESSAGES.generic);
  }
});
