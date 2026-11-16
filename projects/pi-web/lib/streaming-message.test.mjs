import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  INITIAL_STREAMING_STATE,
  STREAM_RENDER_INTERVAL_MS,
  createStreamingStore,
  streamReducer,
} = await jiti.import("./streaming-message.ts");

function assistant(content = []) {
  return {
    role: "assistant",
    content,
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    timestamp: 123,
  };
}

function snapshot(state, message) {
  return streamReducer(state, { type: "snapshot", message });
}

function delta(state, event) {
  return streamReducer(state, { type: "delta", event });
}

test("builds thinking and text blocks from official assistant deltas", () => {
  let state = streamReducer(INITIAL_STREAMING_STATE, { type: "start" });
  state = snapshot(state, assistant());
  state = delta(state, { type: "thinking_start", contentIndex: 0 });
  state = delta(state, { type: "thinking_delta", contentIndex: 0, delta: "Plan" });
  state = delta(state, { type: "thinking_end", contentIndex: 0, content: "Plan." });
  state = delta(state, { type: "text_start", contentIndex: 1 });
  state = delta(state, { type: "text_delta", contentIndex: 1, delta: "Hel" });
  state = delta(state, { type: "text_delta", contentIndex: 1, delta: "lo" });
  state = delta(state, { type: "text_end", contentIndex: 1, content: "Hello" });

  assert.equal(state.isStreaming, true);
  assert.equal(state.streamingMessage.model, "claude-sonnet-4-6");
  assert.equal(state.streamingMessage.provider, "anthropic");
  assert.equal(state.streamingMessage.timestamp, 123);
  assert.deepEqual(state.streamingMessage.content, [
    { type: "thinking", thinking: "Plan." },
    { type: "text", text: "Hello" },
  ]);
});

test("a reconnect snapshot replaces the old partial before deltas continue", () => {
  let state = snapshot(INITIAL_STREAMING_STATE, assistant([
    { type: "text", text: "stale" },
  ]));
  state = snapshot(state, assistant([
    { type: "text", text: "Hello wor" },
  ]));
  state = delta(state, { type: "text_delta", contentIndex: 0, delta: "ld" });

  assert.deepEqual(state.streamingMessage.content, [
    { type: "text", text: "Hello world" },
  ]);
});

test("resuming a running session preserves an already-received partial", () => {
  let state = snapshot(INITIAL_STREAMING_STATE, assistant([
    { type: "text", text: "Hello" },
  ]));
  state = streamReducer(state, { type: "resume" });

  assert.equal(state.isStreaming, true);
  assert.deepEqual(state.streamingMessage.content, [
    { type: "text", text: "Hello" },
  ]);
});

test("a thinking start clears the first chunk leaked into the assistant snapshot", () => {
  // Pi's `start` event aliases the live partial message, so `message_start`
  // can already contain the first delta; the deltas deliver it again.
  let state = snapshot(INITIAL_STREAMING_STATE, assistant([
    { type: "thinking", thinking: "The", thinkingSignature: "reasoning_content" },
  ]));
  state = delta(state, { type: "thinking_start", contentIndex: 0 });
  state = delta(state, { type: "thinking_delta", contentIndex: 0, delta: "The" });
  state = delta(state, { type: "thinking_delta", contentIndex: 0, delta: " user" });

  assert.deepEqual(state.streamingMessage.content, [
    { type: "thinking", thinking: "The user" },
  ]);
});

test("a text start clears text leaked into the assistant snapshot", () => {
  let state = snapshot(INITIAL_STREAMING_STATE, assistant([
    { type: "text", text: "The" },
  ]));
  state = delta(state, { type: "text_start", contentIndex: 0 });
  state = delta(state, { type: "text_delta", contentIndex: 0, delta: "The" });
  state = delta(state, { type: "text_delta", contentIndex: 0, delta: " command" });

  assert.deepEqual(state.streamingMessage.content, [
    { type: "text", text: "The command" },
  ]);
});

