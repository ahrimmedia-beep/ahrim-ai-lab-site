// Run with `npm test` (node:test, no extra framework: Node strips the types itself).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  END_CALL_DELAY_MS,
  INITIAL_PHASE,
  OPEN_MIC_DELAY_MS,
  VAD_SETTINGS,
  clearInputBuffer,
  createGreetingGate,
  functionCallOutput,
  greetingKickoff,
  parseServerEvent,
  reduceServerEvent,
  routeToolCall,
  turnDetectionUpdate,
  type CallPhase,
  type ServerEvent,
} from "./realtime-events.ts";

const raw = (event: unknown) => JSON.stringify(event);

// --- Parsing -----------------------------------------------------------------------

test("broken JSON and non-string frames are ignored", () => {
  assert.equal(parseServerEvent("{not json"), null);
  assert.equal(parseServerEvent(""), null);
  assert.equal(parseServerEvent(new ArrayBuffer(8)), null);
  assert.equal(parseServerEvent(undefined), null);
});

test("JSON that is not an event object is ignored", () => {
  for (const data of ["42", "null", '"response.done"', '[{"type":"response.done"}]']) {
    assert.equal(parseServerEvent(data), null, data);
  }
});

test("events the call flow does not use are ignored", () => {
  for (const type of ["session.created", "session.updated", "response.audio.delta", "rate_limits.updated"]) {
    assert.equal(parseServerEvent(raw({ type })), null, type);
  }
});

test("the user's transcript is read and trimmed", () => {
  const event = parseServerEvent(
    raw({ type: "conversation.item.input_audio_transcription.completed", transcript: "  I need a flat  \n" }),
  );
  assert.deepEqual(event, { type: "transcript", role: "user", text: "I need a flat" });
});

test("the agent's transcript is read and trimmed", () => {
  const event = parseServerEvent(raw({ type: "response.audio_transcript.done", transcript: " Hello! " }));
  assert.deepEqual(event, { type: "transcript", role: "assistant", text: "Hello!" });
});

test("empty or missing transcripts produce nothing", () => {
  for (const transcript of ["", "   ", undefined, 42]) {
    assert.equal(
      parseServerEvent(raw({ type: "conversation.item.input_audio_transcription.completed", transcript })),
      null,
    );
    assert.equal(parseServerEvent(raw({ type: "response.audio_transcript.done", transcript })), null);
  }
});

test("a tool call is read with its JSON arguments", () => {
  const event = parseServerEvent(
    raw({
      type: "response.function_call_arguments.done",
      name: "saveLead",
      arguments: JSON.stringify({ client_name: "Anna", temperature: "warm" }),
    }),
  );
  assert.deepEqual(event, {
    type: "function_call",
    name: "saveLead",
    args: { client_name: "Anna", temperature: "warm" },
  });
});

test("a tool call with broken or non-object arguments is dropped", () => {
  for (const args of ["{oops", "null", "[1,2]", '"text"', "7"]) {
    const event = parseServerEvent(
      raw({ type: "response.function_call_arguments.done", name: "saveLead", arguments: args }),
    );
    assert.equal(event, null, args);
  }
});

test("a tool call without a name or arguments is dropped", () => {
  const type = "response.function_call_arguments.done";
  assert.equal(parseServerEvent(raw({ type, arguments: "{}" })), null);
  assert.equal(parseServerEvent(raw({ type, name: "", arguments: "{}" })), null);
  assert.equal(parseServerEvent(raw({ type, name: "endCall" })), null);
  assert.equal(parseServerEvent(raw({ type, name: "endCall", arguments: "" })), null);
});

test("response.done and a committed input buffer are recognised", () => {
  assert.deepEqual(parseServerEvent(raw({ type: "response.done", response: {} })), { type: "response_done" });
  assert.deepEqual(parseServerEvent(raw({ type: "input_audio_buffer.committed" })), { type: "input_committed" });
});

test("an error event keeps the full payload for the log", () => {
  const payload = { type: "error", error: { type: "invalid_request_error", message: "bad" } };
  assert.deepEqual(parseServerEvent(raw(payload)), { type: "error", raw: payload });
});

// --- Call flow ---------------------------------------------------------------------

test("a call starts in the greeting phase", () => {
  assert.equal(INITIAL_PHASE, "greeting");
});

test("the end of the greeting clears the buffer, then opens the mic without barge-in", () => {
  const step = reduceServerEvent("greeting", { type: "response_done" });
  assert.equal(step.phase, "guarded");
  assert.deepEqual(step.effects, [
    { kind: "send", event: { type: "input_audio_buffer.clear" } },
    { kind: "open_mic", delayMs: OPEN_MIC_DELAY_MS, event: turnDetectionUpdate(false) },
  ]);
});

test("later responses do not reopen the mic or reset VAD", () => {
  for (const phase of ["guarded", "open"] as const) {
    const step = reduceServerEvent(phase, { type: "response_done" });
    assert.deepEqual(step, { phase, effects: [] }, phase);
  }
});

test("the first real user turn allows barge-in", () => {
  const step = reduceServerEvent("guarded", { type: "input_committed" });
  assert.equal(step.phase, "open");
  assert.deepEqual(step.effects, [{ kind: "send", event: turnDetectionUpdate(true) }]);
});

test("later user turns keep barge-in on", () => {
  const step = reduceServerEvent("open", { type: "input_committed" });
  assert.equal(step.phase, "open");
  assert.deepEqual(step.effects, [{ kind: "send", event: turnDetectionUpdate(true) }]);
});

test("a committed buffer during the greeting changes nothing", () => {
  assert.deepEqual(reduceServerEvent("greeting", { type: "input_committed" }), {
    phase: "greeting",
    effects: [],
  });
});

