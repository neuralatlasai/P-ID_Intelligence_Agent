import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_SHORTCUTS,
  clearShortcuts,
  forgetSession,
  groupShortcuts,
  readLastSessionId,
  readShortcuts,
  rememberSession,
} from "@/lib/session/local-shortcuts";

/**
 * The browser-local session list.
 *
 * It is convenience state, so the behaviour that matters is that it is bounded, that it
 * never accepts a malformed identifier, and that it degrades silently when storage is
 * unavailable — a private window must not break the application.
 */

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("rememberSession", () => {
  it("records a visit", () => {
    rememberSession("alpha", "What is FCV-2201?");
    const [entry] = readShortcuts();
    expect(entry?.id).toBe("alpha");
    expect(entry?.label).toBe("What is FCV-2201?");
  });

  it("moves an existing session to the front", () => {
    rememberSession("alpha");
    rememberSession("beta");
    rememberSession("alpha");
    expect(readShortcuts().map((entry) => entry.id)).toEqual(["alpha", "beta"]);
  });

  it("keeps the original label when none is supplied", () => {
    rememberSession("alpha", "First question");
    rememberSession("alpha");
    expect(readShortcuts()[0]?.label).toBe("First question");
  });

  it("refuses a malformed identifier", () => {
    rememberSession("../escape", "hostile");
    expect(readShortcuts()).toEqual([]);
  });

  it("bounds the list", () => {
    for (let index = 0; index < MAX_SHORTCUTS + 10; index += 1) {
      rememberSession(`session-${index}`);
    }
    expect(readShortcuts()).toHaveLength(MAX_SHORTCUTS);
  });

  it("bounds a label so one long question cannot dominate storage", () => {
    rememberSession("alpha", "x".repeat(500));
    expect(readShortcuts()[0]?.label.length).toBeLessThanOrEqual(80);
  });

  it("records the last session separately", () => {
    rememberSession("alpha");
    expect(readLastSessionId()).toBe("alpha");
  });
});

describe("removal", () => {
  it("forgets one session", () => {
    rememberSession("alpha");
    rememberSession("beta");
    forgetSession("alpha");
    expect(readShortcuts().map((e) => e.id)).toEqual(["beta"]);
  });

  it("clears the whole list", () => {
    rememberSession("alpha");
    clearShortcuts();
    expect(readShortcuts()).toEqual([]);
  });
});

describe("resilience", () => {
  it("treats corrupt storage as empty rather than repairing it", () => {
    // The data is disposable, and guessing at a repair risks presenting a wrong session as
    // a real one.
    window.localStorage.setItem("pid.recentSessions", "{not json");
    expect(readShortcuts()).toEqual([]);
  });

  it("drops entries that do not match the stored shape", () => {
    window.localStorage.setItem(
      "pid.recentSessions",
      JSON.stringify([{ id: "ok", label: "x", lastOpenedAt: 1 }, { nope: true }, null]),
    );
    expect(readShortcuts().map((e) => e.id)).toEqual(["ok"]);
  });

  it("survives storage that throws on read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("access denied");
    });
    expect(readShortcuts()).toEqual([]);
  });

  it("survives storage that throws on write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    expect(() => rememberSession("alpha")).not.toThrow();
  });
});

describe("groupShortcuts", () => {
  const now = new Date("2026-09-15T12:00:00Z").getTime();
  const day = 86_400_000;

  it("buckets by calendar day, not by elapsed hours", () => {
    const groups = groupShortcuts(
      [
        { id: "a", label: "today", lastOpenedAt: now - 3_600_000 },
        { id: "b", label: "yesterday", lastOpenedAt: now - day },
        { id: "c", label: "this week", lastOpenedAt: now - 4 * day },
        { id: "d", label: "old", lastOpenedAt: now - 60 * day },
      ],
      now,
    );
    expect(groups.map((g) => g.bucket)).toEqual([
      "Today",
      "Yesterday",
      "Last 7 days",
      "Older",
    ]);
  });

  it("omits empty buckets", () => {
    const groups = groupShortcuts([{ id: "a", label: "x", lastOpenedAt: now }], now);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.bucket).toBe("Today");
  });

  it("returns nothing for an empty list", () => {
    expect(groupShortcuts([], now)).toEqual([]);
  });
});
