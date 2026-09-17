import { formatClock } from "@/lib/telemetry/timings";

import styles from "./UserTurn.module.css";

export interface UserTurnProps {
  readonly text: string;
  readonly at?: number | null;
}

/**
 * A question as the user typed it.
 *
 * Rendered as plain text with preserved line breaks. User input is never passed through
 * the Markdown renderer: there is no reason for a question to contain formatting, and
 * interpreting it would mean an engineer's tag such as `__P-101__` silently changes
 * appearance — or worse, that a pasted string becomes markup.
 */
export function UserTurn({ text, at }: UserTurnProps) {
  return (
    <article className={styles.row} aria-label="Your question">
      <div className={styles.avatar} aria-hidden="true">
        You
      </div>
      <div className={styles.body}>
        <p className={styles.bubble}>{text}</p>
        {at ? (
          <div className={[styles.meta, "metaText"].join(" ")}>
            <time dateTime={new Date(at).toISOString()}>{formatClock(at)}</time>
          </div>
        ) : null}
      </div>
    </article>
  );
}
