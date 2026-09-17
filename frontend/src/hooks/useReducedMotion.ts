"use client";

import { useSyncExternalStore } from "react";

/**
 * Track the user's reduced-motion preference.
 *
 * Most motion is suppressed in CSS, which is the right layer for it. This hook covers what
 * CSS cannot reach: choosing `auto` over `smooth` for a programmatic scroll, and skipping
 * an animated indicator entirely rather than animating it with a zero duration.
 *
 * A media query is an external store, so it is read through `useSyncExternalStore` rather
 * than mirrored into component state by an effect. That avoids the extra render an effect
 * would cause and removes any window in which the component has rendered with a stale
 * preference.
 */
const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }
  const query = window.matchMedia(QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(QUERY).matches;
}

/** On the server there is no preference to read, so motion is assumed to be allowed. */
function getServerSnapshot(): boolean {
  return false;
}

export function useReducedMotion(): boolean {
  // `subscribe` is defined at module scope and is therefore already referentially
  // stable; wrapping it in useCallback would add a hook without adding stability.
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
