"use client";

import type { ReactNode } from "react";

import { hashString } from "@/lib/canvas/engineering";
import { lastEvalStep, metricAtEval } from "@/lib/modellab/evaluation";
import { checkpointLifecycle } from "@/lib/modellab/events";
import { epochPosition } from "@/lib/modellab/ingestion";
import { curveAt, formatDuration, formatSteps, learningRateAt } from "@/lib/modellab/run";

import { Card } from "./Cards";
import type { LiveCardProps } from "./live";
import styles from "./ModelLab.module.css";
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

function clockTime(epoch: number): string {
  const date = new Date(epoch);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function phaseOf(progress: number): string {
  if (progress < 0.15) return "Logit matching warm-up";
  if (progress < 0.7) return "Knowledge transfer training";
  if (progress < 0.9) return "Quantization-aware fine-tuning";
  if (progress < 1) return "Edge evaluation";
  return "Complete";
}

const THROUGHPUT_POINTS = 60;
const THROUGHPUT_BUCKET_MS = 10_000;

function Sparkline({
  values,
  label,
  tone,
}: {
  readonly values: readonly number[];
  readonly label: string;
  readonly tone: "blue" | "green";
}) {
  const width = 120;
  const height = 30;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.max(Math.abs(max), 1);
  const points = values.map((value, index) => {
    const x = values.length > 1 ? (index / (values.length - 1)) * width : 0;
    const y = height - 2 - ((value - min) / span) * (height - 4);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = points.at(-1)?.split(",") ?? ["0", "0"];
  return (
    <svg
      className={local.spark}
      data-tone={tone}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <polyline points={`0,${height} ${points.join(" ")} ${width},${height}`} data-fill />
      <polyline points={points.join(" ")} data-line />
      <circle cx={last[0]} cy={last[1]} r={2.2} />
    </svg>
  );
}

export function ProgressLiveCard({
  stage,
  step,
  progress,
  now,
  running,
  config,
  profile,
  livePass,
}: LiveCardProps & {
  /** Rollouts of the sample carousel that passed the verifier just now. */
  readonly livePass: { readonly passed: number; readonly total: number };
}) {
  const { run } = stage;
  const rate = Math.max(1e-9, run.stepsPerSecond);
  const complete = step >= run.totalSteps;
  const percent = Math.floor(Math.min(1, progress) * 100);
  const remainingSeconds = (run.totalSteps - step) / rate;
  const remaining = complete
    ? "—"
    : running
      ? formatDuration(remainingSeconds)
      : `${formatDuration(remainingSeconds)} (paused)`;
  const elapsedSeconds = step / rate;
  const primary = stage.curves[0]!.curves[0]!;

  const rows: [string, ReactNode][] = [];
  let headline: ReactNode = `Step ${number(step)} / ${number(run.totalSteps)}`;
  // Every figure below is read from the same source as the card that owns it: checkpoint
  // values from the checkpoint table, scores from the last published evaluation, epochs
  // from the data contract and the applied global batch.
  const lifecycle = checkpointLifecycle(stage, step, rate, now);
  const latest = lifecycle.records[0];
  const best = lifecycle.best;
  const evalStep = lastEvalStep(stage, step);
  const evalNote = <span className={local.muted}> · eval @ {number(evalStep)}</span>;
  const position = epochPosition(stage, step, config.globalBatch);
  const plannedEpochs = position.datasetSize
    ? (run.totalSteps * config.globalBatch) / position.datasetSize
    : (run.epochs ?? 1);
  const epochValue = position.epoch - 1 + position.share;
  const epochText = `${Math.min(epochValue, plannedEpochs).toFixed(2)} / ${plannedEpochs.toFixed(Math.abs(plannedEpochs - Math.round(plannedEpochs)) < 0.05 ? 0 : 1)}`;

  if (stage.id === "pretraining") {
    rows.push(
      ["Elapsed", formatDuration(elapsedSeconds)],
      ["Remaining", remaining],
      ["Train loss", curveAt(primary, step).toFixed(3)],
      [
        "Best checkpoint",
        best ? `val ${best.valLoss.toFixed(3)} @ ${formatSteps(best.step)}` : "—",
      ],
      ["Learning rate", learningRateAt(run, step).toExponential(1)],
    );
  } else if (stage.id === "sft") {
    const score = stage.metrics[0]!;
    rows.push(
      ["Epoch", epochText],
      [
        "Grounding mAP",
        <>
          {metricAtEval(score, stage, step).toFixed(3)}
          {evalNote}
        </>,
      ],
      [
        "Val loss",
        latest ? `${latest.valLoss.toFixed(3)} @ ${formatSteps(latest.step)}` : "—",
      ],
      ["ETA", remaining],
    );
  } else if (stage.id === "rl") {
    const reward = primary;
    const kl = stage.curves
      .flatMap((tab) => tab.curves)
      .find((curve) => curve.key === "kl" && !curve.dashed);
    const mean = curveAt(reward, step);
    const passMetric = stage.metrics[0]!;
    const perStep = run.rolloutsPerStep ?? 1;
    headline = null;
    rows.push(
      [
        "Rollouts",
        `${number(Math.floor(step) * perStep)} / ${number(run.rolloutsTotal ?? run.totalSteps * perStep)}`,
      ],
      [
        "Mean reward",
        <>
          {mean.toFixed(3)}{" "}
          <span className={styles.up}>↑ +{(mean - reward.start).toFixed(2)}</span>
        </>,
      ],
      [
        "KL vs init",
        kl ? (
          <>
            {curveAt(kl, step).toFixed(4)}{" "}
            <span className={local.muted}>(target 0.020)</span>
          </>
        ) : (
          "—"
        ),
      ],
      [
        "Verifier pass@1",
        <>
          {metricAtEval(passMetric, stage, step).toFixed(2)}
          {evalNote}
          {livePass.total > 0 && (
            <span className={local.muted}>
              {" "}
              · live {livePass.passed}/{livePass.total}
            </span>
          )}
        </>,
      ],
      ["ETA", remaining],
    );
  } else {
    headline = `Epoch ${epochText}`;
    rows.push(
      [
        "Retention",
        <>
          {metricAtEval(stage.metrics[0]!, stage, step).toFixed(3)}
          {evalNote}
        </>,
      ],
      [
        "Best checkpoint",
        best
          ? `KL ${best.valLoss.toFixed(3)} @ ${formatSteps(best.step)}${best.evalScore === undefined ? "" : ` · retention ${best.evalScore.toFixed(3)}`}`
          : "—",
      ],
      ["ETA", remaining],
      ["Phase", phaseOf(progress)],
    );
  }

  // Volume and cost of what the run has consumed so far.
  const samplesSeen = step * config.globalBatch;
  const tokensSeen = samplesSeen * profile.tokensPerSample;
  const gpuHours = (elapsedSeconds / 3600) * profile.gpus;

  // Next checkpoint countdown.
  const sinceCheckpoint = step % run.checkpointEvery;
  const nextCheckpoint = Math.min(
    run.totalSteps,
    step - sinceCheckpoint + run.checkpointEvery,
  );
  const checkpointShare = complete ? 1 : sinceCheckpoint / run.checkpointEvery;
  const checkpointEta = (nextCheckpoint - step) / rate;

  // Throughput over the last ten minutes, one reading per ten seconds.
  const samplesPerSecond = rate * config.globalBatch;
  const bucketNow = Math.floor(now / THROUGHPUT_BUCKET_MS);
  const throughput = Array.from({ length: THROUGHPUT_POINTS }, (_, offset) => {
    const bucket = bucketNow - (THROUGHPUT_POINTS - 1 - offset);
    if (!running) return 0;
    const noise = hashString(`${stage.experimentId}:throughput:${bucket}`) / 4294967296;
    return samplesPerSecond * (1 + (noise * 2 - 1) * 0.03);
  });
  const currentThroughput = throughput.at(-1) ?? 0;

  // Primary curve over the last two checkpoint intervals.
  const lossWindow = Math.min(step, run.checkpointEvery * 2);
  const lossSeries = Array.from({ length: 40 }, (_, index) =>
    curveAt(primary, Math.max(0, step - lossWindow + (lossWindow * index) / 39)),
  );
  const lossNow = lossSeries.at(-1) ?? 0;
  const lossDigits = lossNow < 0.1 ? 4 : 3;

  return (
    <Card
      title={stage.progressTitle}
      icon="pulse"
      className={`${styles.progressCard} ${local.card}`}
      aside={
        <span
          className={local.simChip}
          title="No accelerator is attached; the run is simulated"
        >
          Simulated run
        </span>
      }
    >
      <div className={local.body}>
        <div>
          <div className={styles.progressHead}>
            {headline ? <strong>{headline}</strong> : <span />}
            <span>{percent}%</span>
          </div>
          <div
            className={styles.progressBar}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={`${stage.progressTitle}: ${percent} percent`}
            data-running={running || undefined}
          >
            <i style={{ width: `${(Math.min(1, progress) * 100).toFixed(2)}%` }} />
          </div>
          <dl className={styles.kv} data-compact>
            {rows.map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <dl className={local.stats}>
          <div>
            <dt>Samples seen</dt>
            <dd>{compact(samplesSeen)}</dd>
          </div>
          <div>
            <dt>Tokens seen</dt>
            <dd>{compact(tokensSeen)}</dd>
          </div>
          <div>
            <dt>GPU-hours</dt>
            <dd>
              {compact(gpuHours)}
              <small> · {profile.gpus} GPUs</small>
            </dd>
          </div>
        </dl>

        <div className={local.countdown}>
          <div className={local.countdownHead}>
            <span>Next checkpoint</span>
            <strong>
              {complete
                ? "Run complete"
                : `${formatSteps(nextCheckpoint)} in ${formatDuration(checkpointEta)}${running ? "" : " (paused)"}`}
            </strong>
          </div>
          <div
            className={local.countdownBar}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(checkpointShare * 100)}
            aria-label={`Progress to next checkpoint: ${Math.round(checkpointShare * 100)} percent`}
          >
            <i style={{ width: `${(checkpointShare * 100).toFixed(1)}%` }} />
          </div>
        </div>

        <div className={local.sparks}>
          <figure>
            <figcaption>
              <span>Throughput · 10 min</span>
              <strong>
                {currentThroughput >= 10
                  ? currentThroughput.toFixed(0)
                  : currentThroughput.toFixed(1)}{" "}
                samples/s
              </strong>
            </figcaption>
            <Sparkline
              values={throughput}
              tone="blue"
              label={
                running
                  ? `Throughput over the last 10 minutes, about ${samplesPerSecond.toFixed(1)} samples per second`
                  : "Throughput over the last 10 minutes: paused, no samples processed"
              }
            />
          </figure>
          <figure>
            <figcaption>
              <span>
                {primary.label} · {formatSteps(lossWindow)} steps
              </span>
              <strong>{lossNow.toFixed(lossDigits)}</strong>
            </figcaption>
            <Sparkline
              values={lossSeries}
              tone="green"
              label={`${primary.label} over the last ${number(lossWindow)} steps, now ${lossNow.toFixed(lossDigits)}`}
            />
          </figure>
        </div>

        <p className={local.footer}>
          <span className={local.fresh} data-running={running || undefined}>
            <i aria-hidden="true" />
            Updated <time dateTime={new Date(now).toISOString()}>{clockTime(now)}</time>
          </span>
          <span>
            {compact(running ? samplesPerSecond * profile.tokensPerSample : 0)} tok/s ·{" "}
            {profile.accelerator.name.split(" ")[0]}
          </span>
        </p>
      </div>
    </Card>
  );
}
