import { describe, expect, it } from "vitest";

import { externalLinkAttributes, safeHref, toSingleLine } from "@/lib/security/sanitize";

/**
 * URL safety for model-authored content.
 *
 * Markdown is rendered with raw HTML disabled, which stops tag injection. A link href is a
 * separate attack surface: it is attacker-controlled text that the browser will execute if
 * its scheme is `javascript:`. Everything here is about refusing that.
 */

describe("safeHref", () => {
  it.each([
    "https://example.com/spec",
    "http://example.com",
    "mailto:engineer@example.com",
    "#evidence",
    "/s/session-1",
    "./relative",
  ])("allows %s", (value) => {
    expect(safeHref(value)).toBe(value);
  });

  it.each([
    ["javascript scheme", "javascript:alert(1)"],
    ["uppercase javascript", "JavaScript:alert(1)"],
    ["data scheme", "data:text/html,<script>alert(1)</script>"],
    ["vbscript scheme", "vbscript:msgbox(1)"],
    ["file scheme", "file:///etc/passwd"],
    ["scheme relative", "//evil.example.com/x"],
    ["embedded newline", "java\nscript:alert(1)"],
    ["embedded tab", "java\tscript:alert(1)"],
    ["null byte", "javascript\u0000:alert(1)"],
    ["empty", ""],
    ["whitespace only", "   "],
  ])("rejects %s", (_label, value) => {
    expect(safeHref(value)).toBeNull();
  });

  it("rejects values that are not strings", () => {
    expect(safeHref(undefined)).toBeNull();
    expect(safeHref(42)).toBeNull();
  });

  it("does not turn a corpus path into a link", () => {
    // The backend serves no corpus files, so any URL built from a path would be a guess.
    expect(safeHref("area_100/PID-100.png")).toBeNull();
  });
});

describe("externalLinkAttributes", () => {
  it("opens an external link safely", () => {
    expect(externalLinkAttributes("https://example.com")).toEqual({
      target: "_blank",
      rel: "noopener noreferrer",
    });
  });

  it("leaves same-origin links alone", () => {
    expect(externalLinkAttributes("/s/x")).toEqual({});
    expect(externalLinkAttributes("#section")).toEqual({});
  });
});

describe("toSingleLine", () => {
  it("collapses whitespace", () => {
    expect(toSingleLine("a\n  b\t c")).toBe("a b c");
  });

  it("bounds the length with an ellipsis", () => {
    expect(toSingleLine("x".repeat(200), 10)).toHaveLength(10);
  });
});
