"use client";

import { useState, type ReactNode } from "react";

import {
  evalEvery,
  evalLagSteps,
  lastEvalStep,
  metricAtEval,
  metricHistory,
  nextEvalStep,
  type EvalPoint,
} from "@/lib/modellab/evaluation";
import { formatDuration, meetsTarget } from "@/lib/modellab/run";
import type { MetricSpec, Stage } from "@/lib/modellab/stages";

import { Card } from "./Cards";
import type { LiveCardProps } from "./live";
import base from "./ModelLab.module.css";
import styles from "./MetricsLiveCard.module.css";

/** Evaluations shown in each sparkline. */
const HISTORY = 12;

const number = (value: number) => value.toLocaleString("en-US");
const fmt = (value: number, digits: number) => value.toFixed(digits);

/** Improving toward the metric's goal across the sparkline's window. */
function improving(metric: MetricSpec, history: readonly EvalPoint[]): boolean {
  const first = history[0]?.value;
  const last = history.at(-1)?.value;
  if (first === undefined || last === undefined || history.length < 2) return true;
  return metric.direction === "up" ? last >= first : last <= first;
}

function Sparkline({
  metric,
  history,
}: {
  readonly metric: MetricSpec;
  readonly history: readonly EvalPoint[];
}) {
  const width = 64;
  const height = 18;
  const good = improving(metric, history);
  const values = history.map((point) => point.value);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const coords = history.map((point, index) => {
    const x =
      history.length > 1 ? 2 + (index / (history.length - 1)) * (width - 4) : width / 2;
    const y = hi === lo ? height / 2 : 2 + (1 - (point.value - lo) / span) * (height - 4);
    return [x, y] as const;
  });
  const last = coords.at(-1);
  const summary = `${good ? "Improving" : "Not improving"} over the last ${history.length} evaluation${history.length === 1 ? "" : "s"}`;
  return (
    <span className={styles.trend} data-good={good || undefined}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={summary}
        className={styles.spark}
      >
        <polyline
          points={coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.4}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {last ? <circle cx={last[0]} cy={last[1]} r={1.9} fill="currentColor" /> : null}
      </svg>
      <span className={styles.arrow} aria-hidden="true">
        {metric.direction === "up" ? "↑" : "↓"}
      </span>
    </span>
  );
}

/** The value cell's content, remounted per evaluation so its highlight replays. */
function Fresh({
  evalStep,
  fresh,
  children,
}: {
  readonly evalStep: number;
  readonly fresh: boolean;
  readonly children: ReactNode;
}) {
  return (
    <span key={evalStep} className={styles.value} data-fresh={fresh || undefined}>
      {children}
    </span>
  );
}

function Verdict({ meets }: { readonly meets: boolean | undefined }) {
  if (meets === undefined) return null;
  return (
    <span className={styles.verdict} data-meets={meets || undefined}>
      {meets ? "✓ Pass" : "✗ Below target"}
    </span>
  );
}

function deltaCell(
  metric: MetricSpec,
  value: number,
  meets: boolean | undefined,
): ReactNode {
  const teacher = metric.reference;
  if (typeof teacher === "number") {
    if (metric.format === "percent-delta") {
      const pct = ((value - teacher) / teacher) * 100;
      const good = metric.direction === "up" ? pct >= 0 : pct <= 0;
      return (
        <span className={good ? base.up : base.negative}>
          {`${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(0)}%`}
          <span className={styles.srOnly}>
            {good ? " (better than teacher)" : " (worse than teacher)"}
          </span>
        </span>
      );
    }
    const diff = value - teacher;
    const good = metric.direction === "up" ? diff >= 0 : diff <= 0;
    return (
      <span className={good ? base.up : base.negative}>
        {`${diff >= 0 ? "+" : "−"}${Math.abs(diff).toFixed(3)}`}
        <span className={styles.srOnly}>
          {good ? " (at or above teacher)" : " (below teacher)"}
        </span>
      </span>
    );
  }
  if (metric.target !== undefined) {
    return (
      <span className={meets ? base.up : base.warn}>
        {meets ? "✓ " : "✗ "}
        {metric.direction === "up" ? "≥" : "<"} {metric.target}
        <span className={styles.srOnly}>{meets ? " (pass)" : " (below target)"}</span>
      </span>
    );
  }
  return "—";
}

