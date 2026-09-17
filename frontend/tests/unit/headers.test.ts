import { describe, expect, it } from "vitest";

import {
  buildBackendHeaders,
  buildClientHeaders,
  buildStreamingClientHeaders,
} from "@/lib/backend/headers";

/**
 * Gateway header policy.
 *
 * Headers are allowlisted in both directions, so the interesting assertions are about what
 * does *not* get through: credentials must never be forwarded upstream to a backend that
 * does not expect them, and hop-by-hop headers must never cross a proxy boundary, because
 * forwarding them corrupts framing and truncates a stream.
 */

describe("buildBackendHeaders", () => {
  it("forwards the content type and correlation identifiers", () => {
    const headers = buildBackendHeaders(
      new Headers({
        "content-type": "application/json",
        "x-request-id": "req-1",
        traceparent: "00-abc-def-01",
      }),
    );
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-request-id")).toBe("req-1");
    expect(headers.get("traceparent")).toBe("00-abc-def-01");
  });

  it.each([
    "cookie",
    "authorization",
    "host",
    "origin",
    "referer",
    "x-forwarded-for",
    "connection",
    "transfer-encoding",
    "content-length",
  ])("does not forward %s", (name) => {
    const headers = buildBackendHeaders(new Headers({ [name]: "value" }));
    expect(headers.get(name)).toBeNull();
  });

  it("lets an explicit override win over a forwarded value", () => {
    const headers = buildBackendHeaders(new Headers({ accept: "application/json" }), {
      accept: "text/event-stream",
    });
    expect(headers.get("accept")).toBe("text/event-stream");
  });
});

describe("buildClientHeaders", () => {
  it("forces no-store on every proxied response", () => {
    // Conversation history is per-request state. An intermediary caching it would show one
    // user another user's turn.
    const headers = buildClientHeaders(
      new Headers({ "cache-control": "public, max-age=600" }),
    );
    expect(headers.get("cache-control")).toBe("no-store");
  });

  it("preserves the request id and retry-after", () => {
    const headers = buildClientHeaders(
      new Headers({ "x-request-id": "req-9", "retry-after": "30" }),
    );
    expect(headers.get("x-request-id")).toBe("req-9");
    expect(headers.get("retry-after")).toBe("30");
  });

  it.each(["set-cookie", "server", "x-powered-by", "transfer-encoding"])(
    "does not return %s to the browser",
    (name) => {
      const headers = buildClientHeaders(new Headers({ [name]: "value" }));
      expect(headers.get(name)).toBeNull();
    },
  );
});

describe("buildStreamingClientHeaders", () => {
  it("disables proxy buffering so the stream stays incremental", () => {
    const headers = buildStreamingClientHeaders(
      new Headers({ "content-type": "text/event-stream" }),
    );
    expect(headers.get("x-accel-buffering")).toBe("no");
    expect(headers.get("cache-control")).toContain("no-store");
    expect(headers.get("content-type")).toBe("text/event-stream");
  });

  it("defaults the content type when the backend omits it", () => {
    expect(buildStreamingClientHeaders(new Headers()).get("content-type")).toBe(
      "text/event-stream",
    );
  });
});
