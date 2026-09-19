"use client";

import { useId, useState, type CSSProperties } from "react";

import { measured } from "@/lib/modellab/evaluation";
import {
  checkpointLifecycle,
  checkpointName,
  type CheckpointRecord,
} from "@/lib/modellab/events";
import { gateOf, gatePass } from "@/lib/modellab/gates";
import { formatAgo, formatDuration, formatSteps, isBetter } from "@/lib/modellab/run";

import { Card, Chip } from "./Cards";
import local from "./CheckpointsLiveCard.module.css";
import { Icon } from "./icons";
import type { LiveCardProps } from "./live";

const number = (value: number) => Math.round(value).toLocaleString("en-US");

/** Checkpoints on the timeline before "all" is asked for. */
const RECENT = 8;

type CopyState =
  { readonly step: number; readonly outcome: "copied" | "manual" } | undefined;

/**
 * Checkpoints as a timeline: each column one write, its dot sized by the primary metric the
 * evaluation of that checkpoint measured, the promoted (best) one ringed, and under it the
 * promotion gates as pass/fail marks.
 */
export function CheckpointsLiveCard({
  stage,
  step,
  now,
  running,
  onResumeFrom,
}: LiveCardProps & { readonly onResumeFrom?: (step: number) => void }) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<number>();
  const [copy, setCopy] = useState<CopyState>();
  const baseId = useId();

  const lifecycle = checkpointLifecycle(stage, step, stage.run.stepsPerSecond, now);
  const newest = lifecycle.records[0]?.step ?? 0;
  // Checkpoints already on screen when the card mounted do not animate; later ones do.
  const [firstNewest] = useState(newest);

  const shown = (all ? lifecycle.records : lifecycle.records.slice(0, RECENT))
    .slice()
    .reverse();
  const metric = stage.metrics[0]!;
  const lossLabel =
    stage.id === "rl" ? "reward" : stage.id === "distillation" ? "val KL" : "val loss";
  const gates = stage.metrics.filter((item) => gateOf(item) !== undefined);

  // Dot size: the primary metric's share of its start → final range.
  const scoreShare = (value: number) => {
    const span = metric.final - metric.start || 1;
    return Math.min(1, Math.max(0, (value - metric.start) / span));
  };
  // Validation bar height across the shown checkpoints, better = taller.
  const vals = shown.map((record) => record.valLoss);
  const vLo = Math.min(...vals);
  const vHi = Math.max(...vals);
  const valShare = (value: number) => {
    if (vHi === vLo) return 0.6;
    const t = (value - vLo) / (vHi - vLo);
    return 0.2 + 0.8 * (isBetter(stage, 1, 0) ? t : 1 - t);
  };

  const copyUri = async (record: CheckpointRecord, target: HTMLElement | null) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(record.uri);
      setCopy({ step: record.step, outcome: "copied" });
    } catch {
      // Fall back to selecting the URI so the viewer can copy it with the keyboard.
      if (target) {
        const range = document.createRange();
        range.selectNodeContents(target);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setCopy({ step: record.step, outcome: "manual" });
    }
  };

  const inFlight = lifecycle.writing;
  const selected = lifecycle.records.find((record) => record.step === open);
  const detailsId = `${baseId}-details`;
  const uriId = `${baseId}-uri`;
  const columns = { "--columns": String(Math.max(1, shown.length)) } as CSSProperties;

  return (
    <Card
      title="Recent checkpoints"
      icon="checkpoint"
      className={local.card}
      aside={
        <span className={local.aside}>
          <Chip tone="sim">Simulated</Chip>
          {lifecycle.records.length > RECENT ? (
            <button
              type="button"
              className={local.toggle}
              aria-expanded={all}
              onClick={() => setAll((value) => !value)}
            >
              {all ? `last ${RECENT}` : `all ${lifecycle.records.length}`}
            </button>
          ) : null}
        </span>
      }
    >
      <div className={local.status}>
        {inFlight ? (
          <div className={local.flight} key={`writing-${inFlight.step}`}>
            <code>{checkpointName(inFlight.step)}</code>
            <span className={local.shards} aria-hidden="true">
              {Array.from({ length: inFlight.shards }, (_, index) => (
                <i key={index} data-done={index < inFlight.shardsDone || undefined} />
              ))}
            </span>
            <span className={local.phase}>{inFlight.phase}</span>
            <span className={local.muted}>
              −{formatDuration(inFlight.remainingSeconds)}
            </span>
            <div
              className={local.writeBar}
              data-running={running || undefined}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(inFlight.fraction * 100)}
              aria-label={`Checkpoint ${number(inFlight.step)}: ${inFlight.label}`}
            >
              <i style={{ width: `${(inFlight.fraction * 100).toFixed(1)}%` }} />
            </div>
          </div>
        ) : lifecycle.next ? (
          <span
            className={local.nextLine}
            aria-label={`Next checkpoint at step ${number(lifecycle.next.step)} in ${formatDuration(lifecycle.next.etaSeconds)}${running ? "" : " of training (paused)"}`}
          >
            <Icon name="checkpoint" size={14} />
            <code>{checkpointName(lifecycle.next.step)}</code>
            <strong>T−{formatDuration(lifecycle.next.etaSeconds)}</strong>
            {running ? null : <Chip tone="warn">paused</Chip>}
          </span>
        ) : (
          <span className={local.nextLine}>
            <Icon name="check" size={14} />
            <code>{checkpointName(stage.run.totalSteps)}</code>
            <Chip tone="ok">final</Chip>
          </span>
        )}
      </div>

      {shown.length === 0 ? (
        <div
          className={local.empty}
          role="img"
          aria-label="No checkpoint has been written yet"
        >
          <span className={local.emptyLane} />
        </div>
      ) : (
        <div
          className={local.scroller}
          data-all={all || undefined}
          tabIndex={all ? 0 : undefined}
          role={all ? "region" : undefined}
          aria-label={all ? "All checkpoints" : undefined}
        >
          <div className={local.grid} style={columns}>
            {/* Timeline: one column per checkpoint. */}
            <span className={local.rowLabel} aria-hidden="true">
              ckpt
            </span>
            {shown.map((record) => {
              const score = record.evalScore;
              const r = score === undefined ? 4 : 4 + scoreShare(score) * 7;
              const expanded = open === record.step;
              return (
                <button
                  key={record.step}
                  type="button"
                  className={local.dot}
                  data-best={record.best || undefined}
                  data-fresh={record.step > firstNewest || undefined}
                  data-open={expanded || undefined}
                  data-pending={score === undefined || undefined}
                  aria-expanded={expanded}
                  aria-controls={detailsId}
                  aria-label={`Checkpoint ${number(record.step)}: ${lossLabel} ${record.valLoss.toFixed(3)}, ${metric.label} ${score === undefined ? "evaluation running" : score.toFixed(metric.digits)}, ${record.status}, ${formatAgo(record.ageSeconds)}`}
                  onClick={() => setOpen(expanded ? undefined : record.step)}
                >
                  {record.best ? <span className={local.bestTag}>best</span> : null}
                  <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
                    <circle cx="13" cy="13" r={r} />
                    {record.best ? (
                      <circle cx="13" cy="13" r={12} className={local.ring} />
                    ) : null}
                  </svg>
                  <span className={local.stepLabel}>{formatSteps(record.step)}</span>
                </button>
              );
            })}

            {/* Held-out value written with the checkpoint, better = taller. */}
            <span className={local.rowLabel} aria-hidden="true">
              {lossLabel}
            </span>
            {shown.map((record) => (
              <span
                key={record.step}
                className={local.valCell}
                data-best={record.best || undefined}
                title={`${lossLabel} ${record.valLoss.toFixed(3)}`}
                aria-hidden="true"
              >
                <i style={{ height: `${(valShare(record.valLoss) * 100).toFixed(0)}%` }} />
              </span>
            ))}

            {/* Promotion gates as pass/fail marks. */}
            {gates.map((gate) => (
              <GateRow
                key={gate.label}
                label={gate.label}
                marks={shown.map((record) =>
                  record.evalScore === undefined
                    ? undefined
                    : gatePass(gate, measured(gate, stage, record.step)),
                )}
                steps={shown.map((record) => record.step)}
              />
            ))}
          </div>
        </div>
      )}

      <ul className={local.key} aria-hidden="true">
        <li>
          <i data-kind="dot" /> {metric.label.split(" (")[0]}
        </li>
        <li>
          <i data-kind="best" /> promoted
        </li>
        <li>
          <i data-kind="pass" /> pass
        </li>
        <li>
          <i data-kind="fail" /> fail
        </li>
        <li>
          <i data-kind="pending" /> eval running
        </li>
      </ul>

      {selected ? (
        <div className={local.details} id={detailsId}>
          <dl>
            <div>
              <dt>uri</dt>
              <dd>
                <code id={uriId}>{selected.uri}</code>
              </dd>
            </div>
            <div>
              <dt>sha256</dt>
              <dd>
                <code>{selected.digest.slice(0, 16)}…</code>
                <Chip tone="sim">simulated</Chip>
              </dd>
            </div>
            <div>
              <dt>size</dt>
              <dd>
                {selected.size} · {selected.shards} shards
              </dd>
            </div>
            <div>
              <dt>{lossLabel}</dt>
              <dd>{selected.valLoss.toFixed(3)}</dd>
            </div>
          </dl>
          <div className={local.actions}>
            {onResumeFrom ? (
              <button
                type="button"
                className={local.action}
                data-primary
                onClick={() => onResumeFrom(selected.step)}
              >
                <Icon name="play" size={13} />
                Resume from here
              </button>
            ) : null}
            <button
              type="button"
              className={local.action}
              onClick={() => void copyUri(selected, document.getElementById(uriId))}
            >
              <Icon name="clipboard" size={13} />
              Copy URI
            </button>
            <span className={local.copyStatus} role="status" aria-live="polite">
              {copy?.step === selected.step
                ? copy.outcome === "copied"
                  ? "Copied"
                  : "Ctrl+C"
                : ""}
            </span>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function GateRow({
  label,
  marks,
  steps,
}: {
  readonly label: string;
  readonly marks: readonly (boolean | undefined)[];
  readonly steps: readonly number[];
}) {
  return (
    <>
      <span className={local.rowLabel} title={label}>
        {label}
      </span>
      {marks.map((pass, index) => (
        <span
          key={steps[index]}
          className={local.gate}
          data-pass={pass === undefined ? undefined : pass}
          role="img"
          aria-label={`${label} at checkpoint ${number(steps[index]!)}: ${pass === undefined ? "not evaluated" : pass ? "pass" : "fail"}`}
        >
          {pass === undefined ? null : <Icon name={pass ? "check" : "cross"} size={10} />}
        </span>
      ))}
    </>
  );
}