function evalNote(stage: Stage, step: number, running: boolean): string {
  const { run } = stage;
  const last = lastEvalStep(stage, step);
  const next = nextEvalStep(stage, step);
  const rate = run.stepsPerSecond > 0 ? run.stepsPerSecond : 1;
  // Results are published when the pass finishes, EVAL_SECONDS after the step it evaluates.
  const lag = last === 0 || last >= run.totalSteps ? 0 : evalLagSteps(stage);
  const ago = formatDuration(Math.max(0, step - last - lag) / rate);
  const head =
    last === 0 ? "Baseline evaluated at step 0" : `Evaluated at step ${number(last)}`;
  const parts = [head, last === 0 && step < 1 ? "before training" : `published ${ago} ago`];
  if (next === undefined) parts.push("final evaluation");
  else {
    const wait = formatDuration(Math.max(0, next + evalLagSteps(stage) - step) / rate);
    parts.push(
      running
        ? `next results in ${wait}`
        : `next results in ${wait} of training (paused)`,
    );
  }
  return parts.join(" · ");
}

/**
 * Stage metrics as the evaluation harness last reported them. Values move only when an
 * evaluation completes; each row carries a sparkline of recent evaluations.
 */
export function MetricsLiveCard({ stage, step, running }: LiveCardProps) {
  const evalStep = lastEvalStep(stage, step);
  // Highlight only evaluations that land while the card is open, not the one it opened on.
  const [openedAt] = useState(evalStep);
  const fresh = evalStep !== openedAt;
  const evalProgress = evalStep / stage.run.totalSteps;
  const every = evalEvery(stage);
  const cadence = `every ${number(every)} steps`;

  return (
    <Card
      title={stage.metricsTitle}
      icon="metrics"
      aside={
        <span className={styles.harness} title={`Held-out split evaluated ${cadence}`}>
          eval harness: held-out split
        </span>
      }
    >
      <p className={styles.note}>
        <span>{evalNote(stage, step, running)}</span>
        <span className={styles.cadence}>Simulated run · evaluated {cadence}</span>
      </p>
      <div
        className={base.tableWrap}
        tabIndex={0}
        role="region"
        aria-label={`${stage.metricsTitle} table`}
      >
        <table className={`${base.table} ${styles.table}`} data-metrics>
          <thead>
            <tr>
              {stage.metricColumns.map((column) => (
                <th key={column} scope="col">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stage.metrics.map((metric) => {
              const value = metricAtEval(metric, stage, step);
              // Judge the figure as displayed, so "0.60" never reads as below a "≥ 0.60" target.
              const meets = meetsTarget(metric, Number(fmt(value, metric.digits)));
              const history = metricHistory(metric, stage, step, HISTORY);
              if (stage.id === "distillation") {
                const teacher = metric.reference;
                return (
                  <tr key={metric.label}>
                    <th scope="row">{metric.label}</th>
                    <td>
                      {typeof teacher === "number"
                        ? fmt(teacher, metric.digits)
                        : (teacher ?? "—")}
                    </td>
                    <td>
                      <Fresh evalStep={evalStep} fresh={fresh}>
                        <span className={base.strong}>{fmt(value, metric.digits)}</span>
                      </Fresh>
                    </td>
                    <td>
                      <span className={styles.deltaCell}>
                        <Sparkline metric={metric} history={history} />
                        {deltaCell(metric, value, meets)}
                      </span>
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={metric.label}>
                  <th scope="row">{metric.label}</th>
                  <td>
                    {stage.id === "rl"
                      ? typeof metric.reference === "number"
                        ? fmt(metric.reference, metric.digits)
                        : (metric.reference ?? "—")
                      : metric.target === undefined
                        ? "—"
                        : `${metric.direction === "up" ? "≥" : "≤"} ${fmt(metric.target, metric.digits)}`}
                  </td>
                  <td>
                    <Fresh evalStep={evalStep} fresh={fresh}>
                      <span
                        className={
                          meets === false ? base.warn : meets ? base.good : base.strong
                        }
                      >
                        {fmt(value, metric.digits)}
                      </span>
                      <Verdict meets={meets} />
                    </Fresh>
                  </td>
                  <td>
                    <Sparkline metric={metric} history={history} />
                  </td>
                </tr>
              );
            })}
            {stage.id === "distillation" && (
              <tr>
                <th scope="row">INT8 / FP8 compatibility</th>
                <td>Partial</td>
                <td>
                  <Fresh evalStep={evalStep} fresh={fresh}>
                    <span className={base.strong}>
                      {evalProgress >= 0.5 ? "Yes" : "In progress"}
                    </span>
                  </Fresh>
                </td>
                <td>
                  {evalProgress >= 0.5 ? (
                    <span className={base.up}>✓ Pass</span>
                  ) : (
                    <span className={base.warn}>Checked at 50%</span>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
