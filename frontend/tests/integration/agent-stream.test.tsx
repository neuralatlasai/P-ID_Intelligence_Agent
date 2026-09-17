import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentStream } from "@/hooks/useAgentStream";

/**
 * The streaming hook, end to end against a mocked gateway.
 *
 * These exercise the behaviours that only appear when a real stream is involved: deltas
 * arriving across chunk boundaries, a failure reported in-band after the status has already
 * been sent, an abort mid-stream, and the rule that a completed run is not complete until
 * history has been re-read.
 */

const encoder = new TextEncoder();

/** Build a streaming Response whose body emits the given SSE chunks in order. */
function streamingResponse(chunks: readonly string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

function frame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

const HELLO_RUN = [
  frame("event", { type: "response.created", sequence_number: 0 }),
  frame("event", {
    type: "response.output_item.added",
    item: { type: "function_call", id: "c1", name: "graph_summary" },
  }),
  frame("event", {
    type: "response.output_item.done",
    item: { type: "function_call", id: "c1", name: "graph_summary" },
  }),
  frame("event", { type: "response.output_text.delta", delta: "Answer\n", item_id: "m1" }),
  frame("event", {
    type: "response.output_text.delta",
    delta: "FCV-2201 is a valve.",
    item_id: "m1",
  }),
  frame("event", { type: "response.completed", sequence_number: 9 }),
  frame("done", { request_id: "req_test" }),
];

beforeEach(() => {
  // Flush the delta buffer synchronously so a test does not have to wait on a frame.
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a successful run", () => {
  it("streams text, records activity, and completes only after reconciliation", async () => {
    const reconcile = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamingResponse(HELLO_RUN)));

    const { result } = renderHook(() => useAgentStream("s1", reconcile));

    await act(async () => {
      await result.current.submit({
        body: [{ role: "user", content: "Q?" }],
        displayText: "Q?",
      });
    });

    await waitFor(() => expect(result.current.state.phase).toBe("completed"));
    expect(result.current.state.assistantText).toBe("Answer\nFCV-2201 is a valve.");
    expect(result.current.state.activities.map((a) => a.label)).toEqual(["graph_summary"]);
    expect(result.current.state.activities[0]?.state).toBe("complete");
    // Backend history is the authority on what was saved.
    expect(reconcile).toHaveBeenCalledOnce();
    expect(result.current.state.partial).toBe(false);
  });

  it("sends the body unchanged, with no frontend wrapper", async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamingResponse(HELLO_RUN));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useAgentStream("s1", vi.fn().mockResolvedValue(undefined)),
    );
    const body = [{ role: "user", content: "What is FCV-2201?" }];

    await act(async () => {
      await result.current.submit({ body, displayText: "What is FCV-2201?" });
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/sessions/s1/responses/stream");
    expect(JSON.parse(init.body as string)).toEqual(body);
    // The session lives in the path. Repeating it in the body would be a second contract.
    expect(init.body as string).not.toContain('"sessionId"');
  });

  it("assembles deltas split across arbitrary chunk boundaries", async () => {
    const whole = HELLO_RUN.join("");
    const chunks = whole.match(/.{1,7}/gs) ?? [];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamingResponse(chunks)));

    const { result } = renderHook(() =>
      useAgentStream("s1", vi.fn().mockResolvedValue(undefined)),
    );
    await act(async () => {
      await result.current.submit({ body: "Q?", displayText: "Q?" });
    });

    await waitFor(() => expect(result.current.state.phase).toBe("completed"));
    expect(result.current.state.assistantText).toBe("Answer\nFCV-2201 is a valve.");
  });
});

describe("failures", () => {
  it("classifies a rejection before the stream starts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: "admission_limit", message: "busy", request_id: "req_x" },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const { result } = renderHook(() =>
      useAgentStream("s1", vi.fn().mockResolvedValue(undefined)),
    );
    await act(async () => {
      await result.current.submit({ body: "Q?", displayText: "Q?" });
    });

    expect(result.current.state.phase).toBe("failed");
    expect(result.current.state.error?.code).toBe("admission_limit");
    expect(result.current.state.error?.requestId).toBe("req_x");
    // The question is preserved so it can be retried or copied.
    expect(result.current.state.submittedText).toBe("Q?");
  });

  it("handles a failure reported in-band after streaming began", async () => {
    // The HTTP status was already sent, so the backend reports the failure as a frame.
    const chunks = [
      frame("event", {
        type: "response.output_text.delta",
        delta: "Partial ans",
        item_id: "m",
      }),
      frame("error", {
        status: 504,
        error: { code: "run_deadline_exceeded", message: "deadline", request_id: "req_y" },
      }),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamingResponse(chunks)));

    const { result } = renderHook(() =>
      useAgentStream("s1", vi.fn().mockResolvedValue(undefined)),
    );
    await act(async () => {
      await result.current.submit({ body: "Q?", displayText: "Q?" });
    });

    expect(result.current.state.phase).toBe("failed");
    expect(result.current.state.error?.code).toBe("run_deadline_exceeded");
    // Partial text is kept, and labelled as partial rather than presented as an answer.
    expect(result.current.state.assistantText).toBe("Partial ans");
    expect(result.current.state.partial).toBe(true);
  });

  it("treats a network failure as an unreachable gateway", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    const { result } = renderHook(() =>
      useAgentStream("s1", vi.fn().mockResolvedValue(undefined)),
    );
    await act(async () => {
      await result.current.submit({ body: "Q?", displayText: "Q?" });
    });

    expect(result.current.state.error?.code).toBe("gateway_unreachable");
  });

  it("never retries a streamed POST automatically", async () => {
    // The request may already have reached the backend and persisted the turn. Replaying
    // it would duplicate the conversation.
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useAgentStream("s1", vi.fn().mockResolvedValue(undefined)),
    );
    await act(async () => {
      await result.current.submit({ body: "Q?", displayText: "Q?" });
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not reconcile after a failure", async () => {
    const reconcile = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 500 })),
    );

    const { result } = renderHook(() => useAgentStream("s1", reconcile));
    await act(async () => {
      await result.current.submit({ body: "Q?", displayText: "Q?" });
    });

    expect(reconcile).not.toHaveBeenCalled();
  });
});

describe("cancellation", () => {
  it("records a cancellation, never a completion", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            frame("event", {
              type: "response.output_text.delta",
              delta: "Start",
              item_id: "m",
            }),
          ),
        );
        // Never closes: the run is still in flight when it is aborted.
      },
      cancel() {
        cancelled = true;
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    );

    const reconcile = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAgentStream("s1", reconcile));

    let pending: Promise<void>;
    act(() => {
      pending = result.current.submit({ body: "Q?", displayText: "Q?" });
    });

    await waitFor(() => expect(result.current.state.assistantText).toBe("Start"));

    act(() => {
      result.current.cancel();
    });
    await act(async () => {
      await pending;
    });

    expect(result.current.state.phase).toBe("cancelled");
    expect(result.current.state.partial).toBe(true);
    expect(cancelled).toBe(true);
    // A cancelled run is not reconciled: nothing about it is finished.
    expect(reconcile).not.toHaveBeenCalled();
  });
});

describe("concurrency", () => {
  it("refuses a second submit while one is in flight", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise<Response>((resolve) =>
            setTimeout(() => resolve(streamingResponse(HELLO_RUN)), 30),
          ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useAgentStream("s1", vi.fn().mockResolvedValue(undefined)),
    );

    await act(async () => {
      const first = result.current.submit({ body: "One", displayText: "One" });
      const second = result.current.submit({ body: "Two", displayText: "Two" });
      await Promise.all([first, second]);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