test("a tool call start clears streamed input leaked into the snapshot", () => {
  let state = snapshot(INITIAL_STREAMING_STATE, assistant([
    { type: "toolCall", id: "call-1", name: "bash", arguments: {}, partialJson: '{"command":' },
  ]));
  state = delta(state, { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "bash" });
  state = delta(state, { type: "toolcall_delta", contentIndex: 0, delta: '{"command":' });
  state = delta(state, { type: "toolcall_delta", contentIndex: 0, delta: '"pwd"}' });

  assert.equal(state.streamingMessage.content[0].rawInput, '{"command":"pwd"}');
  assert.deepEqual(state.streamingMessage.content[0].input, {});
});

test("text deltas update immutably so React observes each chunk", () => {
  const previous = snapshot(INITIAL_STREAMING_STATE, assistant([
    { type: "text", text: "Hello" },
  ]));
  const next = delta(previous, { type: "text_delta", contentIndex: 0, delta: "!" });

  assert.notStrictEqual(next, previous);
  assert.notStrictEqual(next.streamingMessage, previous.streamingMessage);
  assert.notStrictEqual(next.streamingMessage.content, previous.streamingMessage.content);
  assert.equal(previous.streamingMessage.content[0].text, "Hello");
  assert.equal(next.streamingMessage.content[0].text, "Hello!");
});

test("shows and streams a tool call after thinking, then accepts the authoritative end", () => {
  let state = snapshot(INITIAL_STREAMING_STATE, assistant([
    { type: "thinking", thinking: "I will write the file." },
  ]));

  state = delta(state, {
    type: "toolcall_start",
    contentIndex: 1,
    id: "call-1",
    toolName: "write",
  });
  assert.deepEqual(state.streamingMessage.content, [
    { type: "thinking", thinking: "I will write the file." },
    {
      type: "toolCall",
      toolCallId: "call-1",
      toolName: "write",
      input: {},
      rawInput: "",
    },
  ]);

  const beforeDelta = state;
  state = delta(state, {
    type: "toolcall_delta",
    contentIndex: 1,
    delta: '{"path":',
    id: "call-1",
    toolName: "write",
  });
  state = delta(state, { type: "toolcall_delta", contentIndex: 1, delta: '"/tmp/file"' });
  assert.notStrictEqual(state, beforeDelta);
  assert.equal(state.streamingMessage.content[1].rawInput, '{"path":"/tmp/file"');

  state = delta(state, {
    type: "toolcall_end",
    contentIndex: 1,
    toolCall: {
      type: "toolCall",
      id: "call-1",
      name: "write",
      arguments: { path: "/tmp/file" },
    },
  });
  assert.deepEqual(state.streamingMessage.content, [
    { type: "thinking", thinking: "I will write the file." },
    {
      type: "toolCall",
      toolCallId: "call-1",
      toolName: "write",
      input: { path: "/tmp/file" },
    },
  ]);
  assert.equal(Object.hasOwn(state.streamingMessage.content[1], "rawInput"), false);
});

test("restores the raw tool input from a reconnect snapshot", () => {
  const state = snapshot(INITIAL_STREAMING_STATE, assistant([{
    type: "toolCall",
    id: "call-2",
    name: "write",
    arguments: { path: "/tmp/reconnected" },
    partialJson: '{"path":"/tmp/reconnected","content":"hel',
  }]));

  assert.deepEqual(state.streamingMessage.content, [{
    type: "toolCall",
    toolCallId: "call-2",
    toolName: "write",
    input: { path: "/tmp/reconnected" },
    rawInput: '{"path":"/tmp/reconnected","content":"hel',
  }]);
});

test("ignores deltas without a baseline and unknown future deltas", () => {
  const started = streamReducer(INITIAL_STREAMING_STATE, { type: "start" });
  assert.strictEqual(
    delta(started, { type: "text_delta", contentIndex: 0, delta: "lost" }),
    started,
  );

  const withMessage = snapshot(started, assistant());
  assert.strictEqual(
    delta(withMessage, { type: "future_delta", contentIndex: 0, delta: "ignored" }),
    withMessage,
  );
});

test("normalizes tool calls in snapshots and clears on end", () => {
  const state = snapshot(INITIAL_STREAMING_STATE, assistant([{
    type: "toolCall",
    id: "call-2",
    name: "bash",
    arguments: { command: "pwd" },
  }]));
  assert.deepEqual(state.streamingMessage.content, [{
    type: "toolCall",
    toolCallId: "call-2",
    toolName: "bash",
    input: { command: "pwd" },
  }]);
  assert.strictEqual(streamReducer(state, { type: "end" }), INITIAL_STREAMING_STATE);
});

