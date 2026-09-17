"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";

import {
  buildRunError,
  normalizeError,
  toRunError,
  type FrontendRunError,
} from "@/lib/backend/errors";
import {
  applyActivity,
  projectEvent,
  type ActivityView,
  type StreamPhase,
} from "@/lib/responses/projector";
import { consumeEventStream } from "@/lib/responses/sse";
import { EMPTY_TIMINGS, type RunTimings } from "@/lib/telemetry/timings";

/**
 * One streamed run, from submit to reconciliation.
 *
 * The state machine is explicit rather than spread across component effects, because the
 * interesting behaviour here is all about ordering and terminal states:
 *
 *   idle → connecting → streaming → finalizing → completed
 *                    ↘ cancelled
 *                    ↘ failed
 *
 * Three decisions in this hook are load-bearing.
 *
 * **A streamed POST is never retried automatically.** By the time the browser notices a
 * broken connection the request may already have reached the backend and persisted the
 * user's turn. Replaying it would duplicate the conversation. Retry is therefore always an
 * explicit user action.
 *
 * **Text deltas are buffered and flushed on an animation frame.** A fast stream can emit
 * deltas faster than React can usefully re-render; committing each one would thrash layout
 * for no visible benefit. Buffering preserves exact ordering — the buffer is appended to
 * and flushed in order, never reordered.
 *
 * **Completion is not the last visible token.** After the stream ends the backend may still
 * be persisting session items. The run stays in `finalizing` until history has been
 * re-read, so the UI never claims a turn is saved before it is.
 */

/** View state for the active run. Local UI projection; never sent to the backend. */
export interface AgentRunState {
  readonly phase: StreamPhase;
  /** The question as submitted, retained so it can be recovered after a failure. */
  readonly submittedText: string;
  /** Visible answer text assembled from output-text deltas only. */
  readonly assistantText: string;
  readonly activities: readonly ActivityView[];
  readonly timings: RunTimings;
  readonly error: FrontendRunError | null;
  /** True when the stream ended without a clean completion, so the text may be partial. */
  readonly partial: boolean;
}

export const initialRunState: AgentRunState = {
  phase: "idle",
  submittedText: "",
  assistantText: "",
  activities: [],
  timings: EMPTY_TIMINGS,
  error: null,
  partial: false,
};

type RunAction =
  | { type: "SUBMIT"; submittedText: string; at: number }
  | { type: "CONNECTED"; at: number }
  | { type: "TEXT"; delta: string; at: number }
  | { type: "ACTIVITY"; activity: Parameters<typeof applyActivity>[1]; at: number }
  | { type: "STREAM_COMPLETED"; at: number }
  | { type: "RECONCILING" }
  | { type: "RECONCILED"; at: number }
  | { type: "FAILED"; error: FrontendRunError; at: number }
  | { type: "CANCELLED"; at: number }
  | { type: "RESET" };

