import { readFile, readdir } from "node:fs/promises";
import pathModule from "node:path";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AnswerRenderer } from "@/components/conversation/AnswerRenderer";
import { UserTurn } from "@/components/conversation/UserTurn";
import { assertSessionId, isValidSessionId } from "@/lib/session/ids";
import { safeHref } from "@/lib/security/sanitize";

/**
 * Security properties.
 *
 * Model output and user input are both untrusted here. The assertions cover the three ways
 * that matters: script must not execute, an unsafe URL must not become a link, and a
 * hostile session identifier must be refused before it reaches the network.
 */

// Resolved from the working directory: vitest runs with the project root as cwd, and
// `import.meta.url` is not guaranteed to be a file URL under the test transform.
const SRC = pathModule.resolve(process.cwd(), "src");

async function sourceText(): Promise<Array<{ file: string; text: string }>> {
  const found: Array<{ file: string; text: string }> = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = pathModule.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        found.push({ file: full, text: await readFile(full, "utf8") });
      }
    }
  }
  await walk(SRC);
  return found;
}

describe("model output cannot execute", () => {
  const payloads = [
    "<script>window.__pwned = 1</script>",
    '<img src=x onerror="window.__pwned = 1">',
    "<iframe src='https://evil.example.com'></iframe>",
    "<svg onload=alert(1)>",
    '<a href="javascript:alert(1)">click</a>',
    "<style>body{display:none}</style>",
  ];

  it.each(payloads)("renders %s inert", (payload) => {
    const { container } = render(<AnswerRenderer text={`Answer\n${payload}`} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("style")).toBeNull();
    expect((window as unknown as Record<string, unknown>)["__pwned"]).toBeUndefined();
  });

  it("never uses dangerouslySetInnerHTML", async () => {
    for (const { text } of await sourceText()) {
      expect(text).not.toContain("dangerouslySetInnerHTML");
    }
  });
});

describe("user input is not interpreted", () => {
  it("renders a question as text, not markdown", () => {
    // An engineering tag such as __P-101__ must not silently change appearance, and a
    // pasted string must never become markup.
    render(<UserTurn text="Check __P-101__ and <b>V-201</b>" />);
    expect(screen.getByText("Check __P-101__ and <b>V-201</b>")).toBeInTheDocument();
  });

  it("does not execute script in a question", () => {
    const { container } = render(<UserTurn text="<script>window.__pwned = 1</script>" />);
    expect(container.querySelector("script")).toBeNull();
    expect((window as unknown as Record<string, unknown>)["__pwned"]).toBeUndefined();
  });
});

describe("unsafe URLs", () => {
  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox",
    "//evil.example.com",
    "file:///etc/passwd",
  ])("refuses %s", (value) => {
    expect(safeHref(value)).toBeNull();
  });

  it("does not construct a URL from a corpus path", () => {
    // The backend serves no corpus files. A link built from a path would resolve against
    // the current route and point at nothing.
    expect(safeHref("area_100/PID-100.png")).toBeNull();
    expect(safeHref("PID2Graph OPEN100/0.graphml")).toBeNull();
  });
});

describe("session identifiers", () => {
  it.each([
    "../../etc/passwd",
    "..%2f..%2fetc",
    "a/b",
    "a\\b",
    "'; DROP TABLE agent_messages; --",
    "<script>",
    "session\u0000id",
    "x".repeat(500),
  ])("refuses %s", (hostile) => {
    expect(isValidSessionId(hostile)).toBe(false);
    expect(() => assertSessionId(hostile)).toThrow();
  });
});

describe("no secrets in the client", () => {
  it("contains no credential-shaped literal", async () => {
    for (const { file, text } of await sourceText()) {
      expect(text, file).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
      expect(text, file).not.toMatch(/api[_-]?key\s*[:=]\s*["'][^"']{12,}/i);
    }
  });

  it("defines no generic URL proxy", async () => {
    // A proxy that takes a target URL from the caller would let anyone reach any host the
    // server can reach.
    for (const { text } of await sourceText()) {
      expect(text).not.toMatch(/searchParams\.get\(\s*["']url["']/);
    }
  });
});

describe("no hidden reasoning is displayed", () => {
  it("excludes every reasoning event family from projection", async () => {
    const projector = await readFile(
      pathModule.join(SRC, "lib", "responses", "projector.ts"),
      "utf8",
    );
    for (const type of [
      "response.reasoning_text.delta",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_part.added",
    ]) {
      expect(projector).toContain(type);
    }
    expect(projector).toContain("HIDDEN_REASONING_EVENTS");
  });
});
