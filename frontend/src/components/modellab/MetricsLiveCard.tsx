"use client";

import { useState } from "react";

import {
  evalEvery,
  evalLagSteps,
  lastEvalStep,
  measured,
  metricAtEval,
  metricHistory,
  nextEvalStep,
  checkpointMarkers,
} from "@/lib/modellab/evaluation";
import { gapClosed, gatePass } from "@/lib/modellab/gates";
import { formatDuration, formatSteps } from "@/lib/modellab/run";
import type { MetricSpec, Stage } from "@/lib/modellab/stages";

import { Card, Chip, PassMark, useElementWidth } from "./Cards";
import type { LiveCardProps } from "./live";
import styles from "./MetricsLiveCard.module.css";

/** Evaluated checkpoints shown in the slope chart. */
const SLOPE_POINTS = 6;

const number = (value: number) => Math.round(value).toLocaleString("en-US");
const fmt = (value: number, digits: number) => value.toFixed(digits);

interface Row {
  readonly metric: MetricSpec;
  readonly index: number;
  readonly value: number;
  readonly previous: number | undefined;
  readonly pass: boolean | undefined;
}

/** Bullet chart: bar = baseline → current, rule = target, diamond = reference, tick = previous. */
function Bullet({ row, stage }: { readonly row: Row; readonly stage: Stage }) {
  const { metric, value, previous } = row;
  const reference = typeof metric.reference === "number" ? metric.reference : undefined;
  const points = [
    metric.start,
    metric.final,
    value,
    metric.target,
    reference,
    previous,
  ].filter((v): v is number => v !== undefined && Number.isFinite(v));
  let lo = Math.min(...points);
  let hi = Math.max(...points);
  const pad = (hi - lo) * 0.06 || Math.abs(hi) * 0.1 || 1;
  lo -= pad;
  hi += pad;
  if (lo < 0 && Math.min(...points) >= 0) lo = 0;
  // Better is always to the right: a "lower is better" metric runs its axis high → low.
  const pos = (v: number) =>
    (metric.direction === "up" ? (v - lo) / (hi - lo) : (hi - v) / (hi - lo)) * 100;
  const a = pos(metric.start);
  const b = pos(value);
  const reference2 =
    reference !== undefined && Math.abs(reference - metric.start) > 1e-9
      ? reference
      : undefined;
  const refLabel = stage.id === "distillation" ? "teacher" : "SFT baseline";
  const label =
    `${metric.label}: ${fmt(value, metric.digits)} (baseline ${fmt(metric.start, metric.digits)}` +
    (metric.target !== undefined ? `, target ${fmt(metric.target, metric.digits)}` : "") +
    (reference !== undefined ? `, ${refLabel} ${fmt(reference, metric.digits)}` : "") +
    (previous !== undefined
      ? `, previous evaluation ${fmt(previous, metric.digits)}`
      : "") +
    (row.pass === undefined ? ")" : row.pass ? "): pass" : "): fail");
  return (
    <span className={styles.bullet} role="img" aria-label={label}>
      <span className={styles.track} />
      <i
        className={styles.bar}
        data-pass={row.pass === undefined ? undefined : row.pass}
        style={{
          left: `${Math.min(a, b).toFixed(2)}%`,
          width: `${Math.abs(b - a).toFixed(2)}%`,
        }}
      />
      <b className={styles.baseline} style={{ left: `${a.toFixed(2)}%` }} />
      {previous !== undefined ? (
        <b className={styles.previous} style={{ left: `${pos(previous).toFixed(2)}%` }} />
      ) : null}
      {metric.target !== undefined ? (
        <b
          className={styles.target}
          style={{ left: `${pos(metric.target).toFixed(2)}%` }}
        />
      ) : null}
      {reference2 !== undefined ? (
        <b
          className={styles.reference}
          style={{ left: `${pos(reference2).toFixed(2)}%` }}
        />
      ) : null}
      <b className={styles.head} style={{ left: `${b.toFixed(2)}%` }} />
    </span>
  );
}

