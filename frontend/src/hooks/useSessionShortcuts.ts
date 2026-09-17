"use client";

import { useCallback, useSyncExternalStore } from "react";

import {
  clearShortcuts as clearStored,
  forgetSession as forgetStored,
  readShortcuts,
  rememberSession as rememberStored,
  type SessionShortcut,
} from "@/lib/session/local-shortcuts";

/**
 * React binding for the browser-local session list.
 *
 * `localStorage` is an external store, so it is read through `useSyncExternalStore` rather
 * than copied into component state by an effect. Every mutation writes to storage and then
 * notifies subscribers, which keeps one source of truth and means two components showing
 * the list can never disagree.
 *
 * The snapshot is cached because `useSyncExternalStore` requires a referentially stable
 * value between notifications: returning a freshly parsed array on every call would make
 * React believe the store changed on every render and loop.
 */

type Listener = () => void;

const listeners = new Set<Listener>();
let snapshot: readonly SessionShortcut[] = [];
let initialised = false;

const EMPTY: readonly SessionShortcut[] = [];

function subscribe(listener: Listener): () => void {
  listeners.add(listener);

  // Another tab writing the list should update this one; storage events fire only in
  // other documents, which is exactly the case we cannot otherwise observe.
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === "pid.recentSessions") {
      refresh();
    }
  };
  window.addEventListener("storage", onStorage);

  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function refresh(): void {
  snapshot = readShortcuts();
  initialised = true;
  emit();
}

function getSnapshot(): readonly SessionShortcut[] {
  if (!initialised) {
    // Read once, lazily, on the first client snapshot. Subsequent calls return the cached
    // array until a mutation replaces it.
    snapshot = readShortcuts();
    initialised = true;
  }
  return snapshot;
}

function getServerSnapshot(): readonly SessionShortcut[] {
  return EMPTY;
}

export interface UseSessionShortcutsResult {
  readonly shortcuts: readonly SessionShortcut[];
  /** Record a visit, optionally labelling it. Safe to call repeatedly. */
  readonly remember: (sessionId: string, label?: string) => void;
  readonly forget: (sessionId: string) => void;
  readonly clear: () => void;
}

export function useSessionShortcuts(): UseSessionShortcutsResult {
  const shortcuts = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const remember = useCallback((sessionId: string, label?: string) => {
    const next = rememberStored(sessionId, label);
    // Notify only when the stored list actually changed. Recording a visit to the session
    // already at the head with the same label changes nothing, and emitting anyway would
    // re-render every subscriber on each history refresh.
    if (!sameList(next, snapshot)) {
      snapshot = next;
      initialised = true;
      emit();
    }
  }, []);

  const forget = useCallback((sessionId: string) => {
    snapshot = forgetStored(sessionId);
    initialised = true;
    emit();
  }, []);

  const clear = useCallback(() => {
    clearStored();
    snapshot = EMPTY;
    initialised = true;
    emit();
  }, []);

  return { shortcuts, remember, forget, clear };
}

/** Compare two lists by identity and label; timestamps alone are not worth a re-render. */
function sameList(a: readonly SessionShortcut[], b: readonly SessionShortcut[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((entry, index) => {
    const other = b[index];
    return other !== undefined && entry.id === other.id && entry.label === other.label;
  });
}

/** Test seam: reset the module-level cache between tests. */
export function __resetShortcutStore(): void {
  snapshot = EMPTY;
  initialised = false;
  listeners.clear();
}
