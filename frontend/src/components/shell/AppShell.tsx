"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ConversationViewport } from "@/components/conversation/ConversationViewport";
import {
  FollowUpComposer,
  type ComposerHandle,
} from "@/components/conversation/FollowUpComposer";
import { EvidenceRail } from "@/components/evidence/EvidenceRail";
import { ProductHeader } from "@/components/shell/ProductHeader";
import { SessionSidebar } from "@/components/session/SessionSidebar";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { useAgentStream } from "@/hooks/useAgentStream";
import { useBackendHealth, useSessionHistory } from "@/hooks/useSession";
import { useSessionShortcuts } from "@/hooks/useSessionShortcuts";
import { useViewportWidth } from "@/hooks/useViewport";
import { toSingleLine } from "@/lib/security/sanitize";
import { createSessionId } from "@/lib/session/ids";

export interface AppShellProps {
  readonly sessionId: string;
  readonly productName: string;
}

/** Width at or above which the evidence rail gets its own column. */
const RAIL_COLUMN_BREAKPOINT = 1440;
/** Width at or above which the sidebar is permanent rather than a drawer. */
const SIDEBAR_BREAKPOINT = 1180;

type DialogName = "none" | "clear" | "help" | "settings";

/**
 * The application shell.
 *
 * It owns the composition — sidebar, header, banner, conversation, evidence — and the few
 * pieces of state that genuinely span them: the drawer, the rail, the active dialog, and
 * the in-flight run.
 *
 * Evidence renders in exactly one place at any width: its own column above the rail
 * breakpoint, inline beneath the answer below it. Rendering both and hiding one with CSS
 * would duplicate every citation in the accessibility tree.
 */
