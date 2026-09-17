import { describe, expect, it } from "vitest";

import {
  buildRunError,
  isAbortError,
  normalizeError,
  parseRetryAfter,
  toRunError,
} from "@/lib/backend/errors";

/**
 * Transport error presentation.
 *
 * Two properties matter. The backend's own classification is preserved rather than
 * replaced, so a client can branch on a stable code. And `retryable` is honest: a retry
 * control appears only where retrying unchanged could actually succeed, because a button
 * that will fail again is worse than no button.
 */

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("toRunError", () => {
  it("preserves the backend's code, message and request id", async () => {
    const error = await toRunError(
      jsonResponse(429, {
        error: {
          code: "admission_limit",
          message: "the service is at its concurrency limit of 4 runs; retry shortly",
          request_id: "req_123",
        },
      }),
    );
    expect(error.code).toBe("admission_limit");
    expect(error.requestId).toBe("req_123");
    expect(error.detail).toContain("concurrency limit");
    expect(error.retryable).toBe(true);
  });

  it("falls back to the status when the body is unreadable", async () => {
    const error = await toRunError(new Response("not json", { status: 503 }));
    expect(error.code).toBe("upstream_unavailable");
    expect(error.status).toBe(503);
  });

  it("falls back to the status when the body has no error object", async () => {
    const error = await toRunError(jsonResponse(500, { detail: "oops" }));
    expect(error.code).toBe("internal_error");
  });

  it("maps an unrecognised backend code to the status fallback", async () => {
    const error = await toRunError(
      jsonResponse(504, { error: { code: "brand_new_code", message: "x" } }),
    );
    expect(error.code).toBe("run_deadline_exceeded");
  });

  it("reads the request id from the header when the body omits it", async () => {
    const error = await toRunError(
      jsonResponse(
        500,
        { error: { code: "internal_error", message: "x" } },
        {
          "x-request-id": "req_header",
        },
      ),
    );
    expect(error.requestId).toBe("req_header");
  });

  it("reads retry-after", async () => {
    const error = await toRunError(
      jsonResponse(
        429,
        { error: { code: "upstream_rate_limited", message: "x" } },
        {
          "retry-after": "12",
        },
      ),
    );
    expect(error.retryAfterSeconds).toBe(12);
  });
});

describe("retryability", () => {
  it.each([
    "admission_limit",
    "upstream_rate_limited",
    "run_deadline_exceeded",
    "gateway_unreachable",
  ])("offers a retry for %s", (code) => {
    expect(buildRunError(code as never).retryable).toBe(true);
  });

  it.each([
    "invalid_body",
    "invalid_session_id",
    "body_too_large",
    "upstream_request_rejected",
  ])("does not offer a retry for %s", (code) => {
    expect(buildRunError(code as never).retryable).toBe(false);
  });

  it("does not offer a retry when persistence failed", () => {
    // History durability is part of correctness. Retrying does not repair it, and the user
    // needs to know the turn was not saved.
    expect(buildRunError("session_persistence_failed").retryable).toBe(false);
  });
});

describe("messages", () => {
  it("never uses a generic apology", () => {
    const codes = [
      "invalid_body",
      "not_found",
      "admission_limit",
      "run_deadline_exceeded",
      "max_turns_exceeded",
      "upstream_unavailable",
      "session_persistence_failed",
      "gateway_unreachable",
      "cancelled",
    ] as const;
    for (const code of codes) {
      const error = buildRunError(code);
      expect(error.title.toLowerCase()).not.toContain("something went wrong");
      expect(error.detail.length).toBeGreaterThan(20);
    }
  });

  it("explains that a max-turns failure returns no partial answer", () => {
    expect(buildRunError("max_turns_exceeded").detail).toContain("No partial answer");
  });
});

describe("normalizeError", () => {
  it("treats an abort as a cancellation, not a failure", () => {
    const abort = new DOMException("aborted", "AbortError");
    expect(normalizeError(abort).code).toBe("cancelled");
    expect(isAbortError(abort)).toBe(true);
  });

  it("treats an unknown throw as an unreachable gateway", () => {
    expect(normalizeError(new TypeError("fetch failed")).code).toBe("gateway_unreachable");
  });

  it("passes an already-normalised error through", () => {
    const original = buildRunError("admission_limit");
    expect(normalizeError(original)).toBe(original);
  });
});

describe("parseRetryAfter", () => {
  it("reads a delay in seconds", () => {
    expect(parseRetryAfter("30")).toBe(30);
  });

  it("reads an HTTP date", () => {
    const future = new Date(Date.now() + 45_000).toUTCString();
    expect(parseRetryAfter(future)).toBeGreaterThan(30);
  });

  it("ignores a past date", () => {
    expect(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString())).toBeUndefined();
  });

  it("ignores an unparseable value", () => {
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});
