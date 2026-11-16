import type { ClientAssistantMessageEvent } from "./agent-event-wire";
import { normalizeStreamingToolCalls } from "./normalize";
import type {
  AgentMessage,
  AssistantContentBlock,
  AssistantMessage,
} from "./types";

export type { ClientAssistantMessageEvent } from "./agent-event-wire";

export interface StreamingState {
  isStreaming: boolean;
  streamingMessage: AssistantMessage | null;
}

export type StreamAction =
  | { type: "start" }
  | { type: "resume" }
  | { type: "snapshot"; message: AgentMessage }
  | { type: "delta"; event: ClientAssistantMessageEvent }
  | { type: "end" };

export const INITIAL_STREAMING_STATE: StreamingState = {
  isStreaming: false,
  streamingMessage: null,
};

function updateContentBlock(
  state: StreamingState,
  contentIndex: number,
  update: (current: AssistantContentBlock | undefined) => AssistantContentBlock | null,
): StreamingState {
  const message = state.streamingMessage;
  if (!message || !Number.isInteger(contentIndex) || contentIndex < 0) return state;

  const content = [...message.content];
  const nextBlock = update(content[contentIndex]);
  if (!nextBlock) return state;
  content[contentIndex] = nextBlock;
  return {
    isStreaming: true,
    streamingMessage: { ...message, content },
  };
}

function applyDelta(
  state: StreamingState,
  event: ClientAssistantMessageEvent,
): StreamingState {
  switch (event.type) {
    case "text_start":
      // pi-ai documents `partial` as a shared live response-so-far helper, not
      // an event-time snapshot, and blocks as empty at their `*_start` and
      // grown only by `*_delta` until the authoritative `*_end`. By the time
      // this start is consumed the helper may already carry the block's first
      // delta, so a start must reset the block instead of keeping snapshot
      // text: otherwise that chunk renders twice until `text_end` arrives.
      return updateContentBlock(state, event.contentIndex, () => ({ type: "text", text: "" }));
    case "text_delta":
      return updateContentBlock(state, event.contentIndex, (current) => (
        current?.type === "text"
          ? { ...current, text: current.text + event.delta }
          : null
      ));
    case "text_end":
      return updateContentBlock(state, event.contentIndex, (current) => ({
        ...(current?.type === "text" ? current : {}),
        type: "text",
        text: event.content,
      }));
    case "thinking_start":
      // Same snapshot leak as text_start: reset, or the first thinking chunk
      // renders twice until `thinking_end` replaces the block.
      return updateContentBlock(state, event.contentIndex, () => ({ type: "thinking", thinking: "" }));
    case "thinking_delta":
      return updateContentBlock(state, event.contentIndex, (current) => (
        current?.type === "thinking"
          ? { ...current, thinking: current.thinking + event.delta }
          : null
      ));
    case "thinking_end":
      return updateContentBlock(state, event.contentIndex, (current) => ({
        ...(current?.type === "thinking" ? current : {}),
        type: "thinking",
        thinking: event.content,
      }));
    case "toolcall_start":
      return updateContentBlock(state, event.contentIndex, (current) => {
        if (current?.type === "toolCall") {
          return {
            ...current,
            toolCallId: event.id ?? current.toolCallId,
            toolName: event.toolName ?? current.toolName,
            // Same snapshot leak as text_start: the deltas rebuild rawInput.
            rawInput: "",
          };
        }
        if (typeof event.toolName !== "string") return null;
        return {
          type: "toolCall",
          toolCallId: event.id ?? "",
          toolName: event.toolName,
          input: {},
          rawInput: "",
        };
      });
    case "toolcall_delta":
      return updateContentBlock(state, event.contentIndex, (current) => (
        current?.type === "toolCall"
          ? {
            ...current,
            toolCallId: event.id || current.toolCallId,
            toolName: event.toolName || current.toolName,
            rawInput: (current.rawInput ?? "") + event.delta,
          }
          : null
      ));
    case "toolcall_end":
      return updateContentBlock(state, event.contentIndex, () => ({
        type: "toolCall",
        toolCallId: event.toolCall.id,
        toolName: event.toolCall.name,
        input: event.toolCall.arguments,
      }));
    default:
      return state;
  }
}

export function streamReducer(
  state: StreamingState,
  action: StreamAction,
): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null };
    case "resume":
      return { ...state, isStreaming: true };
    case "snapshot": {
      const message = normalizeStreamingToolCalls(action.message);
      return message.role === "assistant"
        ? { isStreaming: true, streamingMessage: message }
        : state;
    }
    case "delta":
      return applyDelta(state, action.event);
    case "end":
      return INITIAL_STREAMING_STATE;
    default:
      return state;
  }
}

// Bound expensive Markdown/layout updates, not the arrival or storage of tokens.
export const STREAM_RENDER_INTERVAL_MS = 50;

/**
 * Streaming state is current immediately, but text/thinking/tool-input chunks
 * notify React at most once per interval. A fixed trailing window (not a
 * debounce) keeps continuous output moving without parsing Markdown per token.
 * Structural events still notify synchronously: message_end appends the final
 * reply and clears the stream in one render, cancelling any queued notification.
 */
export interface StreamingStore {
  getState(): StreamingState;
  dispatch(action: StreamAction): void;
  subscribe(listener: () => void): () => void;
}

export function createStreamingStore(): StreamingStore {
  let state = INITIAL_STREAMING_STATE;
  const listeners = new Set<() => void>();
  let pending: ReturnType<typeof setTimeout> | undefined;
  const cancelPending = () => {
    if (pending === undefined) return;
    clearTimeout(pending);
    pending = undefined;
  };
  const notify = () => {
    cancelPending();
    for (const listener of listeners) listener();
  };
  return {
    getState: () => state,
    dispatch(action) {
      const next = streamReducer(state, action);
      if (next === state) return;
      state = next;
      if (action.type === "delta" && (
        action.event.type === "text_delta"
        || action.event.type === "thinking_delta"
        || action.event.type === "toolcall_delta"
      )) {
        if (pending === undefined && listeners.size > 0) {
          pending = setTimeout(notify, STREAM_RENDER_INTERVAL_MS);
        }
      } else {
        notify();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) cancelPending();
      };
    },
  };
}
