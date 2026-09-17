import { describe, expect, it } from "vitest";

import { initialRunState, runReducer } from "@/hooks/useAgentStream";
import { buildRunError } from "@/lib/backend/errors";

/**
 * The run state machine.
 *
 * Two behaviours matter most and are easy to get wrong: a terminal state must stay
 * terminal even if a late event arrives after an abort, and a run is not complete until
 * history has been reconciled — the last visible token is not the end.
 */

const at = 1_000;

function submitted() {
  return runReducer(initialRunState, { type: "SUBMIT", submittedText: "Q?", at });
}

describe("submission", () => {
  it("enters connecting and records the question", () => {
    const state = submitted();
    expect(state.phase).toBe("connecting");
    expect(state.submittedText).toBe("Q?");
    expect(state.timings.submittedAt).toBe(at);
  });

  it("clears anything left from a previous run", () => {
    const stale = {
      ...initialRunState,
      assistantText: "old",
      error: buildRunError("cancelled"),
    };
    const state = runReducer(stale, { type: "SUBMIT", submittedText: "New?", at });
    expect(state.assistantText).toBe("");
    expect(state.error).toBeNull();
  });
});

describe("streaming", () => {
  it("appends deltas in order", () => {
    let state = submitted();
    state = runReducer(state, { type: "TEXT", delta: "Hello", at: at + 1 });
    state = runReducer(state, { type: "TEXT", delta: " world", at: at + 2 });
    expect(state.assistantText).toBe("Hello world");
    expect(state.phase).toBe("streaming");
  });

  it("records the first event and first text separately", () => {
    let state = submitted();
    state = runReducer(state, { type: "CONNECTED", at: at + 5 });
    state = runReducer(state, { type: "TEXT", delta: "x", at: at + 30 });
    expect(state.timings.firstEventAt).toBe(at + 5);
    expect(state.timings.firstTextAt).toBe(at + 30);
  });

  it("does not move the first-text mark on later deltas", () => {
    let state = submitted();
    state = runReducer(state, { type: "TEXT", delta: "a", at: at + 10 });
    state = runReducer(state, { type: "TEXT", delta: "b", at: at + 99 });
    expect(state.timings.firstTextAt).toBe(at + 10);
  });
});

describe("terminal states", () => {
  it("is not complete until history is reconciled", () => {
    // The last visible token is not the end: the backend may still be persisting the turn.
    let state = submitted();
    state = runReducer(state, { type: "TEXT", delta: "done", at: at + 1 });
    state = runReducer(state, { type: "STREAM_COMPLETED", at: at + 2 });
    expect(state.phase).toBe("finalizing");

    state = runReducer(state, { type: "RECONCILED", at: at + 3 });
    expect(state.phase).toBe("completed");
    expect(state.partial).toBe(false);
  });

  it("marks text partial when the run fails mid-stream", () => {
    let state = submitted();
    state = runReducer(state, { type: "TEXT", delta: "half an ans", at: at + 1 });
    state = runReducer(state, {
      type: "FAILED",
      error: buildRunError("gateway_unreachable"),
      at: at + 2,
    });
    expect(state.phase).toBe("failed");
    expect(state.partial).toBe(true);
    expect(state.assistantText).toBe("half an ans");
  });

  it("does not mark an empty failure as partial", () => {
    let state = submitted();
    state = runReducer(state, {
      type: "FAILED",
      error: buildRunError("upstream_unavailable"),
      at: at + 1,
    });
    expect(state.partial).toBe(false);
  });

  it("records a cancellation as cancelled, never as success", () => {
    let state = submitted();
    state = runReducer(state, { type: "TEXT", delta: "partial", at: at + 1 });
    state = runReducer(state, { type: "CANCELLED", at: at + 2 });
    expect(state.phase).toBe("cancelled");
    expect(state.error?.code).toBe("cancelled");
    expect(state.partial).toBe(true);
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "ignores a late event after %s",
    (terminal) => {
      // Aborting a fetch does not guarantee no further callback runs. A cancelled run must
      // stay cancelled.
      let state = submitted();
      state = runReducer(state, { type: "TEXT", delta: "a", at: at + 1 });
      state =
        terminal === "completed"
          ? runReducer(runReducer(state, { type: "STREAM_COMPLETED", at }), {
              type: "RECONCILED",
              at,
            })
          : terminal === "failed"
            ? runReducer(state, {
                type: "FAILED",
                error: buildRunError("internal_error"),
                at,
              })
            : runReducer(state, { type: "CANCELLED", at });

      const after = runReducer(state, { type: "TEXT", delta: " LATE", at: at + 99 });
      expect(after.assistantText).toBe("a");
      expect(after.phase).toBe(terminal);
    },
  );

  it("does not let reconciliation resurrect a failed run", () => {
    let state = submitted();
    state = runReducer(state, {
      type: "FAILED",
      error: buildRunError("internal_error"),
      at,
    });
    state = runReducer(state, { type: "RECONCILED", at: at + 1 });
    expect(state.phase).toBe("failed");
  });
});

describe("reset", () => {
  it("returns to the initial state", () => {
    let state = submitted();
    state = runReducer(state, { type: "TEXT", delta: "x", at });
    expect(runReducer(state, { type: "RESET" })).toEqual(initialRunState);
  });
});
