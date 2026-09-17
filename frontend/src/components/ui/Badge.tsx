import type { ReactNode } from "react";

import styles from "./Badge.module.css";

export type BadgeTone =
  "neutral" | "observed" | "corroborated" | "inferred" | "conflicting" | "unknown";

export interface BadgeProps {
  readonly tone?: BadgeTone;
  readonly children: ReactNode;
}

/**
 * A small classification or status label.
 *
 * Tones map to the backend's evidence vocabulary. Colour is never the only signal: a badge
 * always carries its text, so the classification survives greyscale, colour vision
 * deficiency and a screen reader.
 */
export function Badge({ tone = "neutral", children }: BadgeProps) {
  return <span className={[styles.badge, styles[tone]].join(" ")}>{children}</span>;
}
