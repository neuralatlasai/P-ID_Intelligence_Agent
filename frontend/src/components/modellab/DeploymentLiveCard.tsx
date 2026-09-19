"use client";

import { measured } from "@/lib/modellab/evaluation";
import {
  deploymentMeasurements,
  LOCAL_ANSWER_TOKENS,
  LOCAL_P95_TARGET_S,
  type DeploymentTarget,
} from "@/lib/modellab/ingestion";
import { formatSteps } from "@/lib/modellab/run";
import type { MetricSpec } from "@/lib/modellab/stages";
import { seriesColour } from "@/lib/series";

import { Card, Chip, PassMark, useElementWidth } from "./Cards";
import local from "./DeploymentLiveCard.module.css";
import type { LiveCardProps } from "./live";

/** KV cache at 32K context, the part of serving memory quantisation does not touch. */
const KV_CACHE_GB = 4.8;
/** Memory budgets of the plant-side GPUs the student is sized for. */
const BUDGETS = [
  { name: "L4", gb: 24 },
  { name: "L40S", gb: 48 },
] as const;
/** The log-latency axis of the distribution chart, in seconds. */
const AXIS: readonly [number, number] = [0.1, 5];
const AXIS_TICKS = [0.1, 0.2, 0.5, 1, 2, 5];
const Z95 = 1.645;

/**
 * Log-normal fitted through a target's measured p50 and p95: the log-latency is Gaussian
 * with μ = ln p50 and σ = ln(p95/p50) / z₀.₉₅. Drawn on a log axis, it is a Gaussian bump.
 */
function fit(target: DeploymentTarget) {
  const mu = Math.log(Math.max(1e-6, target.p50));
  const sigma = Math.max(
    0.02,
    Math.log(Math.max(target.p95, target.p50 * 1.001) / target.p50) / Z95,
  );
  return { mu, sigma };
}

function LatencyRows({ targets }: { readonly targets: readonly DeploymentTarget[] }) {
  const [host, width] = useElementWidth<HTMLDivElement>(420);
  const H = 30;
  const pad = 6;
  const lnLo = Math.log(AXIS[0]);
  const lnHi = Math.log(AXIS[1]);
  const x = (seconds: number) =>
    pad +
    ((Math.log(Math.max(AXIS[0], Math.min(AXIS[1], seconds))) - lnLo) / (lnHi - lnLo)) *
      (width - pad * 2);
  const u = (px: number) =>
    Math.exp(lnLo + ((px - pad) / (width - pad * 2)) * (lnHi - lnLo));
  const slo = x(LOCAL_P95_TARGET_S);

  return (
    <div className={local.latency}>
      {targets.map((target, index) => {
        const { mu, sigma } = fit(target);
        const samples = 64;
        const points: string[] = [];
        const tail: string[] = [];
        for (let i = 0; i <= samples; i += 1) {
          const px = pad + (i / samples) * (width - pad * 2);
          const z = (Math.log(u(px)) - mu) / sigma;
          const py = H - 3 - Math.exp(-0.5 * z * z) * (H - 6);
          points.push(`${px.toFixed(1)},${py.toFixed(1)}`);
          if (px >= slo) tail.push(`${px.toFixed(1)},${py.toFixed(1)}`);
        }
        const area = `${pad},${H - 3} ${points.join(" ")} ${width - pad},${H - 3}`;
        const tailArea = tail.length
          ? `${slo.toFixed(1)},${H - 3} ${tail.join(" ")} ${width - pad},${H - 3}`
          : undefined;
        const colour = seriesColour(index);
        const ok = target.status !== "Pending";
        return (
          <div
            key={target.id}
            className={local.latencyRow}
            data-local={target.id === "local" || undefined}
          >
            <span
              className={local.name}
              title={`${target.name} — ${target.detail}. ${target.gate}`}
            >
              <PassMark pass={ok} />
              <code>{target.name}</code>
            </span>
            <span ref={index === 0 ? host : undefined} className={local.plot}>
              <svg
                width={width}
                height={H}
                role="img"
                aria-label={`${target.name}: p50 ${target.p50.toFixed(2)} s, p95 ${target.p95.toFixed(2)} s, ${target.tokensPerSecond.toFixed(0)} tokens per second, ${target.memoryGb.toFixed(1)} GB; ${target.status} (${target.gate})`}
              >
                <line
                  x1={pad}
                  x2={width - pad}
                  y1={H - 3}
                  y2={H - 3}
                  className={local.axisLine}
                />
                <polygon points={area} fill={colour} className={local.density} />
                <polyline
                  points={points.join(" ")}
                  stroke={colour}
                  className={local.densityLine}
                />
                {target.id === "local" && tailArea ? (
                  <polygon points={tailArea} className={local.tail} />
                ) : null}
                <line
                  x1={x(target.p50)}
                  x2={x(target.p50)}
                  y1={4}
                  y2={H - 3}
                  className={local.p50}
                />
                <line
                  x1={x(target.p95)}
                  x2={x(target.p95)}
                  y1={9}
                  y2={H - 3}
                  className={local.p95}
                />
                <line x1={slo} x2={slo} y1={0} y2={H} className={local.slo} />
              </svg>
            </span>
            <span className={local.nums}>
              <b>{target.tokensPerSecond.toFixed(0)}</b> tok/s
            </span>
            <span className={local.nums}>
              <b>{target.memoryGb.toFixed(1)}</b> GB
            </span>
          </div>
        );
      })}
      <div className={local.latencyRow} aria-hidden="true">
        <span />
        <span className={local.axis}>
          {AXIS_TICKS.map((tick) => (
            <span key={tick} style={{ left: `${x(tick)}px` }}>
              {tick}
            </span>
          ))}
          <span className={local.sloLabel} style={{ left: `${slo}px` }}>
            p95 ≤ {LOCAL_P95_TARGET_S}
          </span>
        </span>
        <span className={local.unit}>s</span>
      </div>
    </div>
  );
}

