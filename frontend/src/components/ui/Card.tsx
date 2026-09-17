import type { ReactNode } from "react";

import styles from "./Card.module.css";

export interface CardProps {
  readonly title: string;
  readonly icon?: ReactNode;
  /** Small trailing count, such as the number of rows the card holds. */
  readonly count?: string | number;
  readonly children: ReactNode;
  readonly className?: string;
}

/**
 * A titled panel in the evidence rail or the details stack.
 *
 * The heading is a real heading element, so the rail forms a navigable outline for a
 * screen reader rather than a flat run of divs.
 */
export function Card({ title, icon, count, children, className }: CardProps) {
  return (
    <section className={[styles.card, className].filter(Boolean).join(" ")}>
      <div className={styles.header}>
        {icon}
        <h3 className={styles.title}>{title}</h3>
        {count === undefined ? null : <span className={styles.count}>{count}</span>}
      </div>
      <div className={styles.body}>{children}</div>
    </section>
  );
}
