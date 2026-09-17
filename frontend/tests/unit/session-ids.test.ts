import { describe, expect, it } from "vitest";

import {
  InvalidSessionIdError,
  SESSION_ID_PATTERN,
  assertSessionId,
  createSessionId,
  isValidSessionId,
  shortenSessionId,
} from "@/lib/session/ids";

/**
 * Session identifier policy.
 *
 * The identifier travels from the URL through a Node route handler into a backend URL path,
 * so the hostile cases matter: a path separator, a traversal token, a control character or
 * a quote must all be refused before anything is sent.
 *
 * The accepted shape mirrors the backend's own policy exactly. These tests are what keep
 * the two in step.
 */

describe("isValidSessionId", () => {
  it.each([
    "a",
    "session-1",
    "user.42_demo",
    "9cb5548a-3a84-4c89-8354-d5b2c7fe2151",
    "A".repeat(128),
  ])("accepts %s", (value) => {
    expect(isValidSessionId(value)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["whitespace", " "],
    ["path traversal", "../escape"],
    ["forward slash", "a/b"],
    ["backslash", "a\\b"],
    ["internal space", "a b"],
    ["too long", "a".repeat(129)],
    ["leading hyphen", "-leading"],
    ["leading dot", ".hidden"],
    ["single quote", "quote'id"],
    ["sql fragment", "'; DROP TABLE agent_messages; --"],
    ["percent encoding", "%2e%2e"],
    ["null byte", "session\u0000id"],
    ["newline", "session\nid"],
  ])("rejects %s", (_label, value) => {
    expect(isValidSessionId(value)).toBe(false);
  });

  it("rejects values that are not strings", () => {
    expect(isValidSessionId(undefined)).toBe(false);
    expect(isValidSessionId(42)).toBe(false);
    expect(isValidSessionId({})).toBe(false);
  });
});

describe("assertSessionId", () => {
  it("returns an acceptable identifier unchanged", () => {
    expect(assertSessionId("demo-1")).toBe("demo-1");
  });

  it("throws a named error for an unacceptable identifier", () => {
    expect(() => assertSessionId("../x")).toThrow(InvalidSessionIdError);
  });
});

describe("createSessionId", () => {
  it("generates identifiers that satisfy the accepted shape", () => {
    for (let index = 0; index < 50; index += 1) {
      expect(SESSION_ID_PATTERN.test(createSessionId())).toBe(true);
    }
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 200 }, () => createSessionId()));
    expect(seen.size).toBe(200);
  });
});

describe("shortenSessionId", () => {
  it("keeps both ends so two sessions stay distinguishable", () => {
    const shortened = shortenSessionId("9cb5548a-3a84-4c89-8354-d5b2c7fe2151");
    expect(shortened.startsWith("9cb554")).toBe(true);
    expect(shortened.endsWith("2151")).toBe(true);
  });

  it("returns a short identifier unchanged", () => {
    expect(shortenSessionId("demo")).toBe("demo");
  });
});
