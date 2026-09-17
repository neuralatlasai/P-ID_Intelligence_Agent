import { describe, expect, it } from "vitest";

import {
  EMPTY_TIMINGS,
  elapsedMs,
  formatClock,
  formatDuration,
  timeToFirstTextMs,
} from "@/lib/telemetry/timings";

/**
 * Turn timing.
 *
 * Everything measured is browser-side perceived duration. The tests fix the contract that
 * it is labelled and computed as such, and never presented as a model metric.
 */

describe("elapsedMs", () => {
  it("is unknown before submission", () => {
    expect(elapsedMs(EMPTY_TIMINGS)).toBeNull();
  });

  it("measures from submit to completion", () => {
    expect(elapsedMs({ ...EMPTY_TIMINGS, submittedAt: 1_000, completedAt: 4_200 })).toBe(
      3_200,
    );
  });

  it("measures against now while still running", () => {
    expect(elapsedMs({ ...EMPTY_TIMINGS, submittedAt: 1_000 }, 2_500)).toBe(1_500);
  });

  it("never reports a negative duration from clock skew", () => {
    expect(elapsedMs({ ...EMPTY_TIMINGS, submittedAt: 5_000, completedAt: 4_000 })).toBe(0);
  });
});

describe("timeToFirstTextMs", () => {
  it("is unknown until visible text arrives", () => {
    expect(timeToFirstTextMs({ ...EMPTY_TIMINGS, submittedAt: 1_000 })).toBeNull();
  });

  it("measures from submit to the first visible text", () => {
    expect(
      timeToFirstTextMs({ ...EMPTY_TIMINGS, submittedAt: 1_000, firstTextAt: 1_800 }),
    ).toBe(800);
  });
});

describe("formatDuration", () => {
  it.each([
    [320, "0.3 s"],
    [3_200, "3.2 s"],
    [59_400, "59.4 s"],
    [90_000, "1 min 30 s"],
  ])("formats %ims as %s", (input, expected) => {
    expect(formatDuration(input)).toBe(expected);
  });
});

describe("formatClock", () => {
  it("renders a wall-clock time", () => {
    expect(formatClock(Date.UTC(2026, 0, 1, 12, 30))).toMatch(/\d{1,2}[:.]\d{2}/);
  });
});
