/**
 * Transport error vocabulary shared by the gateway and the browser.
 *
 * The backend already classifies its failures into stable codes. The frontend preserves
 * those codes rather than inventing a parallel taxonomy, and adds only the two conditions
 * the backend cannot report because they happen on this side of the wire: the browser
 * could not reach the gateway, and the user cancelled.
 *
 * Every message here is written for the person who has to decide what to do next. None of
 * them is "Something went wrong".
 */

/** Stable error codes. The first group mirrors the backend; the last two are frontend-only. */
export type TransportErrorCode =
  | "invalid_body"
  | "invalid_session_id"
  | "not_found"
  | "body_too_large"
  | "incompatible_input_items"
  | "admission_limit"
  | "upstream_rate_limited"
  | "run_deadline_exceeded"
  | "max_turns_exceeded"
  | "upstream_timeout"
  | "upstream_unavailable"
  | "upstream_request_rejected"
  | "session_persistence_failed"
  | "internal_error"
  | "gateway_unreachable"
  | "cancelled";

/** The minimal error body the backend returns, and which the gateway passes through. */
export interface BackendErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly request_id?: string;
  };
}

/** A transport failure, normalised for presentation. */
export interface FrontendRunError {
  readonly code: TransportErrorCode;
  /** Short, specific sentence describing what happened. */
  readonly title: string;
  /** What the user can do about it. */
  readonly detail: string;
  /** HTTP status when the failure came from a response. */
  readonly status?: number;
  /** Backend request identifier, shown in error details so a report can be traced. */
  readonly requestId?: string;
  /** Whether offering a retry control is appropriate. */
  readonly retryable: boolean;
  /** Seconds the server asked the client to wait, when it said so. */
  readonly retryAfterSeconds?: number;
}

interface Presentation {
  readonly title: string;
  readonly detail: string;
  readonly retryable: boolean;
}

/**
 * How each code is presented.
 *
 * `retryable` drives whether a retry control appears. It is false wherever retrying
 * unchanged cannot succeed — a malformed body, a rejected identifier — because offering a
 * button that will fail again is worse than offering none.
 */
const PRESENTATION: Readonly<Record<TransportErrorCode, Presentation>> = {
  invalid_body: {
    title: "Request could not be read",
    detail:
      "The question was not sent in a form the service accepts. Your text is preserved.",
    retryable: false,
  },
  invalid_session_id: {
    title: "Session address is not valid",
    detail: "Start a new session to continue.",
    retryable: false,
  },
  not_found: {
    title: "Session not available",
    detail: "This session no longer exists on the server. Start a new session to continue.",
    retryable: false,
  },
  body_too_large: {
    title: "Question is too long",
    detail: "Shorten the question and send it again.",
    retryable: false,
  },
  incompatible_input_items: {
    title: "Input was not accepted",
    detail: "The service could not interpret the submitted input. Your text is preserved.",
    retryable: false,
  },
  admission_limit: {
    title: "Service is busy",
    detail: "All analysis slots are in use. Wait a moment, then send the question again.",
    retryable: true,
  },
  upstream_rate_limited: {
    title: "Service is rate limited",
    detail: "The model provider is throttling requests. Wait briefly, then try again.",
    retryable: true,
  },
  run_deadline_exceeded: {
    title: "Analysis exceeded its time limit",
    detail:
      "The run passed the configured deadline before finishing. Your question is preserved; " +
      "try again, or narrow it to fewer drawings.",
    retryable: true,
  },
  max_turns_exceeded: {
    title: "Analysis did not converge",
    detail:
      "The agent reached its step limit before completing. No partial answer is returned, " +
      "because an incomplete investigation is not a finished engineering answer. Try a " +
      "narrower question.",
    retryable: true,
  },
  upstream_timeout: {
    title: "Model did not respond in time",
    detail: "The model provider did not answer before the timeout. Try again.",
    retryable: true,
  },
  upstream_unavailable: {
    title: "Model service unavailable",
    detail: "The model provider could not be reached. Wait a moment, then try again.",
    retryable: true,
  },
  upstream_request_rejected: {
    title: "Model rejected the request",
    detail: "The provider refused this request. Retrying it unchanged is unlikely to help.",
    retryable: false,
  },
  session_persistence_failed: {
    title: "Conversation could not be saved",
    detail:
      "The service could not persist this turn, so it was not saved. Report this with the " +
      "request ID below.",
    retryable: false,
  },
  internal_error: {
    title: "Unexpected service error",
    detail: "The service failed unexpectedly. Report this with the request ID below.",
    retryable: true,
  },
  gateway_unreachable: {
    title: "Connection lost",
    detail:
      "The response was interrupted before completion. The request may have been partially " +
      "executed. You can retry to continue.",
    retryable: true,
  },
  cancelled: {
    title: "Run cancelled",
    detail: "You stopped this run. Any text shown above is incomplete.",
    retryable: true,
  },
};

