"use client";

import { useId, type ReactNode } from "react";

import { ChevronRightIcon } from "@/components/ui/icons";

import styles from "./Disclosure.module.css";

export interface DisclosureProps {
  readonly title: string;
  readonly count?: string | number;
  readonly open: boolean;
  readonly onToggle: (open: boolean) => void;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly children: ReactNode;
}

/**
 * A controlled expand/collapse panel.
 *
 * Built from a button and a region rather than `details`/`summary` so the open state can be
 * driven from outside — the activity panel opens itself while a run is active and collapses
 * when it finishes, which a native disclosure cannot express.
 *
 * The panel is unmounted when closed rather than hidden, so its contents leave the tab
 * order instead of becoming invisible focus targets.
 */
export function Disclosure({
  title,
  count,
  open,
  onToggle,
  leading,
  trailing,
  children,
}: DisclosureProps) {
  const panelId = useId();
  const buttonId = useId();

  return (
    <div className={styles.wrapper}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <button
          type="button"
          id={buttonId}
          className={styles.summary}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => onToggle(!open)}
        >
          {leading}
          <span>{title}</span>
          {count === undefined ? null : <span className={styles.count}>{count}</span>}
          <ChevronRightIcon
            className={[styles.chevron, open ? styles.chevronOpen : ""]
              .filter(Boolean)
              .join(" ")}
          />
        </button>
        {trailing}
      </div>
      {open ? (
        <div id={panelId} role="region" aria-labelledby={buttonId} className={styles.panel}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
