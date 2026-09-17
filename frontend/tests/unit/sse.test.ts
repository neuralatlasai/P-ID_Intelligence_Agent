import { describe, expect, it, vi } from "vitest";

import type { DecodedFrame } from "@/lib/responses/native-types";
import { consumeEventStream, decodeEventStreamText } from "@/lib/responses/sse";

/**
 * Server-Sent Events parsing.
 *
 * The important cases here are all about chunk boundaries. Network chunks have no relation
 * to event boundaries, so the parser is fed the same document split in pathological ways —
 * inside a `data:` prefix, inside a JSON token, between CR and LF, and inside a multi-byte
 * UTF-8 character — and must produce an identical frame sequence every time.
 *
 * These are the failures that only appear under real network conditions, so they are
 * provoked deliberately rather than waited for.
 */

const DOCUMENT = [
  "event: event",
  'data: {"type":"response.created","sequence_number":0}',
  "",
  "event: event",
  'data: {"type":"response.output_text.delta","delta":"Hello","item_id":"m1"}',
  "",
  "event: event",
  'data: {"type":"response.output_text.delta","delta":" wörld","item_id":"m1"}',
  "",
  "event: event",
  'data: {"type":"response.completed","sequence_number":9}',
  "",
  "event: done",
  'data: {"request_id":"req_abc"}',
  "",
  "",
].join("\n");

/** Feed a document to the parser in chunks of an exact byte width. */
async function collectFromChunks(
  text: string,
  chunkBytes: number,
): Promise<DecodedFrame[]> {
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
        controller.enqueue(bytes.slice(offset, offset + chunkBytes));
      }
      controller.close();
    },
  });

  const frames: DecodedFrame[] = [];
  await consumeEventStream(stream, (frame) => frames.push(frame));
  return frames;
}

function textOf(frames: readonly DecodedFrame[]): string {
  return frames
    .filter((frame) => frame.kind === "event")
    .map((frame) =>
      frame.kind === "event" && frame.event.type === "response.output_text.delta"
        ? ((frame.event as { delta?: string }).delta ?? "")
        : "",
    )
    .join("");
}

describe("decodeEventStreamText", () => {
  it("decodes every frame in a well-formed document", () => {
    const frames = decodeEventStreamText(DOCUMENT);
    expect(frames.map((frame) => frame.kind)).toEqual([
      "event",
      "event",
      "event",
      "event",
      "done",
    ]);
  });

  it("carries the native event payload through unchanged", () => {
    const frames = decodeEventStreamText(DOCUMENT);
    const first = frames[0];
    expect(first?.kind).toBe("event");
    if (first?.kind === "event") {
      expect(first.event.type).toBe("response.created");
    }
  });

  it("reads the request id from the terminal done frame", () => {
    const frames = decodeEventStreamText(DOCUMENT);
    const last = frames.at(-1);
    expect(last?.kind).toBe("done");
    if (last?.kind === "done") {
      expect(last.payload.request_id).toBe("req_abc");
    }
  });
});

describe("chunk boundaries", () => {
  const reference = decodeEventStreamText(DOCUMENT);

  // One byte at a time is the worst case: every boundary lands mid-token, mid-prefix and
  // mid-character. If this passes, no realistic chunking can break the parser.
  it.each([1, 2, 3, 5, 7, 13, 31, 64, 4096])(
    "produces an identical frame sequence at %i-byte chunks",
    async (size) => {
      const frames = await collectFromChunks(DOCUMENT, size);
      expect(frames.map((frame) => frame.kind)).toEqual(reference.map((f) => f.kind));
      expect(textOf(frames)).toBe("Hello wörld");
    },
  );

  it("reassembles a multi-byte character split across chunks", async () => {
    // "ö" is two bytes in UTF-8. A one-byte chunking splits it, and a decoder without
    // streaming state would emit two replacement characters.
    const frames = await collectFromChunks(DOCUMENT, 1);
    expect(textOf(frames)).toContain("wörld");
    expect(textOf(frames)).not.toContain("�");
  });

  it("handles CRLF line endings", () => {
    const frames = decodeEventStreamText(DOCUMENT.replace(/\n/g, "\r\n"));
    expect(frames.map((frame) => frame.kind)).toEqual(reference.map((f) => f.kind));
  });

  it("handles a document with no trailing blank line", async () => {
    const trimmed = DOCUMENT.trimEnd();
    const frames = await collectFromChunks(`${trimmed}\n\n`, 9);
    expect(frames.at(-1)?.kind).toBe("done");
  });
});

describe("malformed and unknown input", () => {
  it("keeps a frame whose payload is not JSON, rather than throwing", () => {
    const frames = decodeEventStreamText("event: event\ndata: {not json\n\n");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.kind).toBe("unknown");
  });

  it("keeps a frame with an unrecognised event name", () => {
    const frames = decodeEventStreamText('event: telemetry\ndata: {"a":1}\n\n');
    expect(frames[0]?.kind).toBe("unknown");
  });

  it("treats a payload without a type as unknown rather than an event", () => {
    const frames = decodeEventStreamText('event: event\ndata: {"no_type":true}\n\n');
    expect(frames[0]?.kind).toBe("unknown");
  });

  it("ignores comment and keepalive lines", () => {
    const frames = decodeEventStreamText(
      ': keepalive\n\nevent: event\ndata: {"type":"response.completed"}\n\n',
    );
    expect(frames.map((frame) => frame.kind)).toEqual(["event"]);
  });

  it("joins multiple data lines in one frame", () => {
    const frames = decodeEventStreamText(
      'event: event\ndata: {"type":\ndata: "response.completed"}\n\n',
    );
    expect(frames[0]?.kind).toBe("event");
  });

  it("treats an unnamed frame as an event, for SSE default-name compatibility", () => {
    const frames = decodeEventStreamText('data: {"type":"response.completed"}\n\n');
    expect(frames[0]?.kind).toBe("event");
  });
});

describe("cancellation", () => {
  it("rejects with an AbortError and cancels the body", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();

    const stream = new ReadableStream<Uint8Array>({
      pull(streamController) {
        streamController.enqueue(new TextEncoder().encode("event: event\n"));
        controller.abort();
      },
      cancel,
    });

    await expect(
      consumeEventStream(stream, () => undefined, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalled();
  });

  it("does not invoke the handler after the signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const onFrame = vi.fn();

    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(
          new TextEncoder().encode('event: event\ndata: {"type":"response.completed"}\n\n'),
        );
        streamController.close();
      },
    });

    await expect(
      consumeEventStream(stream, onFrame, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
