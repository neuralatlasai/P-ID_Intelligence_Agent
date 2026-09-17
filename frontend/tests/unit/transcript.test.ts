import { describe, expect, it } from "vitest";

import {
  projectTranscript,
  readListedPaths,
  readPathArgument,
  readText,
} from "@/lib/responses/transcript";

/**
 * Session-history projection.
 *
 * The item shapes here were captured from the running backend rather than assumed, so these
 * fixtures are a record of the real contract as well as a test.
 */

const HISTORY: unknown[] = [
  { role: "user", content: "What is FCV-2201?" },
  {
    arguments: '{"path":"PID2Graph OPEN100/0.graphml"}',
    call_id: "c1",
    name: "graph_summary",
    type: "function_call",
    id: "c1",
  },
  {
    call_id: "c1",
    output: "PID2Graph OPEN100/0.graphml: undirected graph without parallel edges.",
    type: "function_call_output",
  },
  {
    id: "msg-1",
    content: [
      {
        annotations: [],
        text: "FCV-2201 is a control valve.",
        type: "output_text",
        logprobs: [],
      },
    ],
    role: "assistant",
    status: "completed",
    type: "message",
  },
];

describe("projectTranscript", () => {
  it("builds one turn from a question, its tools and its answer", () => {
    const { turns } = projectTranscript(HISTORY);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.question).toBe("What is FCV-2201?");
    expect(turns[0]?.answer).toBe("FCV-2201 is a control valve.");
    expect(turns[0]?.incomplete).toBe(false);
  });

  it("records tool activity from persisted calls", () => {
    const { turns } = projectTranscript(HISTORY);
    expect(turns[0]?.activities.map((a) => a.label)).toEqual(["graph_summary"]);
    // History is written after the fact, so anything in it ran to completion.
    expect(turns[0]?.activities[0]?.state).toBe("complete");
  });

  it("collects the exact paths the agent opened", () => {
    const { turns } = projectTranscript(HISTORY);
    expect(turns[0]?.toolPaths).toEqual(["PID2Graph OPEN100/0.graphml"]);
  });

  it("never renders tool output into the answer", () => {
    // Tool output is corpus content. The answer is where corpus content may appear, and
    // only after the model has interpreted and attributed it.
    const { turns } = projectTranscript(HISTORY);
    expect(turns[0]?.answer).not.toContain("undirected graph");
  });

  it("marks a question with no persisted answer as incomplete", () => {
    const { turns } = projectTranscript([{ role: "user", content: "Unanswered?" }]);
    expect(turns[0]?.incomplete).toBe(true);
  });

  it("starts a new turn for each question", () => {
    const { turns } = projectTranscript([
      { role: "user", content: "First?" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "A" }] },
      { role: "user", content: "Second?" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "B" }] },
    ]);
    expect(turns.map((t) => t.question)).toEqual(["First?", "Second?"]);
    expect(turns.map((t) => t.answer)).toEqual(["A", "B"]);
  });

  it("counts an unrecognised item instead of throwing", () => {
    const result = projectTranscript([
      ...HISTORY,
      { type: "some_future_item", payload: { a: 1 } },
      "not an object",
      null,
    ]);
    expect(result.unrecognisedItems).toBe(3);
    expect(result.turns).toHaveLength(1);
  });

  it("tolerates a payload that is not an array", () => {
    expect(projectTranscript({ error: "nope" }).turns).toEqual([]);
    expect(projectTranscript(null).turns).toEqual([]);
  });

  it("opens a turn for a tool call with no preceding question", () => {
    // Possible if history were ever truncated at the front. Discarding the call would
    // silently lose evidence of work the agent did.
    const { turns } = projectTranscript([HISTORY[1], HISTORY[3]]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.question).toBe("");
  });
});

describe("readListedPaths", () => {
  it("reads paths from a corpus inventory, including those containing spaces", () => {
    const listing = [
      "Showing 1-3 of 649 matching corpus files.",
      "Dataset PID/0.graphml | graphml | 145745 bytes | mtime=2026-09-09T11:54:16+00:00",
      "PID2Graph OPEN100/0.graphml | graphml | 136165 bytes | mtime=2026-09-09T11:58:52+00:00",
      "462-Piping-and-Instrumentation-Diagrams.pdf | pdf | 3136182 bytes | mtime=2026-09-15T13:23:43+00:00",
    ].join("\n");

    expect(readListedPaths(listing)).toEqual([
      "Dataset PID/0.graphml",
      "PID2Graph OPEN100/0.graphml",
      "462-Piping-and-Instrumentation-Diagrams.pdf",
    ]);
  });

  it("ignores output that is not an inventory", () => {
    expect(readListedPaths("undirected graph without parallel edges")).toEqual([]);
    expect(readListedPaths(undefined)).toEqual([]);
  });
});

describe("readText", () => {
  it("reads a bare string", () => {
    expect(readText("hello")).toBe("hello");
  });

  it("joins visible text parts", () => {
    expect(
      readText([
        { type: "output_text", text: "a" },
        { type: "output_text", text: "b" },
      ]),
    ).toBe("ab");
  });

  it("skips non-text parts", () => {
    // Reasoning, refusals, images and files are excluded by construction rather than by
    // later filtering.
    expect(
      readText([
        { type: "reasoning", text: "internal" },
        { type: "output_text", text: "visible" },
        { type: "input_image", image_url: "data:..." },
      ]),
    ).toBe("visible");
  });

  it("returns an empty string for anything else", () => {
    expect(readText(null)).toBe("");
    expect(readText(42)).toBe("");
  });
});

describe("readPathArgument", () => {
  it("reads the path argument", () => {
    expect(readPathArgument('{"path":"area_100/PID-100.png"}')).toBe(
      "area_100/PID-100.png",
    );
  });

  it("returns null for arguments without a path", () => {
    expect(readPathArgument('{"query":"valve"}')).toBeNull();
  });

  it("returns null for malformed arguments rather than throwing", () => {
    expect(readPathArgument("{not json")).toBeNull();
    expect(readPathArgument(undefined)).toBeNull();
  });
});
