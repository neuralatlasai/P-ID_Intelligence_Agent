"use client";

import { useCallback, useEffect, useId, useRef, type ReactNode } from "react";

import styles from "./Dialog.module.css";

export interface DialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly actions?: ReactNode;
}

/** Elements that can hold focus, used to find the trap boundaries. */
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog.
 *
 * Three behaviours make a modal usable from the keyboard, and all three are implemented
 * here rather than assumed: focus moves into the dialog on open, Tab cycles within it
 * instead of escaping to the page behind, and closing returns focus to whatever opened it.
 * Escape closes.
 *
 * Built directly rather than pulled from a component library: the application needs one
 * dialog, and a focus trap is a well-understood piece of code that is smaller than the
 * dependency that would supply it.
 */
export function Dialog({ open, title, onClose, children, actions }: DialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!focusable || focusable.length === 0) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        return;
      }

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    restoreRef.current = document.activeElement as HTMLElement | null;
    const focusable = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (focusable ?? dialogRef.current)?.focus();

    return () => {
      // Returning focus is what stops a keyboard user being dumped at the top of the page
      // every time they dismiss a dialog.
      restoreRef.current?.focus?.();
    };
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div
      className={styles.scrim}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={styles.dialog}
        onKeyDown={handleKeyDown}
      >
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <div className={styles.body}>{children}</div>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
    </div>
  );
}
