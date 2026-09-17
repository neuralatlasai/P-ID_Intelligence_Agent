"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { normalizeError, toRunError, type FrontendRunError } from "@/lib/backend/errors";
import { projectTranscript, type TranscriptTurn } from "@/lib/responses/transcript";

/**
 * Backend conversation history for one session.
 *
 * The backend is the authority. This hook reads history on mount, after every completed
 * run, and after a clear; it never writes to it and never caches it across sessions.
 *
 * Two race conditions are handled explicitly, because both are easy to hit in normal use
 * and produce convincing wrong output:
 *
 *  - **A stale response.** Switching sessions while a fetch is in flight can deliver the
 *    previous session's history into the new session's view. Each fetch is tagged with the
 *    session it was issued for and a response for any other session is discarded.
 *  - **An overlapping refresh.** A refresh triggered by run completion can race one
 *    triggered by navigation. The in-flight request is aborted before a new one starts, so
 *    the last request issued is the one that wins.
 */

export interface SessionHistoryState {
  readonly turns: readonly TranscriptTurn[];
  readonly loading: boolean;
  /** Null until the first successful load, so the empty state is not shown prematurely. */
  readonly loadedAt: number | null;
  readonly error: FrontendRunError | null;
  /** Items the projector did not recognise. Diagnostic only; never shown as an error. */
  readonly unrecognisedItems: number;
}

const INITIAL: SessionHistoryState = {
  turns: [],
  loading: true,
  loadedAt: null,
  error: null,
  unrecognisedItems: 0,
};

export interface UseSessionHistoryResult extends SessionHistoryState {
  readonly refresh: () => Promise<void>;
  readonly clear: () => Promise<boolean>;
}

/**
 * Load and maintain a session's transcript.
 *
 * @param sessionId - The conversation to read. Changing it discards the previous state
 *   entirely rather than merging, so two sessions can never blend.
 */
export function useSessionHistory(sessionId: string): UseSessionHistoryResult {
  const [state, setState] = useState<SessionHistoryState>(INITIAL);

  const requestRef = useRef<AbortController | null>(null);
  const sessionRef = useRef(sessionId);
  const mountedRef = useRef(true);

  // Kept current in an effect rather than assigned during render, for the same reason.
  useEffect(() => {
    sessionRef.current = sessionId;
  }, [sessionId]);

  const load = useCallback(async (targetSession: string): Promise<void> => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;

    setState((previous) => ({ ...previous, loading: true, error: null }));

    try {
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(targetSession)}/items`,
        { signal: controller.signal, cache: "no-store" },
      );

      if (!response.ok) {
        throw await toRunError(response);
      }

      const items: unknown = await response.json();
      const projection = projectTranscript(items);

      // Discard a response that arrived for a session the user has since left.
      if (!mountedRef.current || sessionRef.current !== targetSession) {
        return;
      }

      setState({
        turns: projection.turns,
        loading: false,
        loadedAt: Date.now(),
        error: null,
        unrecognisedItems: projection.unrecognisedItems,
      });
    } catch (error) {
      const normalised = normalizeError(error);
      if (!mountedRef.current || sessionRef.current !== targetSession) {
        return;
      }
      // Cancellation is the expected outcome of navigating away; it is not a failure and
      // must not replace the transcript with an error.
      if (normalised.code === "cancelled") {
        return;
      }
      setState((previous) => ({ ...previous, loading: false, error: normalised }));
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    setState(INITIAL);
    void load(sessionId);

    return () => {
      mountedRef.current = false;
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [sessionId, load]);

  const refresh = useCallback(async (): Promise<void> => {
    await load(sessionRef.current);
  }, [load]);

  /**
   * Clear the backend session, then re-read.
   *
   * Re-reading rather than assuming success is deliberate: telling the user their history
   * is gone when the delete failed is worse than telling them it did not work.
   */
  const clear = useCallback(async (): Promise<boolean> => {
    const target = sessionRef.current;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(target)}`, {
        method: "DELETE",
        cache: "no-store",
      });
      if (!response.ok) {
        const error = await toRunError(response);
        if (mountedRef.current) {
          setState((previous) => ({ ...previous, error }));
        }
        return false;
      }
      await load(target);
      return true;
    } catch (error) {
      if (mountedRef.current) {
        setState((previous) => ({ ...previous, error: normalizeError(error) }));
      }
      return false;
    }
  }, [load]);

  return { ...state, refresh, clear };
}

