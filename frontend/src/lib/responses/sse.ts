/**
 * Server-Sent Events consumption.
 *
 * Network chunks have nothing to do with event boundaries. A single `read()` can deliver
 * half a `data:` line, three complete events, or one byte in the middle of a multi-byte
 * UTF-8 character. Splitting each chunk on newlines — the obvious implementation — is wrong
 * in all three cases, and wrong in a way that only shows up under load.
 *
 * So the byte stream is decoded with a streaming `TextDecoder`, which holds partial
 * characters across chunk boundaries, and the text is fed to the `eventsource-parser`
 * package, which holds partial frames. Neither concern is reimplemented here.
 */

import { createParser, type EventSourceMessage } from "eventsource-parser";

import {
  isResponseStreamEvent,
  type BackendDoneFrame,
  type BackendErrorFrame,
  type DecodedFrame,
} from "@/lib/responses/native-types";

/** Callback invoked for each decoded frame, in arrival order. */
export type FrameHandler = (frame: DecodedFrame) => void;

/**
 * Decode one raw SSE message into a typed frame.
 *
 * A frame whose payload is not valid JSON, or whose name is unrecognised, becomes an
 * `unknown` frame rather than an exception. The protocol is forward-evolving: a frame this
 * version has never seen must not end the conversation.
 */
export function decodeFrame(message: EventSourceMessage): DecodedFrame {
  // The SSE default event name is "message"; the backend names its frames explicitly, and
  // an unnamed frame is treated as an event frame for compatibility.
  const name = message.event && message.event !== "message" ? message.event : "event";

  let payload: unknown;
  try {
    payload = JSON.parse(message.data);
  } catch {
    return { kind: "unknown", name, raw: message.data };
  }

  switch (name) {
    case "event":
      return isResponseStreamEvent(payload)
        ? { kind: "event", event: payload }
        : { kind: "unknown", name, raw: message.data };
    case "done":
      return { kind: "done", payload: (payload ?? {}) as BackendDoneFrame };
    case "error":
      return { kind: "error", payload: (payload ?? {}) as BackendErrorFrame };
    default:
      return { kind: "unknown", name, raw: message.data };
  }
}

/**
 * Read a response body to completion, invoking `onFrame` for each decoded frame.
 *
 * The reader is released on every exit path, including an abort, so a cancelled run does
 * not leak a locked stream.
 *
 * @param body - The response body from a streaming fetch.
 * @param onFrame - Invoked synchronously per frame, in order.
 * @param signal - Aborting this stops consumption promptly and cancels the body.
 *
 * @throws {DOMException} `AbortError` when the signal is aborted, matching fetch's own
 *   cancellation semantics so callers handle one shape of cancellation rather than two.
 */
export async function consumeEventStream(
  body: ReadableStream<Uint8Array>,
  onFrame: FrameHandler,
  signal?: AbortSignal,
): Promise<void> {
  const parser = createParser({
    onEvent: (message) => onFrame(decodeFrame(message)),
  });

  const decoder = new TextDecoder("utf-8");
  const reader = body.getReader();

  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        // Flush any character bytes the decoder is still holding. Without this a final
        // multi-byte character split across the last two chunks is dropped.
        const tail = decoder.decode();
        if (tail) {
          parser.feed(tail);
        }
        break;
      }

      if (value) {
        parser.feed(decoder.decode(value, { stream: true }));
      }

      if (signal?.aborted) {
        throw abortError();
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }

  if (signal?.aborted) {
    throw abortError();
  }
}

/**
 * Build the abort error shape `fetch` produces, so one code path handles cancellation.
 */
function abortError(): Error {
  if (typeof DOMException === "function") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

/**
 * Decode a complete SSE document into frames.
 *
 * Used by tests and by any caller holding the whole stream as text. Streaming callers use
 * {@link consumeEventStream}, which never materialises the document.
 */
export function decodeEventStreamText(text: string): DecodedFrame[] {
  const frames: DecodedFrame[] = [];
  const parser = createParser({ onEvent: (message) => frames.push(decodeFrame(message)) });
  parser.feed(text);
  return frames;
}