test("transcripts, tool calls and errors pass through in any phase", () => {
  const phases: CallPhase[] = ["greeting", "guarded", "open"];
  for (const phase of phases) {
    assert.deepEqual(reduceServerEvent(phase, { type: "transcript", role: "user", text: "hi" }), {
      phase,
      effects: [{ kind: "transcript", role: "user", text: "hi" }],
    });
    assert.deepEqual(reduceServerEvent(phase, { type: "function_call", name: "endCall", args: {} }), {
      phase,
      effects: [{ kind: "tool_call", name: "endCall", args: {} }],
    });
    assert.deepEqual(reduceServerEvent(phase, { type: "error", raw: { code: 1 } }), {
      phase,
      effects: [{ kind: "log_error", event: { code: 1 } }],
    });
  }
});

test("a scripted call moves from greeting to guarded to open", () => {
  const script: string[] = [
    raw({ type: "session.created" }),
    raw({ type: "response.audio_transcript.done", transcript: "Hello, how can I help?" }),
    raw({ type: "response.done" }),
    raw({ type: "input_audio_buffer.committed" }),
    raw({ type: "conversation.item.input_audio_transcription.completed", transcript: "Two rooms" }),
    raw({ type: "response.done" }),
    raw({ type: "input_audio_buffer.committed" }),
  ];
  let phase: CallPhase = INITIAL_PHASE;
  const phases: CallPhase[] = [];
  const kinds: string[] = [];
  for (const message of script) {
    const event = parseServerEvent(message);
    if (!event) continue;
    const step = reduceServerEvent(phase, event);
    phase = step.phase;
    phases.push(phase);
    kinds.push(...step.effects.map((e) => e.kind));
  }
  assert.deepEqual(phases, ["greeting", "guarded", "open", "open", "open", "open"]);
  assert.deepEqual(kinds, ["transcript", "send", "open_mic", "send", "transcript", "send"]);
});

// --- Client events -----------------------------------------------------------------

test("the greeting kickoff is a user message followed by a response request", () => {
  assert.deepEqual(greetingKickoff("Hello?"), [
    {
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: "Hello?" }] },
    },
    { type: "response.create" },
  ]);
});

test("the VAD update carries the echo-safe settings and the barge-in flag", () => {
  for (const interrupt of [false, true]) {
    assert.deepEqual(turnDetectionUpdate(interrupt), {
      type: "session.update",
      session: {
        type: "realtime",
        audio: {
          input: {
            turn_detection: {
              type: "server_vad",
              threshold: 0.9,
              prefix_padding_ms: 300,
              silence_duration_ms: 1200,
              create_response: true,
              interrupt_response: interrupt,
            },
          },
        },
      },
    });
  }
});

test("the VAD update does not share or change the settings object", () => {
  const update = turnDetectionUpdate(true) as unknown as { session: { audio: { input: { turn_detection: object } } } };
  assert.notEqual(update.session.audio.input.turn_detection, VAD_SETTINGS);
  assert.equal("interrupt_response" in VAD_SETTINGS, false);
});

test("clearing the input buffer is a single typed event", () => {
  assert.deepEqual(clearInputBuffer(), { type: "input_audio_buffer.clear" });
});

test("a tool reply sends its output as a JSON string", () => {
  assert.deepEqual(functionCallOutput("call_1", { status: "ok" }), {
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: "call_1", output: '{"status":"ok"}' },
  });
});

test("every client event survives the trip through dc.send(JSON.stringify(...))", () => {
  const events = [...greetingKickoff("Hi"), clearInputBuffer(), turnDetectionUpdate(true), functionCallOutput("c", 1)];
  for (const event of events) {
    assert.deepEqual(JSON.parse(JSON.stringify(event)), event);
  }
});

// --- Greeting gate -----------------------------------------------------------------

test("the greeting waits for both the data channel and the audio warm-up", () => {
  const channelFirst = createGreetingGate();
  assert.equal(channelFirst.channelOpened(), false);
  assert.equal(channelFirst.audioWarmedUp(), true);

  const audioFirst = createGreetingGate();
  assert.equal(audioFirst.audioWarmedUp(), false);
  assert.equal(audioFirst.channelOpened(), true);
});

test("each call gets its own gate", () => {
  const first = createGreetingGate();
  first.channelOpened();
  const second = createGreetingGate();
  assert.equal(second.audioWarmedUp(), false);
});

// --- Tools ---------------------------------------------------------------------------

test("saveLead stores the lead and confirms it to the model", () => {
  const args = { client_name: "Anna", contact: "@anna", temperature: "hot" };
  const action = routeToolCall("saveLead", args);
  assert.equal(action.kind, "save_lead");
  if (action.kind !== "save_lead") return;
  assert.deepEqual(action.lead, args);
  assert.equal(action.reply.type, "conversation.item.create");
  assert.deepEqual(
    { type: (action.reply.item as { type: string }).type, output: (action.reply.item as { output: string }).output },
    { type: "function_call_output", output: '{"status":"ok"}' },
  );
});

test("endCall hangs up after a pause for the goodbye", () => {
  assert.deepEqual(routeToolCall("endCall", { reason: "lead_saved" }), {
    kind: "end_call",
    delayMs: END_CALL_DELAY_MS,
  });
  assert.ok(END_CALL_DELAY_MS >= 2000, "the agent needs time to say goodbye");
});

test("an unknown tool does nothing", () => {
  assert.deepEqual(routeToolCall("deleteEverything", {}), { kind: "none" });
});

test("the reducer is pure: same input, same output, no shared state", () => {
  const event: ServerEvent = { type: "response_done" };
  const a = reduceServerEvent("greeting", event);
  const b = reduceServerEvent("greeting", event);
  assert.deepEqual(a, b);
  assert.notEqual(a.effects, b.effects);
});
