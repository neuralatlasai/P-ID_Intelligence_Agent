/**
 * Client-side timing for one turn.
 *
 * Everything measured here is measured in the browser, so it is perceived duration and
 * nothing else. It includes the gateway hop, the backend queue, tool execution and model
 * generation, and it cannot separate them.
 *
 * That is why the UI labels it "Elapsed" rather than latency, inference time or
 * time-to-first-token. Presenting a browser-side total as a model metric would be wrong in
 * a way that invites wrong conclusions about where time is going.
 */

/** Marks captured during one run. */
export interface RunTimings {
  /** When the browser issued the request. */
  readonly submittedAt: number | null;
  /** When the first stream frame of any kind arrived. */
  readonly firstEventAt: number | null;
  /** When the first visible answer text arrived. */
  readonly firstTextAt: number | null;
  /** When the stream ended and history reconciliation finished. */
  readonly completedAt: number | null;
}

export const EMPTY_TIMINGS: RunTimings = {
  submittedAt: null,
  firstEventAt: null,
  firstTextAt: null,
  completedAt: null,
};

/** Total perceived duration in milliseconds, or `null` while it is still unknown. */
export function elapsedMs(timings: RunTimings, now?: number): number | null {
  if (timings.submittedAt === null) {
    return null;
  }
  const end = timings.completedAt ?? now ?? null;
  return end === null ? null : Math.max(0, end - timings.submittedAt);
}

/**
 * Time from submit to the first visible text.
 *
 * Diagnostic only. It is close to, but not the same as, the model's time to first token:
 * it also contains the gateway hop, backend admission and any tool calls the agent made
 * before it began writing.
 */
export function timeToFirstTextMs(timings: RunTimings): number | null {
  if (timings.submittedAt === null || timings.firstTextAt === null) {
    return null;
  }
  return Math.max(0, timings.firstTextAt - timings.submittedAt);
}

/**
 * Format a duration for display.
 *
 * Sub-second values get one decimal so a fast answer does not read as "0 s"; longer ones
 * round to whole seconds, and anything past a minute is shown as minutes and seconds.
 */
export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) {
    return `${(milliseconds / 1000).toFixed(1)} s`;
  }
  const seconds = milliseconds / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)} s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes} min ${remainder} s`;
}

/** Format a wall-clock time as HH:MM for a turn timestamp. */
export function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