test("the store notifies on a change only and stops after unsubscribe", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = createStreamingStore();
  const seen = [];
  const unsubscribe = store.subscribe(() => seen.push(store.getState()));
  store.dispatch({ type: "end" });
  assert.deepEqual(seen, [], "ending an idle stream changes nothing");

  store.dispatch({ type: "start" });
  store.dispatch({ type: "snapshot", message: assistant([{ type: "text", text: "Hel" }]) });
  store.dispatch({ type: "delta", event: { type: "text_delta", contentIndex: 0, delta: "lo" } });
  assert.equal(seen.length, 2, "a text chunk does not force an immediate render");
  assert.equal(store.getState().streamingMessage.content[0].text, "Hello");
  t.mock.timers.tick(STREAM_RENDER_INTERVAL_MS);
  assert.equal(seen.length, 3);

  unsubscribe();
  store.dispatch({ type: "end" });
  assert.equal(seen.length, 3);
  assert.strictEqual(store.getState(), INITIAL_STREAMING_STATE);
});

for (const [kind, field] of [["text", "text"], ["thinking", "thinking"], ["toolcall", "rawInput"]]) {
  test(`the store coalesces ${kind} deltas without losing chunks or starving a continuous stream`, (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const store = createStreamingStore();
    store.dispatch({ type: "snapshot", message: assistant() });
    store.dispatch({ type: "delta", event: { type: `${kind}_start`, contentIndex: 0, id: "tool-1", toolName: "write" } });
    const seen = [];
    store.subscribe(() => seen.push(store.getState().streamingMessage.content[0][field]));
    for (let i = 0; i < 20; i++) {
      store.dispatch({ type: "delta", event: { type: `${kind}_delta`, contentIndex: 0, delta: String(i % 10) } });
      t.mock.timers.tick(STREAM_RENDER_INTERVAL_MS / 10);
    }
    assert.deepEqual(seen, ["0123456789", "01234567890123456789"]);
    assert.equal(store.getState().streamingMessage.content[0][field], "01234567890123456789");
    t.mock.timers.tick(STREAM_RENDER_INTERVAL_MS * 2);
    assert.equal(seen.length, 2, "no polling after the last chunk");
  });
}

test("authoritative block ends and stream replacement notify immediately and cancel queued renders", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = createStreamingStore();
  store.dispatch({ type: "snapshot", message: assistant([{ type: "text", text: "" }]) });
  const seen = [];
  store.subscribe(() => seen.push(store.getState()));
  const append = () => store.dispatch({ type: "delta", event: { type: "text_delta", contentIndex: 0, delta: "partial" } });
  append();
  store.dispatch({ type: "delta", event: { type: "text_end", contentIndex: 0, content: "authoritative" } });
  assert.equal(seen.at(-1).streamingMessage.content[0].text, "authoritative");
  append();
  store.dispatch({ type: "snapshot", message: assistant([{ type: "text", text: "reconnected" }]) });
  assert.equal(seen.at(-1).streamingMessage.content[0].text, "reconnected");
  append();
  store.dispatch({ type: "end" });
  assert.strictEqual(seen.at(-1), INITIAL_STREAMING_STATE);
  assert.equal(seen.length, 3);
  t.mock.timers.tick(STREAM_RENDER_INTERVAL_MS * 2);
  assert.equal(seen.length, 3, "a pending timer must not resurrect a finished stream");
});

test("unmount cancels a pending notification while a new subscriber reads the latest state", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = createStreamingStore();
  store.dispatch({ type: "snapshot", message: assistant([{ type: "text", text: "" }]) });
  let calls = 0;
  const unsubscribe = store.subscribe(() => calls++);
  store.dispatch({ type: "delta", event: { type: "text_delta", contentIndex: 0, delta: "kept" } });
  unsubscribe();
  const unsubscribeNext = store.subscribe(() => calls++);
  assert.equal(store.getState().streamingMessage.content[0].text, "kept");
  t.mock.timers.tick(STREAM_RENDER_INTERVAL_MS * 2);
  assert.equal(calls, 0, "no stale queued work after unmount");
  unsubscribeNext();
});
