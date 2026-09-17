import { describe, expect, it } from "vitest";

import type { ResponseStreamEvent } from "@/lib/responses/native-types";
import { applyActivity, projectEvent } from "@/lib/responses/projector";

/**
 * Native event projection.
 *
 * Two properties are load-bearing: only visible output text reaches the answer, and an
 * unknown event never ends the conversation. Both are asserted directly.
 */

function event(payload: Record<string, unknown>): ResponseStreamEvent {
  return payload as unknown as ResponseStreamEvent;
}

describe("visible text", () => {
  it("projects an output-text delta", () => {
    const action = projectEvent(
      event({ type: "response.output_text.delta", delta: "Hello", item_id: "m1" }),
    );
    expect(action).toEqual({ type: "TEXT_DELTA", delta: "Hello" });
  });

  it("ignores an empty delta", () => {
    expect(
      projectEvent(event({ type: "response.output_text.delta", delta: "" })).type,
    ).toBe("IGNORED");
  });
});

describe("hidden reasoning", () => {
  it.each([
    "response.reasoning_text.delta",
    "response.reasoning_text.done",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done",
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_part.done",
  ])("never surfaces %s", (type) => {
    // Reasoning content is recognised specifically so it can be deliberately excluded,
    // rather than excluded by accident because no branch happens to handle it.
    const action = projectEvent(event({ type, delta: "secret chain of thought" }));
    expect(action).toEqual({ type: "IGNORED", eventType: type });
  });
});

describe("lifecycle", () => {
  it.each(["response.created", "response.in_progress"])("treats %s as a start", (type) => {
    expect(projectEvent(event({ type })).type).toBe("RESPONSE_STARTED");
  });

  it("treats completion as terminal", () => {
    expect(projectEvent(event({ type: "response.completed" })).type).toBe(
      "RESPONSE_COMPLETED",
    );
  });

  it("reads a failure message from the response", () => {
    const action = projectEvent(
      event({
        type: "response.failed",
        response: { error: { message: "model exploded" } },
      }),
    );
    expect(action).toEqual({ type: "RESPONSE_FAILED", message: "model exploded" });
  });

  it("falls back to a neutral sentence when no reason is given", () => {
    const action = projectEvent(event({ type: "response.failed", response: {} }));
    expect(action.type).toBe("RESPONSE_FAILED");
    if (action.type === "RESPONSE_FAILED") {
      expect(action.message).toBe("The run did not complete.");
    }
  });

  it("reads an incomplete reason", () => {
    const action = projectEvent(
      event({
        type: "response.incomplete",
        response: { incomplete_details: { reason: "max_output_tokens" } },
      }),
    );
    expect(action.type).toBe("RESPONSE_FAILED");
  });
});

describe("tool activity", () => {
  it("names a tool from an added output item", () => {
    const action = projectEvent(
      event({
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id: "call_1",
          name: "graph_neighbors",
          arguments: "",
        },
      }),
    );
    expect(action).toEqual({
      type: "ACTIVITY",
      activity: { id: "call_1", label: "graph_neighbors", state: "requested" },
    });
  });

  it("marks a finished output item complete", () => {
    const action = projectEvent(
      event({
        type: "response.output_item.done",
        item: { type: "function_call", id: "call_1", name: "graph_neighbors" },
      }),
    );
    expect(action.type).toBe("ACTIVITY");
    if (action.type === "ACTIVITY") {
      expect(action.activity.state).toBe("complete");
    }
  });

  it("does not treat a message item as activity", () => {
    // A message is the answer, not a step.
    const action = projectEvent(
      event({ type: "response.output_item.added", item: { type: "message", id: "m1" } }),
    );
    expect(action.type).toBe("IGNORED");
  });

  it("never surfaces tool arguments", () => {
    const action = projectEvent(
      event({
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id: "c1",
          name: "load_corpus_artifact",
          arguments: '{"path":"secret/internal.pdf"}',
        },
      }),
    );
    expect(JSON.stringify(action)).not.toContain("secret/internal.pdf");
  });

  it.each([
    ["response.file_search_call.in_progress", "running"],
    ["response.file_search_call.completed", "complete"],
    ["response.code_interpreter_call.in_progress", "running"],
    ["response.mcp_call.failed", "failed"],
  ])("maps %s to %s", (type, state) => {
    const action = projectEvent(event({ type, item_id: "x" }));
    expect(action.type).toBe("ACTIVITY");
    if (action.type === "ACTIVITY") {
      expect(action.activity.state).toBe(state);
    }
  });
});

describe("unknown events", () => {
  it.each(["response.some_future_thing.delta", "response.audio.delta", "totally.made.up"])(
    "ignores %s without throwing",
    (type) => {
      expect(() => projectEvent(event({ type }))).not.toThrow();
      expect(projectEvent(event({ type })).type).toBe("IGNORED");
    },
  );
});

describe("applyActivity", () => {
  it("adds a new row", () => {
    const rows = applyActivity(
      [],
      { id: "a", label: "graph_summary", state: "running" },
      100,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.startedAt).toBe(100);
  });

  it("updates a row in place rather than adding another", () => {
    // A tool that reports requested, then running, then complete occupies one row that
    // changes state — not three rows that look like three operations.
    let rows = applyActivity([], { id: "a", label: "t", state: "requested" }, 100);
    rows = applyActivity(rows, { id: "a", state: "running" }, 150);
    rows = applyActivity(rows, { id: "a", state: "complete" }, 200);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("complete");
    expect(rows[0]?.completedAt).toBe(200);
    expect(rows[0]?.label).toBe("t");
  });

  it("keeps rows in the order the agent performed them", () => {
    let rows = applyActivity([], { id: "a", label: "first", state: "running" }, 1);
    rows = applyActivity(rows, { id: "b", label: "second", state: "running" }, 2);
    expect(rows.map((r) => r.label)).toEqual(["first", "second"]);
  });
});
