"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import {
  CloseIcon,
  HelpIcon,
  PlusIcon,
  SearchIcon,
  SessionIcon,
  SettingsIcon,
} from "@/components/ui/icons";
import { groupShortcuts, type SessionShortcut } from "@/lib/session/local-shortcuts";
import { shortenSessionId } from "@/lib/session/ids";

import styles from "./SessionSidebar.module.css";

export interface SessionSidebarProps {
  readonly activeSessionId: string;
  readonly shortcuts: readonly SessionShortcut[];
  readonly onNewSession: () => void;
  readonly onNavigate: () => void;
  readonly onOpenHelp: () => void;
  readonly onOpenSettings: () => void;
  readonly onCloseDrawer: () => void;
}

/**
 * The sessions list.
 *
 * The backend exposes no session-list endpoint, so this is a browser-local list of
 * sessions visited on this device. The footnote at the bottom says exactly that. A sidebar
 * that silently omitted work done in another browser, while looking like a complete list,
 * would be worse than no sidebar.
 *
 * The list is a navigation landmark of links rather than buttons, so a session can be
 * opened in a new tab and the browser's own history works as expected.
 */
export function SessionSidebar({
  activeSessionId,
  shortcuts,
  onNewSession,
  onNavigate,
  onOpenHelp,
  onOpenSettings,
  onCloseDrawer,
}: SessionSidebarProps) {
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? shortcuts.filter(
          (item) =>
            item.label.toLowerCase().includes(needle) ||
            item.id.toLowerCase().includes(needle),
        )
      : shortcuts;
    return groupShortcuts(filtered);
  }, [shortcuts, query]);

  return (
    <div className={styles.inner}>
      <div className={styles.drawerHeader}>
        <span className={styles.drawerTitle}>Sessions</span>
        <IconButton label="Close sessions" icon={<CloseIcon />} onClick={onCloseDrawer} />
      </div>

      <Button
        variant="primary"
        block
        leadingIcon={<PlusIcon size={15} />}
        onClick={onNewSession}
      >
        New session
      </Button>

      <div className={styles.search}>
        <SearchIcon size={14} className={styles.searchIcon} />
        <input
          type="search"
          className={styles.searchInput}
          placeholder="Search sessions..."
          aria-label="Search sessions on this device"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <nav className={styles.list} aria-label="Recent sessions on this device">
        {groups.length === 0 ? (
          <p className={styles.empty}>
            {query.trim() ? "No matching sessions." : "No sessions yet"}
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.bucket} className={styles.group}>
              <h2 className={styles.groupLabel}>{group.bucket}</h2>
              <ul>
                {group.items.map((item) => (
                  <li key={item.id}>
                    <Link
                      href={`/s/${encodeURIComponent(item.id)}`}
                      onClick={onNavigate}
                      className={[
                        styles.item,
                        item.id === activeSessionId ? styles.itemActive : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      aria-current={item.id === activeSessionId ? "page" : undefined}
                    >
                      <SessionIcon size={14} />
                      <span className={styles.itemLabel}>
                        {item.label === "Untitled session"
                          ? shortenSessionId(item.id)
                          : item.label}
                      </span>
                      <span className={styles.itemTime}>
                        {formatTime(item.lastOpenedAt)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </nav>

      <p className={styles.scopeNote}>
        Sessions opened in this browser. The backend holds every conversation, but does not
        publish a list, so sessions opened elsewhere are not shown here.
      </p>

      <div className={styles.footer}>
        <button type="button" className={styles.footerButton} onClick={onOpenHelp}>
          <HelpIcon size={15} />
          Help
        </button>
        <button type="button" className={styles.footerButton} onClick={onOpenSettings}>
          <SettingsIcon size={15} />
          Settings
        </button>
      </div>
    </div>
  );
}

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