/** Where the harness is: published evaluation, the pass in flight, and the next one. */
function Cadence({ stage, step }: { readonly stage: Stage; readonly step: number }) {
  const [host, width] = useElementWidth<HTMLDivElement>(480);
  const { run } = stage;
  const every = evalEvery(stage);
  const lag = evalLagSteps(stage);
  const last = lastEvalStep(stage, step);
  const next = nextEvalStep(stage, step);
  const head = Math.min(run.totalSteps, Math.max(0, step));
  const lo = Math.max(0, last - every);
  const hi = Math.min(run.totalSteps, Math.max(head, (next ?? last) + lag) + every * 0.25);
  const span = hi - lo || 1;
  const pad = 10;
  const x = (s: number) => pad + ((s - lo) / span) * (width - pad * 2);
  const ticks: number[] = [];
  for (let at = Math.ceil(lo / every) * every; at <= hi + 1e-9; at += every) ticks.push(at);
  // Evaluations taken but not yet published: the eval lag.
  const pending = ticks.filter((at) => at > last && at <= head);
  const rate = run.stepsPerSecond > 0 ? run.stepsPerSecond : 1;
  const nextWait = next === undefined ? undefined : Math.max(0, next + lag - head) / rate;
  const summary =
    `${last === 0 ? "Baseline evaluated at step 0" : `Evaluated at step ${number(last)}`}` +
    (pending.length ? `; evaluation of step ${number(pending.at(-1)!)} running` : "") +
    (nextWait === undefined
      ? "; final evaluation"
      : `; next results in ${formatDuration(nextWait)}`) +
    `. Evaluated every ${number(every)} steps; each pass publishes ${formatDuration(lag / rate)} of training later.`;
  const H = 34;
  return (
    <div ref={host} className={styles.cadence}>
      <svg width={width} height={H} role="img" aria-label={summary}>
        <line x1={pad} x2={width - pad} y1={14} y2={14} className={styles.cadenceAxis} />
        {ticks.map((at) => (
          <line
            key={at}
            x1={x(at)}
            x2={x(at)}
            y1={10}
            y2={18}
            className={styles.cadenceTick}
          />
        ))}
        {pending.map((at) => (
          <g key={at}>
            <rect
              x={x(at)}
              y={11}
              width={Math.max(1, x(Math.min(hi, at + lag)) - x(at))}
              height={6}
              className={styles.lagWindow}
            />
            <rect
              x={x(at)}
              y={11}
              width={Math.max(0, x(Math.min(head, at + lag)) - x(at))}
              height={6}
              className={styles.lagFill}
            />
            <circle cx={x(at)} cy={14} r={3.5} className={styles.pendingDot} />
          </g>
        ))}
        <circle cx={x(last)} cy={14} r={4} className={styles.publishedDot} />
        <line x1={x(head)} x2={x(head)} y1={3} y2={25} className={styles.headRule} />
        <text x={x(last)} y={H - 1} textAnchor="middle" className={styles.cadenceText}>
          {formatSteps(last)}
        </text>
        {nextWait !== undefined && next !== undefined && x(next) - x(last) > 44 ? (
          <text x={x(next)} y={H - 1} textAnchor="middle" className={styles.cadenceText}>
            {formatSteps(next)}
          </text>
        ) : null}
      </svg>
    </div>
  );
}

