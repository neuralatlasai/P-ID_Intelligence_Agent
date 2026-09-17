"use client";

import { useEffect, useRef } from "react";

import { AssistantTurn } from "@/components/conversation/AssistantTurn";
import { EmptyState } from "@/components/conversation/EmptyState";
import { UserTurn } from "@/components/conversation/UserTurn";
import { EvidenceRail } from "@/components/evidence/EvidenceRail";
import { Button } from "@/components/ui/Button";
import { ArrowDownIcon, AlertIcon } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/Skeleton";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import type { AgentRunState } from "@/hooks/useAgentStream";
import type { FrontendRunError } from "@/lib/backend/errors";
import type { TranscriptTurn } from "@/lib/responses/transcript";

import styles from "./ConversationViewport.module.css";

export interface ConversationViewportProps {
  readonly productName: string;
  readonly turns: readonly TranscriptTurn[];
  readonly run: AgentRunState;
  readonly loading: boolean;
  readonly historyError: FrontendRunError | null;
  /** True when evidence renders inline here rather than in the fixed rail. */
  readonly evidenceInline: boolean;
  readonly onUseExample: (text: string) => void;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onReloadHistory: () => void;
}

/**
 * The scrolling transcript.
 *
 * Persisted turns render first, then the in-flight turn if there is one. The in-flight turn
 * disappears once reconciliation completes, because by then the same content has arrived
 * from the backend as a persisted turn — showing both would duplicate it, and preferring
 * the local copy would mean showing text that was never saved.
 *
 * Scroll follows new content only while the user is at the bottom. Someone reading an
 * earlier citation is not dragged away from it.
 */
export function ConversationViewport({
  productName,
  turns,
  run,
  loading,
  historyError,
  evidenceInline,
  onUseExample,
  onCancel,
  onRetry,
  onReloadHistory,
}: ConversationViewportProps) {
  const active =
    run.phase === "connecting" || run.phase === "streaming" || run.phase === "finalizing";
  const showLiveTurn = run.phase !== "idle" && run.phase !== "completed";

  const hasTranscript = turns.length > 0 || showLiveTurn;
  const { containerRef, canJump, jumpToLatest } = useAutoScroll<HTMLDivElement>([
    turns.length,
    run.assistantText,
    run.activities.length,
    run.phase,
  ]);

  // Announce completion once, rather than streaming every token into a live region, which
  // would make the page unusable with a screen reader.
  const announcementRef = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    if (!announcementRef.current) {
      return;
    }
    if (run.phase === "completed") {
      announcementRef.current.textContent = "Response completed.";
    } else if (run.phase === "failed") {
      announcementRef.current.textContent = `Request failed: ${run.error?.title ?? "unknown error"}.`;
    } else if (run.phase === "cancelled") {
      announcementRef.current.textContent = "Run cancelled.";
    }
  }, [run.phase, run.error]);

  const latestAnswer = showLiveTurn
    ? run.assistantText
    : (turns[turns.length - 1]?.answer ?? "");
  const latestToolPaths = showLiveTurn ? [] : (turns[turns.length - 1]?.toolPaths ?? []);
  const latestKnownPaths = showLiveTurn ? [] : (turns[turns.length - 1]?.knownPaths ?? []);

  return (
    <div className={styles.wrapper}>
      <div ref={containerRef} className="conversationScroll" id="conversation">
        <div className="conversationInner">
          {loading && turns.length === 0 ? (
            <Skeleton lines={4} label="Loading conversation history" />
          ) : null}

          {historyError ? (
            <div className={styles.historyError} role="alert">
              <p className={styles.historyErrorHead}>
                <AlertIcon size={16} />
                Unable to restore session history
              </p>
              <p>{historyError.detail}</p>
              <Button size="sm" onClick={onReloadHistory}>
                Retry
              </Button>
            </div>
          ) : null}

          {!loading && turns.length === 0 && !showLiveTurn && !historyError ? (
            <EmptyState productName={productName} onUseExample={onUseExample} />
          ) : null}

          {turns.map((turn, index) => {
            // After reconciliation the live turn is replaced by the persisted one. The
            // persisted item carries no timing, so the run's own measurement is carried
            // across to the turn it produced -- otherwise the elapsed figure would vanish
            // at the exact moment the answer finishes.
            const isJustCompleted =
              run.phase === "completed" &&
              index === turns.length - 1 &&
              turn.question === run.submittedText;

            return (
              <div key={turn.id} className={styles.turn}>
                {turn.question ? <UserTurn text={turn.question} /> : null}
                <AssistantTurn
                  text={turn.answer}
                  activities={turn.activities}
                  phase="completed"
                  unanswered={turn.incomplete}
                  {...(isJustCompleted ? { timings: run.timings } : {})}
                />
              </div>
            );
          })}

          {showLiveTurn ? (
            <div className={styles.turn}>
              <UserTurn text={run.submittedText} at={run.timings.submittedAt} />
              <AssistantTurn
                text={run.assistantText}
                activities={run.activities}
                phase={run.phase}
                timings={run.timings}
                error={run.error}
                partial={run.partial}
                {...(active ? { onCancel } : {})}
                {...(run.error?.retryable ? { onRetry } : {})}
              />
            </div>
          ) : null}

          {evidenceInline && latestAnswer ? (
            <EvidenceRail
              answer={latestAnswer}
              toolPaths={latestToolPaths}
              knownPaths={latestKnownPaths}
              inline
            />
          ) : null}
        </div>
      </div>

      {canJump && hasTranscript ? (
        <div className={styles.jumpWrap}>
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<ArrowDownIcon size={14} />}
            onClick={jumpToLatest}
          >
            Jump to latest
          </Button>
        </div>
      ) : null}

      <p ref={announcementRef} className="srOnly" role="status" aria-live="polite" />
    </div>
  );
}
