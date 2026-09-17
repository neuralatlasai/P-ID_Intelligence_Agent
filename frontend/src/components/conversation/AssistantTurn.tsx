"use client";

import { useState } from "react";

import { AnswerRenderer } from "@/components/conversation/AnswerRenderer";
import { ActivityDisclosure } from "@/components/conversation/ActivityDisclosure";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { AlertIcon, CheckIcon, CopyIcon, ProductMark } from "@/components/ui/icons";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import type { FrontendRunError } from "@/lib/backend/errors";
import type { ActivityView, StreamPhase } from "@/lib/responses/projector";
import { elapsedMs, formatDuration, type RunTimings } from "@/lib/telemetry/timings";

import styles from "./AssistantTurn.module.css";

export interface AssistantTurnProps {
  readonly text: string;
  readonly activities: readonly ActivityView[];
  readonly phase: StreamPhase;
  readonly timings?: RunTimings;
  readonly error?: FrontendRunError | null;
  readonly partial?: boolean;
  readonly onCancel?: () => void;
  readonly onRetry?: () => void;
  /** True for a historical turn that has a question but no persisted answer. */
  readonly unanswered?: boolean;
}

/**
 * One assistant response: its activity, its answer, and how it ended.
 *
 * The activity panel is open while the run is in flight and collapses once it completes,
 * which keeps a long transcript readable without hiding what happened.
 *
 * A failure is rendered beneath whatever text arrived, never instead of it. Partial output
 * is real and may be useful, but it is labelled as partial so it is never mistaken for a
 * finished engineering answer.
 */
export function AssistantTurn({
  text,
  activities,
  phase,
  timings,
  error,
  partial = false,
  onCancel,
  onRetry,
  unanswered = false,
}: AssistantTurnProps) {
  const active = phase === "connecting" || phase === "streaming" || phase === "finalizing";
  const [activityOpen, setActivityOpen] = useState(false);
  const { state: copyState, copy } = useCopyToClipboard();

  const duration = timings ? elapsedMs(timings) : null;

  return (
    <article className={styles.row} aria-label="Assistant response">
      <div className={styles.avatar} aria-hidden="true">
        <ProductMark size={18} />
      </div>

      <div className={styles.body}>
        <ActivityDisclosure
          activities={activities}
          phase={phase}
          // While a run is active the panel shows itself; afterwards the user controls it.
          open={active ? true : activityOpen}
          onToggle={setActivityOpen}
          {...(onCancel ? { onCancel } : {})}
        />

        {text ? (
          <AnswerRenderer
            text={text}
            streaming={phase === "streaming"}
            partial={partial && !error}
          />
        ) : null}

        {unanswered && !text && !active && !error ? (
          <p className={styles.unanswered}>No answer was persisted for this question.</p>
        ) : null}

        {error && error.code === "cancelled" ? (
          <p className={styles.cancelled}>
            <AlertIcon size={14} />
            <span>
              Run cancelled.{" "}
              {text ? "The text above is incomplete." : "No answer was produced."}
            </span>
          </p>
        ) : null}

        {error && error.code !== "cancelled" ? (
          <div className={styles.error} role="alert">
            <p className={styles.errorHead}>
              <AlertIcon size={16} />
              {error.title}
            </p>
            <p className={styles.errorDetail}>{error.detail}</p>
            <div className={styles.errorFooter}>
              {error.requestId ? (
                <span className={styles.requestId}>Request ID: {error.requestId}</span>
              ) : null}
              {error.retryAfterSeconds ? (
                <span className="metaText">Suggested wait: {error.retryAfterSeconds}s</span>
              ) : null}
              {error.retryable && onRetry ? (
                <Button size="sm" onClick={onRetry}>
                  Retry
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {(duration !== null || text) && !active ? (
          <div className={styles.meta}>
            {duration === null ? null : (
              <span
                className="metaText"
                title="Measured in the browser, from send to completion"
              >
                Elapsed {formatDuration(duration)}
              </span>
            )}
            {text ? (
              <div className={styles.metaActions}>
                {copyState === "copied" ? (
                  <span className="metaText" role="status">
                    Copied
                  </span>
                ) : null}
                <IconButton
                  label="Copy answer text"
                  icon={
                    copyState === "copied" ? (
                      <CheckIcon size={14} />
                    ) : (
                      <CopyIcon size={14} />
                    )
                  }
                  onClick={() => void copy(text)}
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}
