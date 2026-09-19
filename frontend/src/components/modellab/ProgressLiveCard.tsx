"use client";

import { evalEvery } from "@/lib/modellab/evaluation";
import { epochPosition } from "@/lib/modellab/ingestion";
import { formatDuration, learningRateAt } from "@/lib/modellab/run";
import type { Stage } from "@/lib/modellab/stages";

import { Card } from "./Cards";
import type { LiveCardProps } from "./live";
import local from "./ProgressLiveCard.module.css";

const number = (value: number) => Math.floor(value).toLocaleString("en-US");

/** 12,345 → "12.3K", 4.1e9 → "4.10B". */
export function compact(value: number): string {
  const abs = Math.abs(value);
  const scale: [number, string][] = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of scale) {
    if (abs >= size) {
      const scaled = value / size;
      return `${scaled.toFixed(scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2)}${suffix}`;
    }
  }
  return value.toFixed(value >= 100 || value === 0 ? 0 : 1);
}

/** Distillation's schedule: logit-matching warm-up, transfer, quantisation-aware tuning, eval. */
const DISTILL_PHASES: readonly (readonly [number, number, string])[] = [
  [0, 0.15, "warm-up"],
  [0.15, 0.7, "KD"],
  [0.7, 0.9, "QAT"],
  [0.9, 1, "eval"],
];

/** Every `every` steps up to `total`, thinned to at most `limit` marks. */
function marks(total: number, every: number, limit: number): number[] {
  const stride =
    Math.max(1, every) * Math.max(1, Math.ceil(total / Math.max(1, every) / limit));
  const out: number[] = [];
  for (let at = stride; at <= total; at += stride) out.push(at);
  return out;
}

const R = 58;
const C = 72;

/** A point on the ring at `share` of a full turn, from 12 o'clock clockwise. */
function polar(share: number, radius: number): [number, number] {
  const angle = share * Math.PI * 2 - Math.PI / 2;
  return [C + radius * Math.cos(angle), C + radius * Math.sin(angle)];
}