export function runReducer(state: AgentRunState, action: RunAction): AgentRunState {
  switch (action.type) {
    case "SUBMIT":
      return {
        ...initialRunState,
        phase: "connecting",
        submittedText: action.submittedText,
        timings: { ...EMPTY_TIMINGS, submittedAt: action.at },
      };

    case "CONNECTED":
      // A late event after a terminal state is ignored. Aborting a fetch does not
      // guarantee no further callback runs, and a cancelled run must stay cancelled.
      if (isTerminal(state.phase)) {
        return state;
      }
      return {
        ...state,
        phase: state.phase === "connecting" ? "streaming" : state.phase,
        timings: {
          ...state.timings,
          firstEventAt: state.timings.firstEventAt ?? action.at,
        },
      };

    case "TEXT":
      if (isTerminal(state.phase)) {
        return state;
      }
      return {
        ...state,
        phase: "streaming",
        assistantText: state.assistantText + action.delta,
        timings: {
          ...state.timings,
          firstEventAt: state.timings.firstEventAt ?? action.at,
          firstTextAt: state.timings.firstTextAt ?? action.at,
        },
      };

    case "ACTIVITY":
      if (isTerminal(state.phase)) {
        return state;
      }
      return {
        ...state,
        activities: applyActivity(state.activities, action.activity, action.at),
        timings: {
          ...state.timings,
          firstEventAt: state.timings.firstEventAt ?? action.at,
        },
      };

    case "STREAM_COMPLETED":
      if (isTerminal(state.phase)) {
        return state;
      }
      return { ...state, phase: "finalizing" };

    case "RECONCILING":
      return isTerminal(state.phase) ? state : { ...state, phase: "finalizing" };

    case "RECONCILED":
      if (state.phase === "cancelled" || state.phase === "failed") {
        return state;
      }
      return {
        ...state,
        phase: "completed",
        partial: false,
        timings: { ...state.timings, completedAt: action.at },
      };

    case "FAILED":
      return {
        ...state,
        phase: "failed",
        error: action.error,
        // Text already on screen is real, but it is not a finished answer.
        partial: state.assistantText.length > 0,
        timings: { ...state.timings, completedAt: action.at },
      };

    case "CANCELLED":
      return {
        ...state,
        phase: "cancelled",
        error: buildRunError("cancelled"),
        partial: state.assistantText.length > 0,
        timings: { ...state.timings, completedAt: action.at },
      };

    case "RESET":
      return initialRunState;

    default:
      return state;
  }
}

function isTerminal(phase: StreamPhase): boolean {
  return phase === "completed" || phase === "failed" || phase === "cancelled";
}

/** What the caller supplies to run one turn. */
export interface SubmitOptions {
  /**
   * The request body, forwarded to the backend unchanged.
   *
   * This is an OpenAI Responses input — a string, or an array of input items. It is not a
   * frontend request object, and nothing in this hook wraps it in one.
   */
  readonly body: unknown;
  /** The question text, for optimistic display and for recovery after a failure. */
  readonly displayText: string;
}

export interface UseAgentStreamResult {
  readonly state: AgentRunState;
  readonly isActive: boolean;
  readonly submit: (options: SubmitOptions) => Promise<void>;
  readonly cancel: () => void;
  readonly reset: () => void;
}

/**
 * Drive one streamed run against the gateway.
 *
 * @param sessionId - The conversation this run belongs to.
 * @param onReconcile - Invoked after the stream terminates so the caller can re-read
 *   persisted history. The run does not reach `completed` until it resolves, because the
 *   backend is the authority on what was saved.
 */