/** BF16 → INT8 for one serving metric: hollow = BF16 student, solid = now, rule = target. */
function Dumbbell({
  metric,
  label,
  unit,
  now,
  digits,
}: {
  readonly metric: MetricSpec;
  readonly label: string;
  readonly unit: string;
  readonly now: number;
  readonly digits: number;
}) {
  const teacher = typeof metric.reference === "number" ? metric.reference : undefined;
  const values = [metric.start, now, metric.target, teacher].filter(
    (v): v is number => v !== undefined,
  );
  const hi = Math.max(...values) * 1.06;
  const pos = (v: number) => (v / hi) * 100;
  const pass =
    metric.target === undefined
      ? teacher === undefined
        ? undefined
        : metric.direction === "up"
          ? now > teacher
          : now < teacher
      : metric.direction === "up"
        ? now >= metric.target
        : now <= metric.target;
  const a = pos(metric.start);
  const b = pos(now);
  return (
    <div className={local.dumbRow}>
      <span className={local.dumbLabel}>{label}</span>
      <span
        className={local.dumb}
        role="img"
        aria-label={`${metric.label}: BF16 student ${metric.start.toFixed(digits)}, now ${now.toFixed(digits)}${metric.target !== undefined ? `, target ${metric.target}` : ""}${teacher !== undefined ? `, teacher ${teacher}` : ""}`}
      >
        <span className={local.dumbTrack} />
        <i
          style={{
            left: `${Math.min(a, b).toFixed(2)}%`,
            width: `${Math.abs(b - a).toFixed(2)}%`,
          }}
        />
        {metric.target !== undefined ? (
          <b
            className={local.dumbTarget}
            style={{ left: `${pos(metric.target).toFixed(2)}%` }}
          />
        ) : null}
        {teacher !== undefined ? (
          <b
            className={local.dumbTeacher}
            style={{ left: `${pos(teacher).toFixed(2)}%` }}
          />
        ) : null}
        <b className={local.dumbBefore} style={{ left: `${a.toFixed(2)}%` }} />
        <b
          className={local.dumbNow}
          data-pass={pass}
          style={{ left: `${b.toFixed(2)}%` }}
        />
      </span>
      <span className={local.nums}>
        <b>{now.toFixed(digits)}</b> {unit}
      </span>
      <PassMark pass={pass} />
    </div>
  );
}