function arc(from: number, to: number, radius: number): string {
  const span = Math.max(0, Math.min(0.9999, to - from));
  const [x0, y0] = polar(from, radius);
  const [x1, y1] = polar(from + span, radius);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${radius} ${radius} 0 ${span > 0.5 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function epochBoundaries(stage: Stage, globalBatch: number): number[] {
  const { datasetSize } = epochPosition(stage, 0, globalBatch);
  if (datasetSize <= 0) return [];
  const perEpoch = datasetSize / Math.max(1, globalBatch);
  const epochs = stage.run.totalSteps / perEpoch;
  if (epochs < 1.2 || epochs > 24) return [];
  const out: number[] = [];
  for (let k = 1; k * perEpoch < stage.run.totalSteps; k += 1) out.push(k * perEpoch);
  return out;
}

export function ProgressLiveCard({
  stage,
  step,
  progress,
  now,
  running,
  config,
  profile,
}: LiveCardProps) {
  const { run } = stage;
  const total = run.totalSteps;
  const rate = Math.max(1e-9, run.stepsPerSecond);
  const share = Math.min(1, Math.max(0, progress));
  const complete = step >= total;
  const remainingSeconds = Math.max(0, (total - step) / rate);
  const elapsedSeconds = step / rate;
  const percent = Math.floor(share * 100);

  // Checkpoints and evaluations, on the ring and the timeline alike.
  const checkpointMarks = marks(total, run.checkpointEvery, 48);
  const evalMarks =
    evalEvery(stage) === run.checkpointEvery ? [] : marks(total, evalEvery(stage), 96);
  const sinceCheckpoint = step % run.checkpointEvery;
  const nextCheckpoint = Math.min(total, step - sinceCheckpoint + run.checkpointEvery);
  const checkpointShare = complete ? 1 : sinceCheckpoint / run.checkpointEvery;
  const checkpointEta = (nextCheckpoint - step) / rate;
  const epochs = epochBoundaries(stage, config.globalBatch);
  const position = epochPosition(stage, step, config.globalBatch);

  // Consumption so far.
  const samplesSeen = step * config.globalBatch;
  const tokensSeen = samplesSeen * profile.tokensPerSample;
  const gpuHours = (elapsedSeconds / 3600) * profile.gpus;
  const rollouts = stage.id === "rl" ? Math.floor(step) * (run.rolloutsPerStep ?? 1) : 0;

  // Learning-rate schedule across the whole run, for the timeline.
  const LR_POINTS = 120;
  const peak = Math.max(1e-12, run.learningRate);
  const lrPath = Array.from({ length: LR_POINTS + 1 }, (_, index) => {
    const at = (total * index) / LR_POINTS;
    const x = (index / LR_POINTS) * 100;
    const y = 30 - (learningRateAt(run, at) / peak) * 26;
    return `${index ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join("");
  const lrNow = learningRateAt(run, step);

  const finish = new Date(now + remainingSeconds * 1000);
  const finishLabel = finish.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const eta = complete ? "done" : formatDuration(remainingSeconds);

  const ringLabel = `${stage.progressTitle}: ${percent} percent, step ${number(step)} of ${number(total)}; ${complete ? "complete" : `${eta} remaining${running ? "" : " while paused"}, next checkpoint at step ${number(nextCheckpoint)} in ${formatDuration(checkpointEta)}`}.`;
  const timelineLabel = `Run timeline: learning rate ${lrNow.toExponential(1)} now, peak ${peak.toExponential(1)}, warm-up ${number(run.warmupSteps)} steps; ${checkpointMarks.length} checkpoint marks${epochs.length ? `, ${epochs.length + 1} epochs` : ""}${stage.id === "distillation" ? "; schedule warm-up, KD, QAT, eval" : ""}.`;
  const at = (value: number) => `${(Math.min(total, Math.max(0, value)) / total) * 100}%`;

  return (
    <Card
      title={stage.progressTitle}
      icon="pulse"
      className={local.card}
      aside={<span className={local.simChip}>Simulated run</span>}
    >
      <div className={local.body} data-running={running || undefined}>
        <span className={local.fig}>FIGURE 04H · PROGRESS</span>
        <div className={local.top}>
          <svg
            className={local.ring}
            viewBox="0 0 144 144"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={ringLabel}
          >
            <circle className={local.track} cx={C} cy={C} r={R} />
            <path className={local.done} d={arc(0, share, R)} />
            {/* Checkpoint writes: bright once written. */}
            {checkpointMarks.map((mark) => {
              const [x0, y0] = polar(mark / total, R - 6);
              const [x1, y1] = polar(mark / total, R + 6);
              return (
                <line
                  key={`c${mark}`}
                  className={local.checkpoint}
                  data-written={mark <= step || undefined}
                  x1={x0}
                  y1={y0}
                  x2={x1}
                  y2={y1}
                />
              );
            })}
            {epochs.map((mark) => {
              const [x0, y0] = polar(mark / total, R - 10);
              const [x1, y1] = polar(mark / total, R + 10);
              return (
                <line
                  key={`e${mark}`}
                  className={local.epoch}
                  x1={x0}
                  y1={y0}
                  x2={x1}
                  y2={y1}
                />
              );
            })}
            {/* Inner ring: the interval to the next checkpoint. */}
            <circle className={local.track} cx={C} cy={C} r={R - 12} data-inner />
            <path className={local.interval} d={arc(0, checkpointShare, R - 12)} />
            {(() => {
              const [x, y] = polar(share, R);
              return <circle className={local.head} cx={x} cy={y} r={3.2} />;
            })()}
            <text className={local.percent} x={C} y={C - 2} textAnchor="middle">
              {percent}
              <tspan className={local.percentUnit}>%</tspan>
            </text>
            <text className={local.etaText} x={C} y={C + 16} textAnchor="middle">
              {complete ? "complete" : `ETA ${eta}`}
            </text>
          </svg>

          <dl className={local.readout}>
            <div>
              <dt>step</dt>
              <dd>
                {number(step)}
                <small> / {number(total)}</small>
              </dd>
            </div>
            <div>
              <dt>ckpt</dt>
              <dd>
                {complete ? "—" : number(nextCheckpoint)}
                <small>{complete ? "" : ` · ${formatDuration(checkpointEta)}`}</small>
              </dd>
            </div>
            <div>
              <dt>finish</dt>
              <dd>
                {complete ? "—" : finishLabel}
                {!running && !complete ? <small> · paused</small> : null}
              </dd>
            </div>
            {epochs.length > 0 ? (
              <div>
                <dt>epoch</dt>
                <dd>
                  {Math.min(epochs.length + 1, position.epoch - 1 + position.share).toFixed(
                    2,
                  )}
                  <small> / {epochs.length + 1}</small>
                </dd>
              </div>
            ) : null}
            {stage.id === "rl" ? (
              <div>
                <dt>rollouts</dt>
                <dd>
                  {compact(rollouts)}
                  <small>
                    {" "}
                    / {compact(run.rolloutsTotal ?? total * (run.rolloutsPerStep ?? 1))}
                  </small>
                </dd>
              </div>
            ) : null}
            <div>
              <dt>samples</dt>
              <dd>{compact(samplesSeen)}</dd>
            </div>
            <div>
              <dt>tokens</dt>
              <dd>{compact(tokensSeen)}</dd>
            </div>
            <div>
              <dt>GPU·h</dt>
              <dd>
                {compact(gpuHours)}
                <small> · {profile.gpus} GPU</small>
              </dd>
            </div>
          </dl>
        </div>

        <div className={local.timeline} role="img" aria-label={timelineLabel}>
          <svg viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">
            <path className={local.lrArea} d={`${lrPath}L100 32L0 32Z`} />
            <path className={local.lrLine} d={lrPath} vectorEffect="non-scaling-stroke" />
          </svg>
          <span className={local.past} style={{ width: at(step) }} aria-hidden="true" />
          {stage.id === "distillation" &&
            DISTILL_PHASES.map(([from, to, label]) => (
              <span
                key={label}
                className={local.band}
                data-current={(share >= from && share < to) || undefined}
                style={{ left: `${from * 100}%`, width: `${(to - from) * 100}%` }}
                aria-hidden="true"
              >
                {label}
              </span>
            ))}
          {evalMarks.map((mark) => (
            <i
              key={`v${mark}`}
              className={local.evalMark}
              data-done={mark <= step || undefined}
              style={{ left: at(mark) }}
              aria-hidden="true"
            />
          ))}
          {checkpointMarks.map((mark) => (
            <i
              key={`k${mark}`}
              className={local.ckptMark}
              data-done={mark <= step || undefined}
              style={{ left: at(mark) }}
              aria-hidden="true"
            />
          ))}
          {epochs.map((mark) => (
            <i
              key={`p${mark}`}
              className={local.epochMark}
              style={{ left: at(mark) }}
              aria-hidden="true"
            />
          ))}
          <i className={local.headMark} style={{ left: at(step) }} aria-hidden="true" />
        </div>
        <div className={local.axis} aria-hidden="true">
          <span>0</span>
          <span>
            LR {lrNow.toExponential(1)} <small>peak {peak.toExponential(1)}</small>
          </span>
          <span>{compact(total)}</span>
        </div>
      </div>
    </Card>
  );
}
