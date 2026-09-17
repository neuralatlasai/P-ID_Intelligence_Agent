"use client";

import Link from "next/link";

import { IconButton } from "@/components/ui/IconButton";
import {
  CheckIcon,
  CopyIcon,
  MenuIcon,
  PanelRightIcon,
  ProductMark,
  TrashIcon,
} from "@/components/ui/icons";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";

import styles from "./ProductHeader.module.css";

export interface ProductHeaderProps {
  readonly productName: string;
  /** Human-readable local title derived from the first question, never an invented name. */
  readonly sessionTitle: string;
  /** The conversation this header acts on, for the copy and clear controls. */
  readonly sessionId: string;
  readonly onClearSession: () => void;
  readonly clearDisabled: boolean;
  readonly onToggleSidebar: () => void;
  readonly sidebarOpen: boolean;
  readonly onToggleRail: () => void;
  readonly railOpen: boolean;
  readonly railAvailable: boolean;
}

/**
 * The product header.
 *
 * Identity on the left, the controls that act on this conversation on the right, and
 * nothing else: no hero area, no marketing, no running commentary on the runtime. A header
 * that reports the framework it is built on and whether its own backend answered a health
 * probe is describing the implementation to someone who came to read a drawing.
 *
 * The copy and clear controls live here because the row that used to hold them is gone;
 * losing them with it would have cost real function to save a line of prose.
 */
export function ProductHeader({
  productName,
  sessionTitle,
  sessionId,
  onClearSession,
  clearDisabled,
  onToggleSidebar,
  sidebarOpen,
  onToggleRail,
  railOpen,
  railAvailable,
}: ProductHeaderProps) {
  const { state: copyState, copy } = useCopyToClipboard();

  return (
    <header className={styles.header}>
      <IconButton
        className={styles.sidebarToggle}
        label={sidebarOpen ? "Hide sessions" : "Show sessions"}
        icon={<MenuIcon />}
        pressed={sidebarOpen}
        onClick={onToggleSidebar}
      />

      <div className={styles.identity}>
        <ProductMark />
        <span className={styles.identityText}>
          <span className={styles.name}>{productName}</span>
          <span className={styles.separator} aria-hidden="true">
            /
          </span>
          <span className={styles.sessionTitle} title={sessionTitle}>
            {sessionTitle}
          </span>
        </span>
      </div>

      <div className={styles.right}>
        <Link href="/canvas">Industrial Canvas</Link>
        <IconButton
          label="Copy full session ID"
          icon={copyState === "copied" ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
          onClick={() => void copy(sessionId)}
        />
        <IconButton
          label="Clear this session's history"
          icon={<TrashIcon size={15} />}
          onClick={onClearSession}
          disabled={clearDisabled}
        />
        {railAvailable ? (
          <IconButton
            label={railOpen ? "Hide evidence panel" : "Show evidence panel"}
            icon={<PanelRightIcon />}
            pressed={railOpen}
            onClick={onToggleRail}
            bordered
          />
        ) : null}
      </div>
    </header>
  );
}