/** Status codes used when a response carried no usable error body. */
const STATUS_FALLBACK: Readonly<Record<number, TransportErrorCode>> = {
  400: "invalid_body",
  404: "not_found",
  408: "run_deadline_exceeded",
  413: "body_too_large",
  422: "incompatible_input_items",
  429: "admission_limit",
  500: "internal_error",
  502: "upstream_request_rejected",
  503: "upstream_unavailable",
  504: "run_deadline_exceeded",
};

function isKnownCode(value: string): value is TransportErrorCode {
  return Object.prototype.hasOwnProperty.call(PRESENTATION, value);
}

/** Build a presented error from a code, preserving any status and identifiers. */
export function buildRunError(
  code: TransportErrorCode,
  extras: {
    status?: number;
    requestId?: string;
    retryAfterSeconds?: number;
    detail?: string;
  } = {},
): FrontendRunError {
  const presentation = PRESENTATION[code];
  return {
    code,
    title: presentation.title,
    detail: extras.detail ?? presentation.detail,
    retryable: presentation.retryable,
    ...(extras.status === undefined ? {} : { status: extras.status }),
    ...(extras.requestId === undefined ? {} : { requestId: extras.requestId }),
    ...(extras.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: extras.retryAfterSeconds }),
  };
}

/**
 * Convert a non-OK HTTP response into a presented error.
 *
 * The backend's own code is preferred when present. Falling back to the status is what
 * keeps the UI sensible if the body is empty, truncated, or produced by an intermediary
 * that is not the backend at all.
 */
export async function toRunError(response: Response): Promise<FrontendRunError> {
  let code: TransportErrorCode = STATUS_FALLBACK[response.status] ?? "internal_error";
  let requestId = response.headers.get("x-request-id") ?? undefined;
  let detail: string | undefined;

  try {
    const body: unknown = await response.json();
    if (isBackendErrorBody(body)) {
      if (isKnownCode(body.error.code)) {
        code = body.error.code;
      }
      requestId = body.error.request_id ?? requestId;
      detail = body.error.message || undefined;
    }
  } catch {
    // An unreadable body is not itself an error: the status already told us enough, and
    // the fallback presentation is accurate.
  }

  const retryAfter = parseRetryAfter(response.headers.get("retry-after"));

  return buildRunError(code, {
    status: response.status,
    ...(requestId === undefined ? {} : { requestId }),
    ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
    // The backend message is specific and safe by contract, so it is shown when present.
    ...(detail === undefined ? {} : { detail }),
  });
}

/**
 * Normalise a thrown value into a presented error.
 *
 * An `AbortError` means the user pressed Stop or navigated away; it is a cancellation, not
 * a failure, and is never presented as one.
 */
export function normalizeError(error: unknown): FrontendRunError {
  if (isAbortError(error)) {
    return buildRunError("cancelled");
  }
  if (isFrontendRunError(error)) {
    return error;
  }
  return buildRunError("gateway_unreachable");
}

/** Report whether a thrown value is an abort rather than a failure. */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function isFrontendRunError(value: unknown): value is FrontendRunError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "title" in value &&
    "retryable" in value
  );
}

function isBackendErrorBody(value: unknown): value is BackendErrorBody {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return false;
  }
  const inner = (value as { error: unknown }).error;
  return (
    typeof inner === "object" &&
    inner !== null &&
    "code" in inner &&
    typeof (inner as { code: unknown }).code === "string"
  );
}

/**
 * Parse a `Retry-After` header.
 *
 * RFC 9110 allows either a delay in seconds or an HTTP date; both are handled, and an
 * unparseable or past value yields `undefined` rather than a misleading countdown.
 */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds);
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return undefined;
  }

  const delta = Math.ceil((timestamp - Date.now()) / 1000);
  return delta > 0 ? delta : undefined;
}
