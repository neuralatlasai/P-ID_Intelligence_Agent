"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { BACKBONES, ACCELERATORS } from "@/lib/modellab/config";
import { checkpoints, formatAgo, formatDuration } from "@/lib/modellab/run";
import type { Lineage, RunRecord } from "@/lib/modellab/session";
import type { Stage } from "@/lib/modellab/stages";

import { Icon } from "./icons";
import styles from "./RunControls.module.css";

const number = (value: number) => Math.floor(value).toLocaleString("en-US");

const REASON: Record<RunRecord["reason"], string> = {
  reconfigured: "Reconfigured",
  stopped: "Stopped",
  "resumed-from-checkpoint": "Rolled back",
  reset: "Reset",
};

/** Close a popover on outside click or Escape, returning focus to its trigger. */
function useDismiss(open: boolean, close: () => void) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return root;
}

/**
 * The stage's run controls: run or pause, stop, roll back to a written checkpoint, and the
 * history of experiments this stage has been through.
 */
export function RunControls({
  stage,
  step,
  running,
  complete,
  blocked,
  history,
  onToggle,
  onStop,
  onResumeFrom,
  now,
}: {
  readonly now: number;
  readonly stage: Stage;
  readonly step: number;
  readonly running: boolean;
  readonly complete: boolean;
  readonly blocked: boolean;
  readonly history: readonly RunRecord[];
  readonly onToggle: () => void;
  readonly onStop: () => void;
  readonly onResumeFrom: (step: number) => void;
}) {
  const [menu, setMenu] = useState<"none" | "run" | "history">("none");
  const close = useCallback(() => setMenu("none"), []);
  const runRoot = useDismiss(menu === "run", close);
  const historyRoot = useDismiss(menu === "history", close);
  const written = checkpoints(stage, step, 6);
  const stageHistory = history.filter((record) => record.stage === stage.id);

  return (
    <div className={styles.controls}>
      <div className={styles.anchor} ref={historyRoot}>
        <button
          className={styles.secondary}
          aria-expanded={menu === "history"}
          onClick={() => setMenu(menu === "history" ? "none" : "history")}
        >
          <Icon name="experiments" size={15} />
          Runs
          {stageHistory.length > 0 && <b>{stageHistory.length + 1}</b>}
        </button>
        {menu === "history" && (
          <div className={styles.popover} role="dialog" aria-label="Run history">
            <h2>Run history · {stage.number}</h2>
            <ol className={styles.history}>
              <li data-current>
                <strong>{stage.experimentId}</strong>
                <span>
                  {running ? "Running" : complete ? "Complete" : "Paused"} · step{" "}
                  {number(step)}
                </span>
              </li>
              {stageHistory.map((record) => {
                const backbone = BACKBONES.find((b) => b.id === record.config.backbone);
                const accelerator = ACCELERATORS.find(
                  (a) => a.id === record.config.accelerator,
                );
                return (
                  <li key={`${record.experimentId}-${record.endedAt}`}>
                    <strong>{record.experimentId}</strong>
                    <span>
                      {REASON[record.reason]} at step {number(record.finalStep)} ·{" "}
                      {formatAgo((now - record.endedAt) / 1000)}
                    </span>
                    <small>
                      {backbone?.name} · {record.config.nodes}×{record.config.gpusPerNode}{" "}
                      {accelerator?.name} · {record.config.precision.toUpperCase()} · batch{" "}
                      {record.config.globalBatch} · ran{" "}
                      {formatDuration((record.endedAt - record.startedAt) / 1000)}
                    </small>
                  </li>
                );
              })}
            </ol>
            {stageHistory.length === 0 && (
              <p className={styles.quiet}>
                No earlier runs. Reconfiguring, stopping or rolling back archives the
                current run here.
              </p>
            )}
          </div>
        )}
      </div>

      <div className={styles.split} ref={runRoot}>
        <button
          className={styles.primary}
          onClick={onToggle}
          disabled={blocked && !running}
          title={
            blocked ? "Waiting for the previous stage to write a checkpoint" : undefined
          }
        >
          {complete
            ? "Re-run training stage"
            : running
              ? "Pause training stage"
              : "Run training stage"}
          <Icon name={running ? "pause" : "arrow"} size={15} />
        </button>
        <button
          className={styles.primaryMenu}
          aria-label="More run actions"
          aria-expanded={menu === "run"}
          onClick={() => setMenu(menu === "run" ? "none" : "run")}
        >
          <Icon name="chevron" size={14} />
        </button>
        {menu === "run" && (
          <div
            className={`${styles.popover} ${styles.right}`}
            role="menu"
            aria-label="Run actions"
          >
            <button
              role="menuitem"
              className={styles.menuItem}
              disabled={!running}
              onClick={() => {
                onStop();
                close();
              }}
            >
              <Icon name="pause" size={14} />
              Stop run and archive
            </button>
            <p className={styles.menuLabel}>Roll back to checkpoint</p>
            {written.length === 0 && (
              <p className={styles.quiet}>No checkpoint written yet.</p>
            )}
            {written.map((checkpoint) => (
              <button
                key={checkpoint.step}
                role="menuitem"
                className={styles.menuItem}
                onClick={() => {
                  onResumeFrom(checkpoint.step);
                  close();
                }}
              >
                <Icon name="checkpoint" size={14} />
                Step {checkpoint.step.toLocaleString("en-US")}
                <small>
                  val {checkpoint.valLoss.toFixed(3)} · {formatAgo(checkpoint.ageSeconds)}
                  {checkpoint.best ? " · best" : ""}
                </small>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Where this stage's starting weights come from, and whether that source is final. */
export function LineageBanner({
  lineage,
  stage,
}: {
  readonly lineage: Lineage;
  readonly stage: Stage;
}) {
  if (lineage.source === "backbone") {
    return (
      <p className={styles.lineage} data-state="ok">
        <Icon name="model" size={14} />
        <span>Initialised from the public backbone checkpoint · no upstream stage.</span>
      </p>
    );
  }
  const parent = lineage.parent!;
  if (lineage.source === "blocked") {
    return (
      <p className={styles.lineage} data-state="blocked">
        <Icon name="info" size={14} />
        <span>
          Blocked: {parent.stage.number} {parent.stage.title} has not written a checkpoint
          yet.{" "}
          <Link href={`/model-lab/${parent.stage.id}`}>
            Open stage {parent.stage.number}
          </Link>
        </span>
      </p>
    );
  }
  return (
    <p className={styles.lineage} data-state={parent.interim ? "interim" : "ok"}>
      <Icon name="checkpoint" size={14} />
      <span>
        Warm-started from{" "}
        <Link href={`/model-lab/${parent.stage.id}`}>
          {parent.stage.number} {parent.stage.title}
        </Link>{" "}
        · {parent.experimentId} @ step {parent.step.toLocaleString("en-US")}
        {parent.interim
          ? ` — interim snapshot; ${stage.number} will re-base when stage ${parent.stage.number} completes.`
          : " — final checkpoint."}
      </span>
    </p>
  );
}

/** "Live · updated 23:10:05" with a heartbeat that stops when the tab or the run is idle. */
export function Freshness({
  now,
  running,
}: {
  readonly now: number;
  readonly running: boolean;
}) {
  return (
    <span className={styles.freshness} data-running={running || undefined} aria-live="off">
      <i aria-hidden="true" />
      {running ? "Live" : "Idle"} · updated{" "}
      {new Date(now).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })}
    </span>
  );
}
