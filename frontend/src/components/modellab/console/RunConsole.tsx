"use client";

import { useMemo, useRef, useState } from "react";

import type { RunConfig, RunProfile } from "@/lib/modellab/config";
import {
  incidentsBetween,
  recentIncidents,
  type Incident,
  type IncidentKind,
} from "@/lib/modellab/incidents";
import {
  curveAt,
  formatDuration,
  REPLAY_SPEEDS,
  stepAt,
  type RunControl,
} from "@/lib/modellab/run";
import type { Stage, StageId } from "@/lib/modellab/stages";
import {
  frameSource,
  goodput,
  historyLines,
  logTail,
  LOG_FORMAT,
  MAX_GRAD_NORM,
  median,
  PHASES,
  sampleSteps,
  type LogFilter,
  type StepFrame,
} from "@/lib/modellab/telemetry";

import { IncidentStrip, INCIDENT_LABEL } from "./IncidentStrip";
import { LiveLog } from "./LiveLog";
import css from "./RunConsole.module.css";
import { SignalChart, formatStep, type ChartSeries } from "./SignalChart";
import { PHASE_COLOUR, StepAnatomy } from "./StepAnatomy";
import { useFrameClock } from "./useFrameClock";

type Window =
  | { readonly kind: "run" }
  | { readonly kind: "recent" }
  | { readonly kind: "live" }
  | { readonly kind: "inspect"; readonly incident: Incident };

const DIALECT: Record<StageId, string> = {
  pretraining: "torchtitan · FSDP2",
  sft: "TRL SFTTrainer · FSDP2",
  rl: "verl · FSDP2 actor, vLLM rollout",
  distillation: "torchtitan · FSDP2 · frozen teacher",
};

const SPEED_LABEL: Record<number, string> = { 1: "Real time", 60: "60×", 600: "600×" };

interface Tile {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
  /** Values over recent steps, oldest first, for the sparkline. */
  readonly trend?: readonly number[];
  readonly note?: string;
  readonly alert?: boolean;
}

const num = (value: number, digits: number) =>
  Number.isFinite(value) ? value.toFixed(digits) : "nan";
const grouped = (value: number) => Math.round(value).toLocaleString("en-US");

/** Micro-batches per rank per optimiser step: global batch over data-parallel ranks. */
function accumulation(config: RunConfig, gpus: number): number {
  const perRank = config.globalBatch / Math.max(1, gpus);
  const micro = perRank > 8 ? 2 : 1;
  return Math.max(1, Math.round(perRank / micro));
}

