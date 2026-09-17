"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Copy text to the clipboard and report the outcome briefly.
 *
 * The Clipboard API is unavailable in insecure contexts and can be denied by permission,
 * so failure is a normal outcome rather than an exception. It is reported as a `failed`
 * state the caller can render, because a copy button that silently does nothing leaves the
 * user believing they have the text.
 */
export type CopyState = "idle" | "copied" | "failed";

export function useCopyToClipboard(resetAfterMs = 1800): {
  readonly state: CopyState;
  readonly copy: (value: string) => Promise<void>;
} {
  const [state, setState] = useState<CopyState>("idle");
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    },
    [],
  );

  const copy = useCallback(
    async (value: string): Promise<void> => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
      try {
        await navigator.clipboard.writeText(value);
        setState("copied");
      } catch {
        setState("failed");
      }
      timerRef.current = window.setTimeout(() => setState("idle"), resetAfterMs);
    },
    [resetAfterMs],
  );

  return { state, copy };
}