/**
 * Stage 4 deployment: latency per serving target (a log-normal through each measured p50 and
 * p95) against the local p95 target, and what quantisation-aware fine-tuning changes —
 * BF16 → INT8 W8A16 — on the same evaluation the metrics card reports.
 */
export function DeploymentLiveCard({ stage, step, now }: LiveCardProps) {
  const measuredAt = deploymentMeasurements(stage, step, now);
  const evalStep = measuredAt.evalStep;
  const metric = (prefix: string) => stage.metrics.find((m) => m.label.startsWith(prefix));
  const read = (spec: MetricSpec | undefined) =>
    spec ? measured(spec, stage, evalStep) : undefined;
  const ttft = metric("Time to first token p50");
  const tpot = metric("Time per output token p95");
  const decode = metric("Decode throughput");
  const memory = metric("Serving memory");
  const quantised =
    memory?.from !== undefined && measuredAt.measuredProgress >= memory.from;

  const memBefore = memory?.start ?? 0;
  const memNow = read(memory) ?? memBefore;
  const memMax = Math.max(memBefore, memNow, ...BUDGETS.map((b) => b.gb)) * 1.04;
  const stackRow = (label: string, total: number) => {
    const weights = Math.max(0, total - KV_CACHE_GB);
    return (
      <div className={local.stackRow} key={label}>
        <span className={local.dumbLabel}>{label}</span>
        <span
          className={local.stack}
          role="img"
          aria-label={`${label}: weights ${weights.toFixed(1)} GB plus KV cache ${KV_CACHE_GB} GB at 32K, ${total.toFixed(1)} GB`}
        >
          <i
            data-part="weights"
            style={{ width: `${((weights / memMax) * 100).toFixed(2)}%` }}
          />
          <i
            data-part="kv"
            style={{
              width: `${((Math.min(KV_CACHE_GB, total) / memMax) * 100).toFixed(2)}%`,
            }}
          />
          {BUDGETS.map((budget) => (
            <b
              key={budget.name}
              style={{ left: `${((budget.gb / memMax) * 100).toFixed(2)}%` }}
            />
          ))}
        </span>
        <span className={local.nums}>
          <b>{total.toFixed(1)}</b> GB
        </span>
      </div>
    );
  };

  return (
    <Card
      title="Deployment targets"
      icon="target"
      id="deployment"
      aside={
        <span className={local.aside}>
          <Chip tone="sim">simulated</Chip>
          <Chip>eval {formatSteps(evalStep)}</Chip>
          <Chip tone={quantised ? "ok" : undefined}>{quantised ? "INT8" : "BF16"}</Chip>
        </span>
      }
    >
      <h3 className={local.figureTitle}>
        <span>latency · {LOCAL_ANSWER_TOKENS}-tok answer</span>
      </h3>
      <LatencyRows targets={measuredAt.targets} />

      <h3 className={local.figureTitle}>
        <span>BF16 → INT8 W8A16</span>
      </h3>
      <div className={local.dumbbells}>
        {ttft ? (
          <Dumbbell metric={ttft} label="TTFT p50" unit="ms" now={read(ttft)!} digits={0} />
        ) : null}
        {tpot ? (
          <Dumbbell metric={tpot} label="TPOT p95" unit="ms" now={read(tpot)!} digits={1} />
        ) : null}
        {decode ? (
          <Dumbbell
            metric={decode}
            label="decode"
            unit="tok/s"
            now={read(decode)!}
            digits={0}
          />
        ) : null}
        {memory ? (
          <>
            {stackRow("BF16", memBefore)}
            {stackRow(quantised ? "INT8" : "now", memNow)}
          </>
        ) : null}
      </div>
      <ul className={local.key} aria-hidden="true">
        <li>
          <i data-kind="before" /> BF16
        </li>
        <li>
          <i data-kind="now" /> now
        </li>
        <li>
          <i data-kind="target" /> target
        </li>
        <li>
          <i data-kind="teacher" /> teacher
        </li>
        <li>
          <i data-kind="weights" /> weights
        </li>
        <li>
          <i data-kind="kv" /> KV 32K
        </li>
        <li>
          <i data-kind="budget" /> L4 · L40S
        </li>
      </ul>
    </Card>
  );
}