function Sparkline({ values }: { readonly values: readonly number[] }) {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 2) return null;
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  const span = hi - lo || Math.abs(hi) || 1;
  const d = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 100;
      const y = Number.isFinite(value) ? 22 - ((value - lo) / span) * 20 : 22;
      return `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join("");
  return (
    <svg viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
      <path d={d} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function tilesFor(
  stage: Stage,
  frames: readonly StepFrame[],
  current: StepFrame,
  remainingSeconds: number,
  goodputShare: number,
): Tile[] {
  const trend = (pick: (frame: StepFrame) => number) => frames.slice(-60).map(pick);
  const stepMedian =
    median(frames.map((frame) => frame.stepSeconds)) ?? current.stepSeconds;
  const eta: Tile = {
    id: "eta",
    label: "Time remaining",
    value: remainingSeconds > 0 ? formatDuration(remainingSeconds) : "complete",
    note: "at planned throughput",
  };
  const stepTime: Tile = {
    id: "step-time",
    label: stage.id === "rl" ? "timing_s/step" : "Step time",
    value: num(current.stepSeconds, current.stepSeconds >= 100 ? 0 : 1),
    unit: "s",
    trend: trend((frame) => frame.stepSeconds),
    note: `median ${num(stepMedian, stepMedian >= 100 ? 0 : 1)} s`,
    alert: current.stepSeconds > stepMedian * 1.5,
  };
  const gradNorm: Tile = {
    id: "grad-norm",
    label: "grad_norm",
    value: num(current.gradNorm, 3),
    trend: trend((frame) => frame.gradNorm),
    note: current.skipped
      ? "non-finite · step skipped"
      : current.clipped
        ? `clipped at ${MAX_GRAD_NORM.toFixed(1)}`
        : `max_norm ${MAX_GRAD_NORM.toFixed(1)}`,
    alert: current.clipped || current.skipped,
  };
  const mfu: Tile = {
    id: "mfu",
    label: "MFU",
    value: num(current.mfu * 100, 1),
    unit: "%",
    trend: trend((frame) => frame.mfu),
    note: `${num(current.tflopsPerGpu, 0)} TFLOP/s per GPU`,
  };
  const good: Tile = {
    id: "goodput",
    label: "Goodput",
    value: num(goodputShare * 100, 1),
    unit: "%",
    note: `last ${frames.length} steps`,
    alert: goodputShare < 0.9,
  };
  const loss = (label: string): Tile => ({
    id: "loss",
    label,
    value: num(current.loss, 4),
    trend: trend((frame) => frame.loss),
    note: "training batch",
  });

  switch (stage.id) {
    case "sft":
      return [
        loss("loss"),
        {
          id: "accuracy",
          label: "mean_token_accuracy",
          value: num(current.meanTokenAccuracy ?? 0, 4),
          trend: trend((frame) => frame.meanTokenAccuracy ?? 0),
          note: "supervised tokens",
        },
        {
          id: "epoch",
          label: "epoch",
          value: num(current.epoch ?? 0, 2),
          note: `of ${stage.run.epochs ?? 1}`,
        },
        gradNorm,
        stepTime,
        mfu,
        good,
        eta,
      ];
    case "rl": {
      const rl = current.rl!;
      return [
        {
          id: "score",
          label: "critic/score/mean",
          value: num(rl.scoreMean, 3),
          trend: trend((frame) => frame.rl?.scoreMean ?? 0),
          note: "verifier-weighted reward",
        },
        {
          id: "entropy",
          label: "actor/entropy",
          value: num(rl.entropy, 3),
          trend: trend((frame) => frame.rl?.entropy ?? 0),
          note: rl.entropy < 0.2 ? "near collapse" : "token-level",
          alert: rl.entropy < 0.2,
        },
        {
          id: "kl",
          label: "actor/kl_loss",
          value: num(rl.klLoss, 4),
          trend: trend((frame) => frame.rl?.klLoss ?? 0),
          note: "k3 vs frozen reference",
          alert: rl.klLoss > 0.035,
        },
        {
          id: "length",
          label: "response_length/mean",
          value: grouped(rl.responseLengthMean),
          unit: "tok",
          trend: trend((frame) => frame.rl?.responseLengthMean ?? 0),
          note: `clip ratio ${num(rl.responseClipRatio * 100, 1)}%`,
        },
        {
          id: "zero-var",
          label: "Zero-variance groups",
          value: num(rl.zeroVarianceGroups * 100, 0),
          unit: "%",
          trend: trend((frame) => frame.rl?.zeroVarianceGroups ?? 0),
          note: "no within-group signal",
          alert: rl.zeroVarianceGroups > 0.45,
        },
        {
          id: "clipfrac",
          label: "actor/pg_clipfrac",
          value: num(rl.pgClipfrac, 4),
          trend: trend((frame) => frame.rl?.pgClipfrac ?? 0),
          note: "ratio outside [1−ε, 1+ε]",
        },
        stepTime,
        eta,
      ];
    }
    case "distillation":
      return [
        loss("loss"),
        {
          id: "kl",
          label: "Forward KL",
          value: num(current.klTerm ?? 0, 4),
          trend: trend((frame) => frame.klTerm ?? 0),
          note: "KL(teacher ‖ student)",
        },
        {
          id: "ce",
          label: "CE",
          value: num(current.ceTerm ?? 0, 4),
          trend: trend((frame) => frame.ceTerm ?? 0),
          note: "on verified traces",
        },
        gradNorm,
        stepTime,
        mfu,
        good,
        eta,
      ];
    default:
      return [
        loss("loss"),
        gradNorm,
        stepTime,
        mfu,
        {
          id: "tps",
          label: "Tokens / s / GPU",
          value: grouped(current.tokensPerSecondPerGpu),
          trend: trend((frame) => frame.tokensPerSecondPerGpu),
          note: `${grouped((current.tokensPerSecondPerGpu * 3600) / 1e6)}M tokens / GPU-hour`,
        },
        {
          id: "memory",
          label: "Memory",
          value: num(current.memoryGiB, 1),
          unit: "GiB",
          note: `${num(current.memoryShare * 100, 1)}% of device`,
        },
        good,
        eta,
      ];
  }
}

export function RunConsole({
  stage,
  profile,
  config,
  control,
  now,
  running,
  blocked,
  speed,
  onSpeed,
}: {
  readonly stage: Stage;
  readonly profile: RunProfile;
  readonly config: RunConfig;
  readonly control: RunControl;
  readonly now: number;
  readonly running: boolean;
  readonly blocked: boolean;
  readonly speed: number;
  readonly onSpeed: (speed: number) => void;
}) {
  const root = useRef<HTMLElement>(null);
  const clock = useFrameClock(running, now, root);
  const total = stage.run.totalSteps;
  const exact = blocked ? 0 : stepAt(control, stage.run, clock);
  const current = Math.floor(exact);
  const fraction = exact - current;

  const context = useMemo(() => ({ stage, profile, config }), [stage, profile, config]);
  const source = useMemo(() => frameSource(context), [context]);

  const [view, setView] = useState<Window>({ kind: "recent" });
  const [hover, setHover] = useState<number | null>(null);
  const [filter, setFilter] = useState<LogFilter>("all");

  const inProgress = source.frame(Math.min(total, current + 1));
  const recent = useMemo(() => {
    const frames: StepFrame[] = [];
    for (let at = Math.max(1, current - 99); at <= current; at += 1)
      frames.push(source.frame(at));
    return frames;
  }, [source, current]);
  const latest = recent.at(-1) ?? inProgress;

  // ── chart window ─────────────────────────────────────────────────────────────────────
  const domain: readonly [number, number] = (() => {
    switch (view.kind) {
      case "run":
        return [0, total];
      case "live":
        return [Math.max(0, exact - 200), Math.max(200, exact)];
      case "inspect": {
        const lo = Math.max(0, view.incident.step - 150);
        return [lo, Math.min(Math.max(current, lo + 50), view.incident.step + 300)];
      }
      default:
        return [Math.max(0, exact - 2000), Math.max(Math.min(2000, total), exact)];
    }
  })();
  const sampleHi = Math.min(current, Math.floor(domain[1]));
  const sampleLo = Math.max(1, Math.ceil(domain[0]));
  const steps = useMemo(
    () => (sampleHi >= sampleLo ? sampleSteps(stage, sampleLo, sampleHi, 360) : []),
    [stage, sampleLo, sampleHi],
  );
  const frames = useMemo(() => steps.map((at) => source.frame(at)), [steps, source]);

  const primary = stage.curves[0]!.curves[0]!;
  // A held-out objective plotted beside the training one (supervised fine-tuning's eval
  // loss) shows the train/eval divergence of the final epoch in the console itself.
  const heldout = stage.curves[0]!.curves.find((curve) => curve.evaluation && curve.dashed);
  const lossSeries: ChartSeries[] = [
    {
      key: "primary",
      label: stage.id === "rl" ? "critic/score/mean" : "loss",
      colour: "var(--series-1)",
      points: frames.map((frame) => ({ step: frame.step, value: frame.loss })),
      smooth: true,
    },
    ...(heldout
      ? [
          {
            key: heldout.key,
            label: "eval_loss",
            colour: "var(--series-2)",
            points: frames.map((frame) => ({
              step: frame.step,
              value: curveAt(heldout, frame.step, stage),
            })),
            dashed: true,
          },
        ]
      : []),
  ];
  const secondSeries: ChartSeries[] =
    stage.id === "rl"
      ? [
          {
            key: "kl",
            label: "actor/kl_loss",
            colour: "var(--series-4)",
            points: frames.map((frame) => ({
              step: frame.step,
              value: frame.rl?.klLoss ?? 0,
            })),
            smooth: true,
          },
        ]
      : [
          {
            key: "grad",
            label: "grad_norm",
            colour: "var(--series-2)",
            points: frames.map((frame) => ({ step: frame.step, value: frame.gradNorm })),
            smooth: true,
          },
        ];
  const timeSeries: ChartSeries[] = PHASES[stage.id].map((phase) => ({
    key: phase.id,
    label: phase.label,
    colour: PHASE_COLOUR[phase.id]!,
    points: frames.map((frame) => ({
      step: frame.step,
      value: frame.phases.find((item) => item.id === phase.id)?.seconds ?? 0,
    })),
  }));

  // Each chart marks only the incidents that move its own signal: a loader stall has no
  // business on the loss chart, and a loss spike none on the step-time breakdown.
  const markers = useMemo(() => {
    const incidents = incidentsBetween(stage, sampleLo, Math.max(sampleLo, sampleHi));
    const pick = (kinds: readonly IncidentKind[]) =>
      incidents
        .filter((incident) => kinds.includes(incident.kind))
        .map((incident) => ({
          id: incident.id,
          step: incident.step,
          severity: incident.severity,
          label: `${INCIDENT_LABEL[incident.kind]} · step ${incident.step.toLocaleString("en-US")}`,
        }));
    return {
      signal: pick([
        "loss-spike",
        "nonfinite-skip",
        "job-restart",
        "kl-excursion",
        "entropy-drop",
      ]),
      second: pick(
        stage.id === "rl"
          ? ["kl-excursion"]
          : ["loss-spike", "grad-clip-burst", "nonfinite-skip"],
      ),
      time: pick([
        "loader-stall",
        "straggler",
        "slow-collective",
        "job-restart",
        "rollout-tail",
        "teacher-queue",
      ]),
    };
  }, [stage, sampleLo, sampleHi]);
  const checkpoints = useMemo(() => {
    const every = Math.max(1, stage.run.checkpointEvery);
    const list: number[] = [];
    for (let at = Math.ceil(sampleLo / every) * every; at <= sampleHi; at += every)
      list.push(at);
    return list;
  }, [stage, sampleLo, sampleHi]);

  const runIncidents = useMemo(
    () => recentIncidents(stage, current, 400),
    [stage, current],
  );

  // ── log ──────────────────────────────────────────────────────────────────────────────
  const lines = useMemo(
    () =>
      filter === "all"
        ? logTail(source, current, 60)
        : historyLines(source, current, filter, 60),
    [source, current, filter],
  );

  const remaining = (total - exact) / Math.max(1e-9, stage.run.stepsPerSecond);
  const tiles = tilesFor(stage, recent, latest, remaining, goodput(context, recent));
  const status = blocked
    ? "Blocked"
    : exact >= total
      ? "Complete"
      : running
        ? "Training"
        : "Paused";

  const inspecting = view.kind === "inspect" ? view.incident : undefined;
  const format = (digits: number) => (value: number) => num(value, digits);

  return (
    <section
      ref={root}
      className={css.console}
      aria-label="Run console"
      data-status={status.toLowerCase()}
      data-step={current}
    >
      <header className={css.consoleHead}>
        <div className={css.consoleTitle}>
          <span className="sectionLabel">Run console · live</span>
          <h2>
            {stage.number} · {stage.title}
          </h2>
          <p>
            <code>{stage.experimentId}</code>
            <span>
              {profile.gpus} × {profile.accelerator.name} · {config.precision.toUpperCase()}{" "}
              · {config.trainable === "full" ? "full parameter" : "LoRA"} · global batch{" "}
              {config.globalBatch}
              {stage.id === "rl" ? ` prompts × ${stage.run.rolloutsPerStep ?? 8}` : ""}
            </span>
            <span className={css.simulated}>Simulated telemetry</span>
          </p>
        </div>
        <div className={css.consoleState}>
          <div className={css.stateLine} data-status={status.toLowerCase()} role="status">
            <i aria-hidden="true" />
            <strong>{status}</strong>
            <span>
              step <b>{grouped(Math.min(total, current + (running ? 1 : 0)))}</b> /{" "}
              {grouped(total)}
            </span>
          </div>
          <div className={css.progress} aria-hidden="true">
            <span style={{ width: `${(exact / total) * 100}%` }} />
          </div>
          <div className={css.speed}>
            <span id="replay-speed-label">Replay</span>
            <div
              className={css.segmented}
              role="group"
              aria-labelledby="replay-speed-label"
            >
              {REPLAY_SPEEDS.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={speed === value}
                  onClick={() => onSpeed(value)}
                >
                  {SPEED_LABEL[value]}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      {blocked ? (
        <p className={css.blocked}>
          This stage warm-starts from the previous stage&apos;s checkpoint, and none has
          been written yet. Telemetry begins when it starts.
        </p>
      ) : (
        <>
          <ul className={css.tiles} aria-label="Current training signals">
            {tiles.map((tile) => (
              <li key={tile.id} data-alert={tile.alert || undefined}>
                <span className={css.tileLabel}>{tile.label}</span>
                <span className={css.tileValue}>
                  {tile.value}
                  {tile.unit ? <small>{tile.unit}</small> : null}
                </span>
                {tile.trend ? (
                  <Sparkline values={tile.trend} />
                ) : (
                  <span className={css.tileSpacer} />
                )}
                {tile.note ? <span className={css.tileNote}>{tile.note}</span> : null}
              </li>
            ))}
          </ul>

          <div className={css.workbench}>
            <div className={css.charts}>
              <div className={css.chartTools}>
                <div className={css.segmented} role="group" aria-label="Chart window">
                  {(
                    [
                      ["live", "Last 200 steps"],
                      ["recent", "Last 2,000"],
                      ["run", "Full run"],
                    ] as const
                  ).map(([kind, label]) => (
                    <button
                      key={kind}
                      type="button"
                      aria-pressed={view.kind === kind}
                      onClick={() => setView({ kind })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {inspecting ? (
                  <span className={css.inspecting}>
                    Inspecting {INCIDENT_LABEL[inspecting.kind].toLowerCase()} at step{" "}
                    {grouped(inspecting.step)}
                    <button type="button" onClick={() => setView({ kind: "recent" })}>
                      Back to live
                    </button>
                  </span>
                ) : (
                  <span className={css.windowNote}>
                    {formatStep(domain[0])} – {formatStep(domain[1])} · raw per-step values
                    under a debiased EMA (0.85)
                  </span>
                )}
              </div>
              <SignalChart
                title={stage.id === "rl" ? "critic/score/mean" : primary.label}
                unit={stage.id === "rl" ? "reward" : "nats"}
                domain={domain}
                series={lossSeries}
                log={stage.id !== "rl"}
                markers={markers.signal}
                checkpoints={checkpoints}
                head={exact}
                hover={hover}
                onHover={setHover}
                height={210}
                format={format(stage.id === "rl" ? 3 : 3)}
              />
              <SignalChart
                title={stage.id === "rl" ? "actor/kl_loss" : "grad_norm"}
                unit={stage.id === "rl" ? "k3 estimator" : "global L2, pre-clip"}
                domain={domain}
                series={secondSeries}
                threshold={
                  stage.id === "rl"
                    ? { value: 0.035, label: "alert 0.035" }
                    : {
                        value: MAX_GRAD_NORM,
                        label: `max_norm ${MAX_GRAD_NORM.toFixed(1)}`,
                      }
                }
                markers={markers.second}
                head={exact}
                hover={hover}
                onHover={setHover}
                height={150}
                format={format(stage.id === "rl" ? 4 : 2)}
              />
              <SignalChart
                title={stage.id === "rl" ? "timing_s by phase" : "Step time by phase"}
                unit="seconds"
                domain={domain}
                series={timeSeries}
                stacked
                markers={markers.time}
                head={exact}
                hover={hover}
                onHover={setHover}
                height={170}
                format={format(stage.id === "rl" ? 0 : 1)}
              />
            </div>
            <StepAnatomy
              stageId={stage.id}
              frame={inProgress}
              fraction={exact >= total ? 1 : fraction}
              recent={recent}
              microBatches={accumulation(config, profile.gpus)}
              completions={config.globalBatch * (stage.run.rolloutsPerStep ?? 8)}
              running={running}
            />
          </div>

          <IncidentStrip
            total={total}
            step={exact}
            incidents={runIncidents}
            checkpointEvery={stage.run.checkpointEvery}
            inspected={inspecting?.id}
            onInspect={(incident) => {
              setView({ kind: "inspect", incident });
              setHover(incident.step);
            }}
          />

          <LiveLog
            lines={lines}
            filter={filter}
            onFilter={setFilter}
            dialect={`${DIALECT[stage.id]} · ${LOG_FORMAT[stage.id]} format`}
            running={running}
          />
        </>
      )}
    </section>
  );
}