export function useAgentStream(
  sessionId: string,
  onReconcile: () => Promise<void>,
): UseAgentStreamResult {
  const [state, dispatch] = useReducer(runReducer, initialRunState);

  const abortRef = useRef<AbortController | null>(null);
  const bufferRef = useRef<string>("");
  const frameRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const reconcileRef = useRef(onReconcile);

  // Kept current in an effect rather than assigned during render: mutating a ref while
  // rendering is not safe under concurrent rendering, where a render can be discarded.
  useEffect(() => {
    reconcileRef.current = onReconcile;
  }, [onReconcile]);

  // A run belongs to the session it started in. Changing session or unmounting aborts it,
  // so a stream cannot keep writing into a conversation the user has left.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [sessionId]);

  const flushBuffer = useCallback(() => {
    frameRef.current = null;
    const pending = bufferRef.current;
    if (!pending) {
      return;
    }
    bufferRef.current = "";
    if (mountedRef.current) {
      dispatch({ type: "TEXT", delta: pending, at: Date.now() });
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    if (frameRef.current !== null) {
      return;
    }
    if (typeof requestAnimationFrame === "function") {
      frameRef.current = requestAnimationFrame(flushBuffer);
    } else {
      // Non-browser environments, such as tests, flush synchronously.
      flushBuffer();
    }
  }, [flushBuffer]);

  const submit = useCallback(
    async ({ body, displayText }: SubmitOptions): Promise<void> => {
      // One in-flight run per session. The composer enforces this too, but a double submit
      // from a fast keypress must not open a second stream.
      if (abortRef.current) {
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      bufferRef.current = "";
      dispatch({ type: "SUBMIT", submittedText: displayText, at: Date.now() });

      try {
        const response = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/responses/stream`,
          {
            method: "POST",
            headers: { "content-type": "application/json", accept: "text/event-stream" },
            body: JSON.stringify(body),
            signal: controller.signal,
            cache: "no-store",
          },
        );

        if (!response.ok) {
          throw await toRunError(response);
        }
        if (!response.body) {
          throw buildRunError("gateway_unreachable", {
            detail: "The server returned no response stream.",
          });
        }

        dispatch({ type: "CONNECTED", at: Date.now() });

        let streamError: FrontendRunError | null = null;

        await consumeEventStream(
          response.body,
          (frame) => {
            switch (frame.kind) {
              case "event": {
                const action = projectEvent(frame.event);
                if (action.type === "TEXT_DELTA") {
                  bufferRef.current += action.delta;
                  scheduleFlush();
                } else if (action.type === "ACTIVITY") {
                  dispatch({ type: "ACTIVITY", activity: action.activity, at: Date.now() });
                } else if (action.type === "RESPONSE_STARTED") {
                  dispatch({ type: "CONNECTED", at: Date.now() });
                } else if (action.type === "RESPONSE_FAILED") {
                  streamError = buildRunError("internal_error", { detail: action.message });
                }
                // IGNORED covers reasoning content and unknown event types. Both are
                // deliberately dropped rather than surfaced.
                break;
              }
              case "error": {
                // The stream began, so the HTTP status was already sent; the backend
                // reports the failure in-band instead.
                const payload = frame.payload;
                streamError = buildRunError(
                  (payload.error?.code as FrontendRunError["code"]) ?? "internal_error",
                  {
                    ...(payload.status === undefined ? {} : { status: payload.status }),
                    ...(payload.error?.request_id === undefined
                      ? {}
                      : { requestId: payload.error.request_id }),
                    ...(payload.error?.message === undefined
                      ? {}
                      : { detail: payload.error.message }),
                  },
                );
                break;
              }
              case "done":
              case "unknown":
                break;
              default:
                break;
            }
          },
          controller.signal,
        );

        flushBuffer();

        if (streamError) {
          dispatch({ type: "FAILED", error: streamError, at: Date.now() });
          return;
        }

        dispatch({ type: "STREAM_COMPLETED", at: Date.now() });

        // Backend history wins. Reconciling guards against a missed final frame, a local
        // assembly bug, and any difference between what streamed and what was stored.
        dispatch({ type: "RECONCILING" });
        await reconcileRef.current();
        if (mountedRef.current) {
          dispatch({ type: "RECONCILED", at: Date.now() });
        }
      } catch (error) {
        flushBuffer();
        const normalised = normalizeError(error);
        if (!mountedRef.current) {
          return;
        }
        if (normalised.code === "cancelled") {
          dispatch({ type: "CANCELLED", at: Date.now() });
        } else {
          dispatch({ type: "FAILED", error: normalised, at: Date.now() });
        }
      } finally {
        abortRef.current = null;
      }
    },
    [sessionId, scheduleFlush, flushBuffer],
  );

  const cancel = useCallback(() => {
    // Aborting propagates through the gateway to the backend, which releases the run's
    // session lock and admission slot. This stops work; it does not merely hide it.
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    bufferRef.current = "";
    dispatch({ type: "RESET" });
  }, []);

  return {
    state,
    isActive:
      state.phase === "connecting" ||
      state.phase === "streaming" ||
      state.phase === "finalizing",
    submit,
    cancel,
    reset,
  };
}
