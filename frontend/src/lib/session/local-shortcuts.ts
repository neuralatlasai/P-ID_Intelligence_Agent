/**
 * Browser-local list of recently visited sessions.
 *
 * The backend exposes no session-list endpoint, so this list exists purely so a user can
 * get back to a conversation they had a moment ago. It is convenience state and nothing
 * more: it is not the conversation store, it is not synchronised, and it cannot be
 * complete — a session opened in another browser is not in it.
 *
 * The UI therefore labels it as local rather than presenting it as "your sessions". That
 * honesty matters: a list that silently omits half a user's work is worse than a list that
 * says what it covers.
 *
 * Every access is wrapped. `localStorage` throws in a private window, when site data is
 * blocked, and when the quota is exhausted, and none of those should break the application.
 */

import { isValidSessionId } from "@/lib/session/ids";

/** One remembered session. */
export interface SessionShortcut {
  readonly id: string;
  /** Locally generated label, usually the first question asked. Never authoritative. */
  readonly label: string;
  /** Epoch milliseconds of the last local visit. */
  readonly lastOpenedAt: number;
}

const STORAGE_KEY = "pid.recentSessions";
const LAST_SESSION_KEY = "pid.lastSessionId";

/** Bound on the list, so storage cannot grow without limit. */
export const MAX_SHORTCUTS = 20;

/** Bound on a label, so one long question cannot dominate the quota. */
const MAX_LABEL_LENGTH = 80;

/** Read the list, newest first. Returns an empty list when storage is unusable. */
export function readShortcuts(): SessionShortcut[] {
  const raw = safeRead(STORAGE_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter(isShortcut)
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
      .slice(0, MAX_SHORTCUTS);
  } catch {
    // Corrupt storage is treated as empty rather than repaired. The data is disposable,
    // and guessing at a repair risks presenting a wrong session as a real one.
    return [];
  }
}

/**
 * Record a visit, creating the entry if it is new.
 *
 * An existing entry keeps its label unless a new one is supplied, so the first question
 * asked stays as the title even after later turns.
 */
export function rememberSession(sessionId: string, label?: string): SessionShortcut[] {
  if (!isValidSessionId(sessionId)) {
    return readShortcuts();
  }

  const existing = readShortcuts();
  const previous = existing.find((entry) => entry.id === sessionId);
  const next: SessionShortcut = {
    id: sessionId,
    label: normaliseLabel(label ?? previous?.label ?? ""),
    lastOpenedAt: Date.now(),
  };

  const merged = [next, ...existing.filter((entry) => entry.id !== sessionId)].slice(
    0,
    MAX_SHORTCUTS,
  );

  safeWrite(STORAGE_KEY, JSON.stringify(merged));
  safeWrite(LAST_SESSION_KEY, sessionId);
  return merged;
}

/** Remove one entry. The backend session itself is untouched. */
export function forgetSession(sessionId: string): SessionShortcut[] {
  const remaining = readShortcuts().filter((entry) => entry.id !== sessionId);
  safeWrite(STORAGE_KEY, JSON.stringify(remaining));
  return remaining;
}

/** Remove every entry. Again, no backend session is deleted. */
export function clearShortcuts(): void {
  safeWrite(STORAGE_KEY, JSON.stringify([]));
}

/** The most recently opened session, if one is remembered and still well formed. */
export function readLastSessionId(): string | null {
  const value = safeRead(LAST_SESSION_KEY);
  return value && isValidSessionId(value) ? value : null;
}

/** Relative-time buckets matching the reference product's session grouping. */
export type ShortcutBucket = "Today" | "Yesterday" | "Last 7 days" | "Older";

/**
 * Group shortcuts into the reference product's date buckets.
 *
 * Buckets are computed from local calendar days rather than fixed 24-hour windows, so a
 * session from 23:50 last night appears under "Yesterday" rather than "Today".
 */
export function groupShortcuts(
  shortcuts: readonly SessionShortcut[],
  now: number = Date.now(),
): ReadonlyArray<{ readonly bucket: ShortcutBucket; readonly items: SessionShortcut[] }> {
  const buckets: Record<ShortcutBucket, SessionShortcut[]> = {
    Today: [],
    Yesterday: [],
    "Last 7 days": [],
    Older: [],
  };

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();
  const yesterdayMs = todayMs - 86_400_000;
  const weekMs = todayMs - 6 * 86_400_000;

  for (const shortcut of shortcuts) {
    if (shortcut.lastOpenedAt >= todayMs) {
      buckets.Today.push(shortcut);
    } else if (shortcut.lastOpenedAt >= yesterdayMs) {
      buckets.Yesterday.push(shortcut);
    } else if (shortcut.lastOpenedAt >= weekMs) {
      buckets["Last 7 days"].push(shortcut);
    } else {
      buckets.Older.push(shortcut);
    }
  }

  return (["Today", "Yesterday", "Last 7 days", "Older"] as const)
    .map((bucket) => ({ bucket, items: buckets[bucket] }))
    .filter((group) => group.items.length > 0);
}

function normaliseLabel(label: string): string {
  const cleaned = label.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "Untitled session";
  }
  return cleaned.length > MAX_LABEL_LENGTH
    ? `${cleaned.slice(0, MAX_LABEL_LENGTH - 1)}…`
    : cleaned;
}

function isShortcut(value: unknown): value is SessionShortcut {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry["id"] === "string" &&
    isValidSessionId(entry["id"]) &&
    typeof entry["label"] === "string" &&
    typeof entry["lastOpenedAt"] === "number" &&
    Number.isFinite(entry["lastOpenedAt"])
  );
}

function safeRead(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeWrite(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Storage unavailable or full. The session in the URL still works, which is the only
    // thing that has to keep working.
  }
}
