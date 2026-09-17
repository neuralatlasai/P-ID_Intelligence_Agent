/**
 * The one type boundary between this application and the OpenAI Responses protocol.
 *
 * Every protocol type is re-exported from the pinned `openai` package. Nothing here is
 * hand-written, and nothing anywhere else in the application declares a protocol shape of
 * its own. That is what makes the compiler and the lockfile the guard against protocol
 * drift: when the pinned package changes a union member, the build breaks at the point
 * that consumes it instead of silently mis-parsing at runtime.
 *
 * The frontend defines no `PIDRequest`, `PIDResponse` or evidence envelope. The wire
 * contract is the backend's, which is OpenAI's.
 */

export type {
  /** One item in a model response: a message, a tool call, a reasoning item, and so on. */
  ResponseOutputItem,
  /** One item of conversation input, as stored in the backend session. */
  ResponseInputItem,
  /** The full union of Server-Sent Event payloads a streamed run can emit. */
  ResponseStreamEvent,
  /** An assistant message in a response. */
  ResponseOutputMessage,
  /** A function tool call the model emitted. */
  ResponseFunctionToolCall,
  /** An incremental chunk of visible answer text. */
  ResponseTextDeltaEvent,
  /** Terminal event for a successful run. */
  ResponseCompletedEvent,
  /** Terminal event for a failed run. */
  ResponseErrorEvent,
  /** Emitted when a new output item begins. */
  ResponseOutputItemAddedEvent,
  /** Emitted when an output item is finished. */
  ResponseOutputItemDoneEvent,
} from "openai/resources/responses/responses";

import type {
  ResponseInputItem,
  ResponseOutputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";

/**
 * The transport frame the backend wraps each native event in.
 *
 * The backend emits Server-Sent Events with three names: `event` carries one native
 * Responses event verbatim, `done` marks clean completion, and `error` carries a transport
 * failure that occurred after the HTTP status had already been sent.
 *
 * This is a transport envelope, not a domain schema. The `event` frame's payload is the
 * unmodified native event.
 */
export type BackendFrameName = "event" | "done" | "error";

/** Payload of a `done` frame. */
export interface BackendDoneFrame {
  readonly request_id?: string;
}

/** Payload of an `error` frame emitted mid-stream. */
export interface BackendErrorFrame {
  readonly status?: number;
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly request_id?: string;
  };
}

/**
 * A decoded frame, discriminated by its transport name.
 *
 * Unknown frame names are preserved rather than discarded so an evolving protocol degrades
 * into an ignored frame instead of a thrown exception.
 */
export type DecodedFrame =
  | { readonly kind: "event"; readonly event: ResponseStreamEvent }
  | { readonly kind: "done"; readonly payload: BackendDoneFrame }
  | { readonly kind: "error"; readonly payload: BackendErrorFrame }
  | { readonly kind: "unknown"; readonly name: string; readonly raw: string };

/**
 * Narrow an unknown value to a native stream event.
 *
 * The check is deliberately shallow: a `type` string is enough to route the value, and the
 * projector handles unrecognised `type` values safely. Validating the full union would
 * mean re-declaring the protocol, which is exactly what this boundary exists to prevent.
 */
export function isResponseStreamEvent(value: unknown): value is ResponseStreamEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string"
  );
}

/** Narrow an unknown value to a response output item. */
export function isResponseOutputItem(value: unknown): value is ResponseOutputItem {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string"
  );
}

/**
 * Narrow an unknown value to a conversation input item.
 *
 * Session items arrive either as typed protocol objects or as plain role/content messages,
 * depending on how the turn was stored. Both are objects; the transcript projector decides
 * what each one renders as.
 */
export function isResponseInputItem(value: unknown): value is ResponseInputItem {
  return typeof value === "object" && value !== null;
}