export function AppShell({ sessionId, productName }: AppShellProps) {
  const router = useRouter();

  const history = useSessionHistory(sessionId);
  const health = useBackendHealth();
  const run = useAgentStream(sessionId, history.refresh);
  const { shortcuts, remember, clear: clearShortcutList } = useSessionShortcuts();
  const viewport = useViewportWidth();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(true);
  const [dialog, setDialog] = useState<DialogName>("none");
  const composerRef = useRef<ComposerHandle | null>(null);

  const railHasColumn = viewport >= RAIL_COLUMN_BREAKPOINT;
  const sidebarPermanent = viewport >= SIDEBAR_BREAKPOINT;
  const railVisible = railHasColumn && railOpen;
  // `viewport === 0` is the server and first client render, where the width is unknown.
  // Evidence is withheld for that one render rather than guessed at and then moved.
  const evidenceInline = viewport > 0 && !railVisible;

  // Record the visit locally, labelled with the session's first question once one exists.
  // This writes to browser storage — an external system — which is what an effect is for.
  const firstQuestion = history.turns[0]?.question;
  const sessionTitle = firstQuestion ? toSingleLine(firstQuestion, 80) : "Untitled session";
  useEffect(() => {
    remember(sessionId, firstQuestion ? toSingleLine(firstQuestion, 60) : undefined);
  }, [sessionId, firstQuestion, remember]);

  const startNewSession = useCallback(() => {
    // A new conversation always gets a new identifier. Reusing one would append a fresh
    // question to an existing backend history.
    const next = createSessionId();
    remember(next);
    setDrawerOpen(false);
    router.push(`/s/${encodeURIComponent(next)}`);
  }, [router, remember]);

  const submit = useCallback(
    (text: string) => {
      // The body is an OpenAI Responses input item, forwarded unchanged. It is not wrapped
      // in a frontend request object, and the session identifier is not repeated inside it:
      // that lives in the path, where transport metadata belongs.
      void run.submit({ body: [{ role: "user", content: text }], displayText: text });
    },
    [run],
  );

  const retry = useCallback(() => {
    // Retry is explicit and re-sends the preserved text. A streamed POST is never replayed
    // automatically: it may already have reached the backend and persisted the turn.
    const text = run.state.submittedText;
    if (text) {
      run.reset();
      submit(text);
    }
  }, [run, submit]);

  const useExample = useCallback((text: string) => {
    composerRef.current?.setDraft(text);
  }, []);

  const composerBlockedReason = useMemo(
    () =>
      health.status === "down"
        ? "The backend is unavailable. Questions cannot be sent until it recovers."
        : null,
    [health.status],
  );

  // The evidence rail projects the turn currently in view: the live one while a run is
  // active, otherwise the latest persisted turn.
  const live = run.state.phase !== "idle" && run.state.phase !== "completed";
  const latestTurn = history.turns[history.turns.length - 1];
  const railAnswer = live ? run.state.assistantText : (latestTurn?.answer ?? "");
  const railToolPaths = live ? [] : (latestTurn?.toolPaths ?? []);
  const railKnownPaths = live ? [] : (latestTurn?.knownPaths ?? []);

  return (
    <div className="appFrame">
      <a className="skipLink" href="#composer">
        Skip to question composer
      </a>

      <ProductHeader
        productName={productName}
        sessionTitle={sessionTitle}
        sessionId={sessionId}
        onClearSession={() => setDialog("clear")}
        clearDisabled={run.isActive || history.turns.length === 0}
        onToggleSidebar={() => setDrawerOpen((open) => !open)}
        sidebarOpen={drawerOpen}
        onToggleRail={() => setRailOpen((open) => !open)}
        railOpen={railOpen}
        railAvailable={railHasColumn}
      />

      <div className="appBody">
        {drawerOpen && !sidebarPermanent ? (
          <button
            type="button"
            className="drawerScrim"
            aria-label="Close sessions"
            onClick={() => setDrawerOpen(false)}
          />
        ) : null}

        {sidebarPermanent || drawerOpen ? (
          <div className={`sidebar ${sidebarPermanent ? "" : "sidebarDrawer"}`}>
            <SessionSidebar
              activeSessionId={sessionId}
              shortcuts={shortcuts}
              onNewSession={startNewSession}
              onNavigate={() => setDrawerOpen(false)}
              onOpenHelp={() => setDialog("help")}
              onOpenSettings={() => setDialog("settings")}
              onCloseDrawer={() => setDrawerOpen(false)}
            />
          </div>
        ) : null}

        <div className="workspace" data-rail={railVisible ? "visible" : "hidden"}>
          <div className="conversationColumn">
            <ConversationViewport
              productName={productName}
              turns={history.turns}
              run={run.state}
              loading={history.loading}
              historyError={history.error}
              evidenceInline={evidenceInline}
              onUseExample={useExample}
              onCancel={run.cancel}
              onRetry={retry}
              onReloadHistory={() => void history.refresh()}
            />

            <div className="composerRegion">
              <div className="composerInner">
                <FollowUpComposer
                  ref={composerRef}
                  onSubmit={submit}
                  onCancel={run.cancel}
                  busy={run.isActive}
                  blockedReason={composerBlockedReason}
                  placeholder={
                    history.turns.length === 0
                      ? "Ask an engineering question..."
                      : "Ask a follow-up question..."
                  }
                />
              </div>
            </div>
          </div>

          {railVisible ? (
            <EvidenceRail
              answer={railAnswer}
              toolPaths={railToolPaths}
              knownPaths={railKnownPaths}
            />
          ) : null}
        </div>
      </div>

      <Dialog
        open={dialog === "clear"}
        title="Clear this session?"
        onClose={() => setDialog("none")}
        actions={
          <>
            <Button onClick={() => setDialog("none")}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                void history.clear();
                run.reset();
                setDialog("none");
              }}
            >
              Clear history
            </Button>
          </>
        }
      >
        <p>
          This deletes the conversation history for this session on the backend. The session
          address stays the same, so you can keep asking questions here — they will simply
          start from an empty context.
        </p>
        <p style={{ marginBlockStart: "var(--space-3)" }}>This cannot be undone.</p>
      </Dialog>

      <Dialog
        open={dialog === "help"}
        title="Keyboard and behaviour"
        onClose={() => setDialog("none")}
        actions={<Button onClick={() => setDialog("none")}>Close</Button>}
      >
        <ul style={{ display: "grid", gap: "var(--space-2)" }}>
          <li>
            <strong>Enter</strong> sends the question; <strong>Shift+Enter</strong> starts a
            new line.
          </li>
          <li>
            <strong>Escape</strong> closes a dialog and returns focus to whatever opened it.
          </li>
          <li>
            One question runs at a time per session. A second one waits rather than
            interleaving, which is what keeps the conversation order meaningful.
          </li>
          <li>
            <strong>Stop</strong> cancels the run on the backend, not just in this tab.
          </li>
          <li>
            A failed question is never re-sent automatically: it may already have reached
            the backend, and replaying it would duplicate the turn.
          </li>
        </ul>
      </Dialog>

      <Dialog
        open={dialog === "settings"}
        title="Settings"
        onClose={() => setDialog("none")}
        actions={<Button onClick={() => setDialog("none")}>Close</Button>}
      >
        <p>
          The session list is stored in this browser only. Clearing it removes the
          shortcuts, not the conversations — the backend keeps every session, and any
          address you still have will still open.
        </p>
        <div style={{ marginBlockStart: "var(--space-4)" }}>
          <Button variant="danger" onClick={clearShortcutList}>
            Clear local session list
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