/** Backend availability, as reported by the gateway's combined health probe. */
export type HealthStatus = "checking" | "ready" | "degraded" | "down";

export interface HealthState {
  readonly status: HealthStatus;
  readonly corpusFiles: number | null;
  readonly checkedAt: number | null;
}

/**
 * Poll backend health.
 *
 * Polling is deliberately infrequent. Health is a background signal, and a tight poll adds
 * load to a service whose capacity is the thing being protected. The interval is paused
 * while the document is hidden, so a forgotten tab stops asking altogether.
 *
 * The default interval is five minutes because of what the signal is now used for: refusing
 * to send a question while the backend is unreachable. That is checked again at send time
 * by the request itself, so a poll exists to warn early, not to be the authority. A minute
 * bought nothing and cost a probe a minute, forever, per open tab.
 *
 * @param intervalMs - Refresh interval while the page is visible.
 */
export function useBackendHealth(intervalMs = 300_000): HealthState & {
  readonly recheck: () => void;
} {
  const [state, setState] = useState<HealthState>({
    status: "checking",
    corpusFiles: null,
    checkedAt: null,
  });
  const mountedRef = useRef(true);
  const retryRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; attempt: number }>(
    { timer: null, attempt: 0 },
  );
  /** The latest `check`, for the retry timer to call without the callback naming itself. */
  const checkRef = useRef<() => Promise<void>>(async () => {});

  const check = useCallback(async (): Promise<void> => {
    let status: HealthStatus = "down";
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      const body: unknown = await response.json();
      if (!mountedRef.current) {
        return;
      }
      status = readStatus(body);
      setState({
        status,
        corpusFiles: readCorpusFiles(body),
        checkedAt: Date.now(),
      });
    } catch {
      if (!mountedRef.current) {
        return;
      }
      setState({ status: "down", corpusFiles: null, checkedAt: Date.now() });
    }

    // A not-ready result locks the composer, so it must not stand for a whole poll
    // interval: a single slow probe under load would block asking for five minutes. Recheck
    // soon, backing off 5 s → 10 s → 20 s → 30 s, and return to the slow poll once ready.
    const retry = retryRef.current;
    if (retry.timer !== null) {
      clearTimeout(retry.timer);
      retry.timer = null;
    }
    if (status === "ready") {
      retry.attempt = 0;
      return;
    }
    const delay = Math.min(30_000, 5_000 * 2 ** retry.attempt);
    retry.attempt += 1;
    retry.timer = setTimeout(() => {
      retry.timer = null;
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        void checkRef.current();
      }
    }, delay);
  }, []);

  useEffect(() => {
    checkRef.current = check;
  }, [check]);

  useEffect(() => {
    mountedRef.current = true;
    // Probing the backend is subscribing to an external system, which is what an effect is
    // for. The rule cannot see that `check` is async and that every setState inside it
    // happens after an await, so it is suppressed here rather than restructured into
    // something less direct.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void check();

    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        void check();
      }
    }, intervalMs);

    const onVisible = (): void => {
      if (document.visibilityState === "visible") {
        void check();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    const retry = retryRef.current;
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
      if (retry.timer !== null) {
        clearTimeout(retry.timer);
        retry.timer = null;
      }
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [check, intervalMs]);

  return { ...state, recheck: () => void check() };
}

function readStatus(body: unknown): HealthStatus {
  if (typeof body !== "object" || body === null || !("status" in body)) {
    return "down";
  }
  const value = (body as { status: unknown }).status;
  return value === "ready" || value === "degraded" || value === "down" ? value : "down";
}

function readCorpusFiles(body: unknown): number | null {
  if (typeof body !== "object" || body === null || !("corpusFiles" in body)) {
    return null;
  }
  const value = (body as { corpusFiles: unknown }).corpusFiles;
  return typeof value === "number" ? value : null;
}
