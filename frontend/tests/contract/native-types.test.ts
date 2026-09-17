import fsSync from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import pathModule from "node:path";

import { describe, expect, it } from "vitest";

import {
  isResponseInputItem,
  isResponseOutputItem,
  isResponseStreamEvent,
} from "@/lib/responses/native-types";

/**
 * The model-plane contract.
 *
 * These are structural tests. They fail the build when someone reintroduces a domain wire
 * schema, hand-declares the protocol, or imports the OpenAI package outside the single
 * boundary that re-exports it — regardless of whether any behavioural test still passes.
 *
 * The point of asserting this in code rather than in review is that the violation is easy
 * to introduce accidentally and expensive to unwind later.
 */

// Resolved from the working directory: vitest runs with the project root as cwd, and
// `import.meta.url` is not guaranteed to be a file URL under the test transform.
const SRC = pathModule.resolve(process.cwd(), "src");
const PROTOCOL_BOUNDARY = pathModule.join(SRC, "lib", "responses", "native-types.ts");

async function sourceFiles(): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = pathModule.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        found.push(full);
      }
    }
  }
  await walk(SRC);
  return found;
}

async function readAll(): Promise<Array<{ file: string; text: string }>> {
  const files = await sourceFiles();
  return Promise.all(
    files.map(async (file) => ({ file, text: await readFile(file, "utf8") })),
  );
}

describe("no domain wire schema", () => {
  it("declares no P&ID request or response type", async () => {
    const forbidden = [
      "PIDRequest",
      "PIDResponse",
      "PIDAnswer",
      "PIDQuery",
      "UserQueryRequest",
      "EvidenceResponse",
      "EvidenceEnvelope",
      "TopologyResponse",
      "AnswerEnvelope",
    ];
    const offenders: string[] = [];
    for (const { file, text } of await readAll()) {
      for (const name of forbidden) {
        if (new RegExp(`(interface|type|class)\\s+${name}\\b`).test(text)) {
          offenders.push(`${pathModule.basename(file)}:${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("has no schemas directory", () => {
    expect(fsSync.existsSync(pathModule.join(SRC, "schemas"))).toBe(false);
  });
});

describe("one protocol boundary", () => {
  it("imports the OpenAI package in exactly one module", async () => {
    const importers = (await readAll())
      .filter(({ text }) => /from\s+["']openai(\/[^"']*)?["']/.test(text))
      .map(({ file }) => file);
    expect(importers).toEqual([PROTOCOL_BOUNDARY]);
  });

  it("re-exports the protocol rather than re-declaring it", async () => {
    const text = await readFile(PROTOCOL_BOUNDARY, "utf8");
    expect(text).toMatch(/export type \{/);
    // A hand-written union is how protocol drift becomes a silent runtime mismatch.
    expect(text).not.toMatch(/export type ResponseStreamEvent\s*=/);
    expect(text).not.toMatch(/export type ResponseOutputItem\s*=/);
  });
});

describe("no second backend", () => {
  it("never calls the OpenAI API", async () => {
    const offenders = (await readAll()).filter(
      ({ text }) =>
        text.includes("api.openai.com") ||
        /new\s+OpenAI\s*\(/.test(text) ||
        text.includes("OPENAI_API_KEY"),
    );
    expect(offenders.map((entry) => pathModule.basename(entry.file))).toEqual([]);
  });

  it("never touches a database or the corpus filesystem", async () => {
    const offenders: string[] = [];
    for (const { file, text } of await readAll()) {
      if (/\b(sqlite|better-sqlite3|CORPUS_ROOT)\b/.test(text)) {
        offenders.push(pathModule.basename(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the backend URL server-side", async () => {
    const readers = (await readAll())
      .filter(({ text }) => text.includes("BACKEND_BASE_URL"))
      .map(({ file }) => pathModule.relative(SRC, file).replace(/\\/g, "/"));
    // Only the gateway may read it, and the gateway is marked server-only.
    expect(readers).toEqual(["lib/backend/proxy.ts"]);

    const proxy = await readFile(
      pathModule.join(SRC, "lib", "backend", "proxy.ts"),
      "utf8",
    );
    expect(proxy).toContain('import "server-only"');
  });

  it("never exposes the backend URL through a public environment variable", async () => {
    for (const { text } of await readAll()) {
      expect(text).not.toMatch(/NEXT_PUBLIC_[A-Z_]*BACKEND/);
    }
  });
});

describe("browser transport", () => {
  it("calls only same-origin gateway routes", async () => {
    const offenders: string[] = [];
    for (const { file, text } of await readAll()) {
      const matches = text.match(/fetch\(\s*[`"'][^`"')]*/g) ?? [];
      for (const match of matches) {
        const target = match.replace(/fetch\(\s*[`"']/, "");
        // The gateway itself builds absolute upstream URLs; everything else must be
        // same-origin and relative.
        if (/^https?:/.test(target) && !file.endsWith("proxy.ts")) {
          offenders.push(`${pathModule.basename(file)}: ${target}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("does not use EventSource, which cannot send a request body", async () => {
    for (const { text } of await readAll()) {
      expect(text).not.toMatch(/new\s+EventSource\s*\(/);
    }
  });
});

describe("type guards", () => {
  it("accepts a native stream event", () => {
    expect(isResponseStreamEvent({ type: "response.completed" })).toBe(true);
  });

  it("rejects a payload with no type", () => {
    expect(isResponseStreamEvent({ delta: "x" })).toBe(false);
    expect(isResponseStreamEvent(null)).toBe(false);
    expect(isResponseStreamEvent("string")).toBe(false);
  });

  it("accepts a native output item", () => {
    expect(isResponseOutputItem({ type: "message", role: "assistant" })).toBe(true);
  });

  it("accepts both stored input item shapes", () => {
    // Session items arrive either as typed protocol objects or as plain role/content
    // messages, depending on how the turn was stored.
    expect(isResponseInputItem({ role: "user", content: "hi" })).toBe(true);
    expect(isResponseInputItem({ type: "function_call", name: "x" })).toBe(true);
    expect(isResponseInputItem("not an object")).toBe(false);
  });
});

describe("no fabricated confidence", () => {
  it("contains no numeric confidence anywhere in the UI", async () => {
    const offenders: string[] = [];
    for (const { file, text } of await readAll()) {
      // A percentage or a 0.xx figure next to the word confidence is the exact thing the
      // architecture forbids presenting as calibrated.
      if (/confidence[^\n]{0,40}(\d+\s*%|0\.\d)/i.test(text)) {
        offenders.push(pathModule.basename(file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