/** Each metric's share of the baseline → target distance, across evaluated checkpoints. */
function Slope({
  stage,
  step,
  rows,
  active,
  onActive,
}: {
  readonly stage: Stage;
  readonly step: number;
  readonly rows: readonly Row[];
  readonly active: number | undefined;
  readonly onActive: (index: number | undefined) => void;
}) {
  const [host, width] = useElementWidth<HTMLDivElement>(480);
  const published = lastEvalStep(stage, step);
  const steps = checkpointMarkers(stage, step)
    .filter((at) => at <= published)
    .slice(-SLOPE_POINTS);
  if (steps.length < 2) return <div ref={host} className={styles.slope} />;
  const H = 150;
  const pad = { left: 44, right: 28, top: 10, bottom: 22 };
  const plotW = Math.max(40, width - pad.left - pad.right);
  const plotH = H - pad.top - pad.bottom;
  const x = (i: number) => pad.left + (i / (steps.length - 1)) * plotW;
  const series = rows.map((row) => ({
    row,
    values: steps.map((at) => gapClosed(row.metric, measured(row.metric, stage, at))),
  }));
  const all = series.flatMap((item) => item.values);
  const yMin = Math.min(0, ...all);
  const yMax = Math.max(1.05, ...all);
  const y = (v: number) => pad.top + (1 - (v - yMin) / (yMax - yMin)) * plotH;
  const summary = `Share of the baseline-to-target distance closed at checkpoints ${steps
    .map((at) => number(at))
    .join(", ")}: ${series
    .map(
      (item) =>
        `${item.row.metric.label} ${Math.round((item.values.at(-1) ?? 0) * 100)} percent`,
    )
    .join("; ")}`;
  return (
    <div ref={host} className={styles.slope}>
      <svg
        width={width}
        height={H}
        role="img"
        aria-label={summary}
        onPointerLeave={() => onActive(undefined)}
      >
        {[0, 1].map((v) => (
          <g key={v}>
            <line
              x1={pad.left}
              x2={pad.left + plotW}
              y1={y(v)}
              y2={y(v)}
              className={v === 1 ? styles.goalLine : styles.gridLine}
            />
            <text
              x={pad.left - 6}
              y={y(v) + 3.5}
              textAnchor="end"
              className={styles.axisText}
            >
              {v === 1 ? "target" : "base"}
            </text>
          </g>
        ))}
        {steps.map((at, i) => (
          <g key={at}>
            <line
              x1={x(i)}
              x2={x(i)}
              y1={pad.top}
              y2={pad.top + plotH}
              className={styles.gridLine}
            />
            <text x={x(i)} y={H - 6} textAnchor="middle" className={styles.axisText}>
              {formatSteps(at)}
            </text>
          </g>
        ))}
        {series.map(({ row, values }) => {
          const on = active === undefined || active === row.index;
          return (
            <g
              key={row.metric.label}
              className={styles.slopeLine}
              data-pass={row.pass === undefined ? undefined : row.pass}
              data-dim={on ? undefined : true}
              data-active={active === row.index || undefined}
              onPointerEnter={() => onActive(row.index)}
            >
              <polyline
                points={values
                  .map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
                  .join(" ")}
              />
              <circle cx={x(values.length - 1)} cy={y(values.at(-1) ?? 0)} r={2.5} />
              <text
                x={x(values.length - 1) + 6}
                y={y(values.at(-1) ?? 0) + 3.5}
                className={styles.slopeIndex}
              >
                {row.index + 1}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/**
 * Stage metrics as the evaluation harness last reported them. Values move only when an
 * evaluation completes. Each metric is a bullet chart; the slope chart follows every metric
 * across the evaluated checkpoints.
 */
export function MetricsLiveCard({ stage, step }: LiveCardProps) {
  const evalStep = lastEvalStep(stage, step);
  // Highlight only evaluations that land while the card is open, not the one it opened on.
  const [openedAt] = useState(evalStep);
  const [active, setActive] = useState<number>();
  const fresh = evalStep !== openedAt;
  const evalProgress = evalStep / stage.run.totalSteps;

  const rows: Row[] = stage.metrics.map((metric, index) => {
    const value = metricAtEval(metric, stage, step);
    const history = metricHistory(metric, stage, step, 2);
    return {
      metric,
      index,
      value,
      previous: history.length > 1 ? history[0]!.value : undefined,
      pass: gatePass(metric, value),
    };
  });
  const gated = rows.filter((row) => row.pass !== undefined);
  const passed = gated.filter((row) => row.pass).length;
  const refLabel = stage.id === "distillation" ? "teacher" : "SFT";
  const hasReference = stage.metrics.some(
    (metric) => typeof metric.reference === "number" && metric.reference !== metric.start,
  );

  return (
    <Card
      title={stage.metricsTitle}
      icon="metrics"
      aside={
        <span className={styles.aside}>
          <Chip>held-out</Chip>
          <Chip tone="sim">simulated</Chip>
          {gated.length ? (
            <span
              className={styles.tally}
              aria-label={`${passed} of ${gated.length} gates pass`}
            >
              <b>{passed}</b>/{gated.length}
            </span>
          ) : null}
        </span>
      }
    >
      <Cadence stage={stage} step={step} />

      <ol
        className={styles.rows}
        aria-label={`${stage.metricsTitle} at evaluation ${number(evalStep)}`}
      >
        {rows.map((row) => (
          <li
            key={row.metric.label}
            data-active={active === row.index || undefined}
            onPointerEnter={() => setActive(row.index)}
            onPointerLeave={() => setActive(undefined)}
          >
            <span className={styles.index} aria-hidden="true">
              {row.index + 1}
            </span>
            <span className={styles.label} title={row.metric.label}>
              {row.metric.label}
            </span>
            <Bullet row={row} stage={stage} />
            <span
              key={evalStep}
              className={styles.value}
              data-fresh={fresh || undefined}
              data-pass={row.pass === undefined ? undefined : row.pass}
            >
              {fmt(row.value, row.metric.digits)}
            </span>
            <PassMark pass={row.pass} />
          </li>
        ))}
        {stage.id === "distillation" ? (
          <li>
            <span className={styles.index} aria-hidden="true">
              ·
            </span>
            <span className={styles.label}>INT8 / FP8</span>
            <span className={styles.bullet} aria-hidden="true">
              <span className={styles.track} />
              <i
                className={styles.bar}
                data-pass={evalProgress >= 0.5}
                style={{
                  left: "0%",
                  width: `${Math.min(100, (evalProgress / 0.5) * 100).toFixed(1)}%`,
                }}
              />
              <b className={styles.target} style={{ left: "100%" }} />
            </span>
            <span className={styles.value}>{evalProgress >= 0.5 ? "yes" : "…"}</span>
            <PassMark pass={evalProgress >= 0.5 ? true : undefined} />
          </li>
        ) : null}
      </ol>

      <ul className={styles.key} aria-hidden="true">
        <li>
          <i data-kind="bar" /> baseline → now
        </li>
        <li>
          <i data-kind="target" /> target
        </li>
        {hasReference ? (
          <li>
            <i data-kind="reference" /> {refLabel}
          </li>
        ) : null}
        <li>
          <i data-kind="previous" /> prev eval
        </li>
        <li className={styles.keyNote}>→ better</li>
      </ul>

      <Slope stage={stage} step={step} rows={rows} active={active} onActive={setActive} />
    </Card>
  );
}
