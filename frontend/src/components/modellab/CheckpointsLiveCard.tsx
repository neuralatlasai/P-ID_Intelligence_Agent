"use client";

import { Fragment, useId, useState } from "react";

import {
  checkpointLifecycle,
  checkpointName,
  type CheckpointRecord,
} from "@/lib/modellab/events";
import { formatAgo, formatDuration, formatSteps } from "@/lib/modellab/run";

import { Card } from "./Cards";
import local from "./CheckpointsLiveCard.module.css";
import { Icon } from "./icons";
import type { LiveCardProps } from "./live";
import styles from "./ModelLab.module.css";

const number = (value: number) => Math.round(value).toLocaleString("en-US");

const RECENT = 5;

type CopyState =
  { readonly step: number; readonly outcome: "copied" | "manual" } | undefined;

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

  const items = all ? lifecycle.records : lifecycle.records.slice(0, RECENT);
  const metric = stage.metrics[0]!;
  const lossLabel =
    stage.id === "rl" ? "Reward" : stage.id === "distillation" ? "Val KL" : "Val loss";
  const columns = 6;

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

  return (
    <Card
      title="Recent checkpoints"
      icon="checkpoint"
      className={local.card}
      aside={
        lifecycle.records.length > RECENT ? (
          <button
            type="button"
            className={`${styles.linkButton} ${local.toggle}`}
            aria-expanded={all}
            onClick={() => setAll((value) => !value)}
          >
            {all ? "Show recent" : `View all (${lifecycle.records.length})`}
          </button>
        ) : undefined
      }
    >
      <div
        className={`${styles.tableWrap} ${local.wrap}`}
        data-all={all || undefined}
        tabIndex={all ? 0 : undefined}
        role={all ? "region" : undefined}
        aria-label={all ? "All checkpoints" : undefined}
      >
        <table className={`${styles.table} ${local.table}`}>
          <thead>
            <tr>
              <th scope="col">Step</th>
              <th scope="col">{lossLabel}</th>
              <th scope="col">Eval</th>
              <th scope="col">Status</th>
              <th scope="col">Time</th>
              <th scope="col">
                <span className={local.srOnly}>Details</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {inFlight ? (
              <tr className={local.flight} key={`writing-${inFlight.step}`}>
                <td colSpan={columns}>
                  <div className={local.flightHead}>
                    <strong>{checkpointName(inFlight.step)}</strong>
                    <span>{inFlight.label}</span>
                    <span className={local.muted}>
                      ~{formatDuration(inFlight.remainingSeconds)} left
                    </span>
                  </div>
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
                </td>
              </tr>
            ) : lifecycle.next ? (
              <tr className={local.nextRow}>
                <td colSpan={columns}>
                  <span className={local.nextLine}>
                    <Icon name="checkpoint" size={14} />
                    <span>
                      Next · step {number(lifecycle.next.step)} in{" "}
                      <strong>{formatDuration(lifecycle.next.etaSeconds)}</strong>
                      {running ? "" : " (paused)"}
                    </span>
                  </span>
                </td>
              </tr>
            ) : (
              <tr className={local.nextRow}>
                <td colSpan={columns}>
                  <span className={local.nextLine}>
                    <Icon name="check" size={14} />
                    <span>
                      Run complete · final checkpoint {formatSteps(stage.run.totalSteps)}
                    </span>
                  </span>
                </td>
              </tr>
            )}

            {items.length === 0 ? (
              <tr>
                <td colSpan={columns} className={local.muted}>
                  No checkpoint has been written yet.
                </td>
              </tr>
            ) : null}

            {items.map((record) => {
              const expanded = open === record.step;
              const detailsId = `${baseId}-ckpt-${record.step}`;
              const uriId = `${detailsId}-uri`;
              return (
                <Fragment key={record.step}>
                  <tr
                    className={local.row}
                    data-best={record.best || undefined}
                    data-fresh={record.step > firstNewest || undefined}
                    data-open={expanded || undefined}
                  >
                    <td className={local.num}>{number(record.step)}</td>
                    <td className={local.num}>{record.valLoss.toFixed(3)}</td>
                    <td className={local.num}>
                      {record.evalScore === undefined ? (
                        <span className={local.muted} title="Evaluation running">
                          running
                        </span>
                      ) : (
                        record.evalScore.toFixed(metric.digits)
                      )}
                    </td>
                    <td>
                      <span className={local.chip} data-status={record.status}>
                        {record.status}
                      </span>
                    </td>
                    <td className={local.time}>{formatAgo(record.ageSeconds)}</td>
                    <td className={local.expandCell}>
                      <button
                        type="button"
                        className={local.expand}
                        aria-expanded={expanded}
                        aria-controls={detailsId}
                        aria-label={`${expanded ? "Hide" : "Show"} details for checkpoint ${number(record.step)}`}
                        onClick={() => setOpen(expanded ? undefined : record.step)}
                      >
                        <Icon name="chevron" size={14} />
                      </button>
                    </td>
                  </tr>
                  {expanded ? (
                    <tr className={local.detailsRow} id={detailsId}>
                      <td colSpan={columns}>
                        <dl className={local.details}>
                          <div>
                            <dt>Storage URI</dt>
                            <dd>
                              <code id={uriId}>{record.uri}</code>
                            </dd>
                          </div>
                          <div>
                            <dt>Digest</dt>
                            <dd>
                              <code>sha256:{record.digest}</code>
                              <span className={local.simNote}>simulated</span>
                            </dd>
                          </div>
                          <div>
                            <dt>Size</dt>
                            <dd>
                              {record.size} · {record.shards} shards
                            </dd>
                          </div>
                          <div>
                            <dt>{metric.label}</dt>
                            <dd>
                              {record.evalScore === undefined
                                ? "Evaluation running"
                                : record.evalScore.toFixed(metric.digits)}
                            </dd>
                          </div>
                        </dl>
                        <div className={local.actions}>
                          {onResumeFrom ? (
                            <button
                              type="button"
                              className={local.action}
                              data-primary
                              onClick={() => onResumeFrom(record.step)}
                            >
                              <Icon name="play" size={13} />
                              Resume from here
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className={local.action}
                            onClick={() =>
                              void copyUri(record, document.getElementById(uriId))
                            }
                          >
                            <Icon name="clipboard" size={13} />
                            Copy URI
                          </button>
                          <span
                            className={local.copyStatus}
                            role="status"
                            aria-live="polite"
                          >
                            {copy?.step === record.step
                              ? copy.outcome === "copied"
                                ? "Copied"
                                : "URI selected — press Ctrl+C to copy"
                              : ""}
                          </span>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
