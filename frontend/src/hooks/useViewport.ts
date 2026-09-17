"use client";

import { useSyncExternalStore } from "react";

/**
 * Viewport width, for layout decisions JavaScript has to make.
 *
 * Most responsive behaviour belongs in CSS and is implemented there. This hook exists only
 * for the decisions that change *what is rendered* rather than how it looks — specifically
 * whether the evidence cards render in the rail column or inline beneath the answer.
 *
 * That distinction matters: rendering both and hiding one with CSS would duplicate the
 * content in the accessibility tree, so a screen-reader user would hear every citation
 * twice.
 *
 * The window is an external store, so it is read through `useSyncExternalStore`. The
 * server snapshot is `0`, a width no breakpoint matches, which keeps the server and first
 * client render in agreement and defers the layout decision until the real width is known.
 */

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }
  window.addEventListener("resize", onChange);
  window.addEventListener("orientationchange", onChange);
  return () => {
    window.removeEventListener("resize", onChange);
    window.removeEventListener("orientationchange", onChange);
  };
}

function getSnapshot(): number {
  return typeof window === "undefined" ? 0 : window.innerWidth;
}

function getServerSnapshot(): number {
  return 0;
}

export function useViewportWidth(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
