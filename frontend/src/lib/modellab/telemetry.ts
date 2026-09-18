/**
 * Per-step training telemetry and the run log, derived from one model.
 *
 * A step frame is what a training job knows about one optimiser step when it finishes it:
 * the loss it logged, the gradient norm before clipping, how long each phase of the step
 * took, the throughput and utilisation that follows, and which incidents were in effect.
 * Everything is computed from the stage plan, the run profile and the incident timeline
 * (incidents.ts) — the same inputs the charts use — so a value quoted in the log is the value
 * plotted at that step.
 *
 * The log is written in the native format of the framework each stage runs on, verified
 * against real run output:
 *
 *   torchtitan (FSDP2) — pretraining and distillation
 *     step: 1  loss: 8.18630  grad_norm: 1.4459  memory: 0.77GiB(0.81%)  tps: 4,536
 *     tflops: 0.32  mfu: 0.03%
 *   TRL SFTTrainer — supervised fine-tuning
 *     {'loss': …, 'grad_norm': …, 'learning_rate': …, 'num_tokens': …,
 *      'mean_token_accuracy': …, 'epoch': …}
 *   verl — reinforcement learning
 *     step:1049 - response_length/mean:8192.000 - timing_s/gen:105.499 - …
 *
 * Nothing here executes on an accelerator. These are simulated measurements, and the page
 * labels them so; what they are built to be is internally consistent and dimensionally
 * right, so an engineer reading them finds the arithmetic holds.
 */

import { TEACHER_ACTIVE_B, type RunConfig, type RunProfile } from "./config";
import { evalEvery } from "./evaluation";
import {
  activeIncidents,
  envelope,
  expectedOverhead,
  rankOf,
  recentIncidents,
  type Incident,
} from "./incidents";
import { clamp, fbm, gaussian, seedOf } from "./noise";
import { curveAt, learningRateAt } from "./run";
import type { CurveSpec, Stage, StageId } from "./stages";

/** Clip threshold on the global gradient L2 norm, every stage. */
export const MAX_GRAD_NORM = 1.0;

export type LogFormat = "torchtitan" | "trl" | "verl";

export const LOG_FORMAT: Record<StageId, LogFormat> = {
  pretraining: "torchtitan",
  sft: "trl",
  rl: "verl",
  distillation: "torchtitan",
};

export interface PhaseSpec {
  readonly id: string;
  readonly label: string;
  /** Share of a nominal step. */
  readonly share: number;
  /** Utilisation of the SMs while this phase runs, for the device-activity trace. */
  readonly smActivity: number;
}

/**
 * The anatomy of one optimiser step, per stage. Shares are for a nominal step of the default
 * configuration and sum to one. Under FSDP2 most of the parameter all-gather and gradient
 * reduce-scatter overlaps compute; what is listed as communication is the exposed remainder.
 * For reinforcement learning the phases are verl's own timing keys: generation dominates.
 */
export const PHASES: Record<StageId, readonly PhaseSpec[]> = {
  pretraining: [
    { id: "data", label: "Data-loader wait", share: 0.018, smActivity: 0.04 },
    { id: "forward", label: "Forward", share: 0.292, smActivity: 0.93 },
    { id: "backward", label: "Backward", share: 0.566, smActivity: 0.95 },
    { id: "comm", label: "Exposed collectives", share: 0.094, smActivity: 0.31 },
    { id: "optimizer", label: "Optimizer step", share: 0.03, smActivity: 0.52 },
  ],
  sft: [
    { id: "data", label: "Data-loader wait", share: 0.028, smActivity: 0.04 },
    { id: "forward", label: "Forward", share: 0.296, smActivity: 0.91 },
    { id: "backward", label: "Backward", share: 0.562, smActivity: 0.94 },
    { id: "comm", label: "Exposed collectives", share: 0.084, smActivity: 0.3 },
    { id: "optimizer", label: "Optimizer step", share: 0.03, smActivity: 0.5 },
  ],
  rl: [
    { id: "gen", label: "Rollout generation", share: 0.46, smActivity: 0.58 },
    { id: "reward", label: "Reward verification", share: 0.05, smActivity: 0.12 },
    { id: "old_log_prob", label: "Old log-probs", share: 0.12, smActivity: 0.88 },
    { id: "ref", label: "Reference log-probs", share: 0.12, smActivity: 0.88 },
    { id: "adv", label: "Advantages", share: 0.004, smActivity: 0.05 },
    { id: "update_actor", label: "Actor update", share: 0.246, smActivity: 0.92 },
  ],
  distillation: [
    { id: "data", label: "Data-loader wait", share: 0.015, smActivity: 0.04 },
    { id: "teacher", label: "Teacher forward", share: 0.24, smActivity: 0.9 },
    { id: "forward", label: "Student forward", share: 0.2, smActivity: 0.91 },
    { id: "backward", label: "Student backward", share: 0.42, smActivity: 0.94 },
    { id: "comm", label: "Exposed collectives", share: 0.095, smActivity: 0.3 },
    { id: "optimizer", label: "Optimizer step", share: 0.03, smActivity: 0.5 },
  ],
};

export interface PhaseTiming {
  readonly id: string;
  readonly label: string;
  readonly seconds: number;
}

export interface RlSignals {
  readonly scoreMean: number;
  readonly entropy: number;
  readonly klLoss: number;
  readonly ppoKl: number;
  readonly pgLoss: number;
  readonly pgClipfrac: number;
  readonly responseLengthMean: number;
  readonly responseClipRatio: number;
  readonly promptLengthMean: number;
  /** Share of prompt groups whose completions all scored alike — no learning signal. */
  readonly zeroVarianceGroups: number;
  readonly actorMfu: number;
}

export interface StepFrame {
  readonly step: number;
  /** The primary training signal as the framework logs it (reinforcement learning: mean score). */
  readonly loss: number;
  /** Global gradient L2 norm before clipping. NaN on a non-finite step. */
  readonly gradNorm: number;
  readonly clipped: boolean;
  readonly skipped: boolean;
  readonly lr: number;
  readonly stepSeconds: number;
  /** Time lost to a fault and restart that happened during this step, seconds. */
  readonly downtimeSeconds: number;
  readonly phases: readonly PhaseTiming[];
  readonly tokensPerSecondPerGpu: number;
  readonly tflopsPerGpu: number;
  /** Share of dense BF16 peak. */
  readonly mfu: number;
  readonly memoryGiB: number;
  readonly memoryShare: number;
  readonly incidents: readonly Incident[];
  /** Supervised fine-tuning: fractional epoch, token accuracy and tokens seen. */
  readonly epoch?: number;
  readonly meanTokenAccuracy?: number;
  readonly numTokens?: number;
  /** Distillation: forward KL and cross-entropy terms. */
  readonly klTerm?: number;
  readonly ceTerm?: number;
  readonly rl?: RlSignals;
}

/** What a frame needs beyond the stage: the applied configuration and its planning profile. */
export interface TelemetryContext {
  readonly stage: Stage;
  readonly profile: RunProfile;
  readonly config: RunConfig;
}

const allCurves = (stage: Stage): readonly CurveSpec[] =>
  stage.curves.flatMap((tab) => tab.curves);

function curveByKey(stage: Stage, key: string): CurveSpec | undefined {
  return allCurves(stage).find((curve) => curve.key === key);
}

/** Value of the stage's curve `key` at `step`, with incidents; `fallback` when absent. */
function curveValue(stage: Stage, key: string, step: number, fallback: number): number {
  const curve = curveByKey(stage, key);
  return curve ? curveAt(curve, step, stage) : fallback;
}

/** FLOPs per token of one training step, as the planning profile counts them. */
function flopsPerToken(context: TelemetryContext): number {
  const { profile, config, stage } = context;
  const encodersB = (profile.spatial.paramsM + profile.graph.paramsM) / 1000;
  const student =
    (config.trainable === "full" ? 6 : 4) * (profile.backbone.active + encodersB);
  // Distillation also runs the frozen teacher forward on every token.
  const teacher = stage.id === "distillation" ? 2 * TEACHER_ACTIVE_B : 0;
  return (student + teacher) * 1e9;
}

/** Seconds a nominal step takes: planned throughput, less the share incidents will add back. */
export function nominalStepSeconds(context: TelemetryContext): number {
  const rate = Math.max(1e-9, context.profile.stepsPerSecond);
  return (1 / rate) * (1 - expectedOverhead(context.stage.id));
}

/** Pre-clip gradient norm trend: high while the schedule warms up, settling as loss flattens. */
const GRAD_NORM: Record<StageId, { readonly start: number; readonly end: number }> = {
  pretraining: { start: 0.92, end: 0.21 },
  sft: { start: 1.28, end: 0.36 },
  rl: { start: 0.34, end: 0.17 },
  distillation: { start: 0.81, end: 0.24 },
};

/** Watchdog timeout, restart and checkpoint-load time for a hardware fault, seconds. */
const RESTART_DOWNTIME = { watchdog: 600, relaunch: 214, load: 41 };

/** The frame for integer step `step` (1-based; the step just completed). Pure. */
export function frameAt(context: TelemetryContext, rawStep: number): StepFrame {
  const { stage, profile, config } = context;
  const step = Math.max(1, Math.min(stage.run.totalSteps, Math.floor(rawStep)));
  const seed = seedOf(`${stage.id}:telemetry`);
  const incidents = activeIncidents(stage, step);
  const nominal = nominalStepSeconds(context);

  // ── phases ────────────────────────────────────────────────────────────────────────────
  const extra: Record<string, number> = {};
  let skipped = false;
  let downtimeSeconds = 0;
  for (const incident of incidents) {
    const e = envelope(incident, step);
    const m = incident.magnitude;
    switch (incident.kind) {
      case "loader-stall":
        extra.data = (extra.data ?? 0) + m * nominal * e;
        break;
      case "teacher-queue":
        extra.teacher = (extra.teacher ?? 0) + m * nominal * 0.5 * e;
        break;
      case "straggler":
        // Every collective waits for the slowest rank, so the delay surfaces as exposed
        // communication on every other rank.
        extra[stage.id === "rl" ? "update_actor" : "comm"] =
          (extra[stage.id === "rl" ? "update_actor" : "comm"] ?? 0) + m * nominal * e;
        break;
      case "slow-collective":
        extra.comm = (extra.comm ?? 0) + m * nominal;
        break;
      case "rollout-tail":
        extra.gen = (extra.gen ?? 0) + m * nominal * 0.46 * e;
        break;
      case "nonfinite-skip":
        skipped = true;
        break;
      case "job-restart":
        downtimeSeconds =
          RESTART_DOWNTIME.watchdog + RESTART_DOWNTIME.relaunch + RESTART_DOWNTIME.load;
        break;
    }
  }
  const phases = PHASES[stage.id].map((phase, index) => {
    const jitter = 1 + 0.035 * clamp(gaussian(seed + index * 7919, step), -3, 3);
    const base = phase.share * nominal * jitter;
    const seconds =
      phase.id === "optimizer" && skipped ? 0.002 : base + (extra[phase.id] ?? 0);
    return { id: phase.id, label: phase.label, seconds };
  });
  const stepSeconds = phases.reduce((sum, phase) => sum + phase.seconds, 0);

  // ── throughput and utilisation ───────────────────────────────────────────────────────
  const tokensPerStep = profile.tokensPerSample * config.globalBatch;
  const gpus = Math.max(1, profile.gpus);
  const tokensPerSecondPerGpu = tokensPerStep / stepSeconds / gpus;
  const tflopsPerGpu = (flopsPerToken(context) * tokensPerStep) / stepSeconds / gpus / 1e12;
  // The accelerator table carries dense BF16 peak — the MFU denominator.
  const peak = profile.accelerator.flops / 1e12;
  const memoryGiB =
    (profile.memoryPerGpuGb * 1e9) / 2 ** 30 + 0.35 * fbm(seed ^ 0x51ed27, step / 37);
  const memoryShare = memoryGiB / ((profile.accelerator.memoryGb * 1e9) / 2 ** 30);

  // ── optimisation signals ─────────────────────────────────────────────────────────────
  const primary = stage.curves[0]!.curves[0]!;
  const loss = curveAt(primary, step, stage);
  const progress = step / stage.run.totalSteps;
  const norm = GRAD_NORM[stage.id];
  let gradNorm =
    (norm.end + (norm.start - norm.end) * Math.pow(1 + progress * 40, -0.8)) *
    Math.exp(0.14 * clamp(gaussian(seed ^ 0x9e3779b9, step), -3, 3));
  for (const incident of incidents) {
    const e = envelope(incident, step);
    if (incident.kind === "loss-spike") gradNorm *= 1 + 4 * incident.magnitude * e;
    if (incident.kind === "kl-excursion") gradNorm *= 1 + 1.4 * incident.magnitude * e;
    if (incident.kind === "grad-clip-burst") {
      gradNorm = Math.max(gradNorm, MAX_GRAD_NORM * (1 + (incident.magnitude - 1) * e));
    }
  }
  if (skipped) gradNorm = Number.NaN;
  const clipped = Number.isFinite(gradNorm) && gradNorm > MAX_GRAD_NORM;

  const frame = {
    step,
    loss,
    gradNorm,
    clipped,
    skipped,
    lr: learningRateAt(stage.run, step),
    stepSeconds,
    downtimeSeconds,
    phases,
    tokensPerSecondPerGpu,
    tflopsPerGpu,
    mfu: tflopsPerGpu / peak,
    memoryGiB,
    memoryShare,
    incidents,
  };

  if (stage.id === "sft") {
    const epochs = stage.run.epochs ?? 1;
    return {
      ...frame,
      epoch: progress * epochs,
      // Top-1 agreement on supervised tokens tracks the loss it is the argmax of.
      meanTokenAccuracy: clamp(Math.exp(-0.27 * loss), 0, 0.999),
      numTokens: step * tokensPerStep,
    };
  }

  if (stage.id === "distillation") {
    return {
      ...frame,
      klTerm: curveValue(stage, "kd-kl", step, loss * 0.7),
      ceTerm: curveValue(stage, "kd-ce", step, loss * 1.6),
    };
  }

  if (stage.id === "rl") {
    const entropy = curveValue(stage, "entropy", step, 0.45);
    const klLoss = curveValue(stage, "kl", step, 0.015);
    const length = curveValue(stage, "response-length", step, 900);
    let excursion = 0;
    for (const incident of incidents) {
      if (incident.kind === "kl-excursion") {
        excursion = Math.max(excursion, incident.magnitude * envelope(incident, step));
      }
    }
    const tail = incidents.some((incident) => incident.kind === "rollout-tail");
    const update = phases.find((phase) => phase.id === "update_actor")!.seconds;
    // Actor MFU is measured over the update phase alone, as verl reports it: forward and
    // backward over every trained token (six FLOPs per parameter for a full update, four
    // when only adapters take gradients).
    const encodersB = (profile.spatial.paramsM + profile.graph.paramsM) / 1000;
    const actorFlops =
      (config.trainable === "full" ? 6 : 4) *
      (profile.backbone.active + encodersB) *
      1e9 *
      tokensPerStep;
    return {
      ...frame,
      rl: {
        scoreMean: loss,
        entropy,
        klLoss,
        ppoKl: Math.max(
          0,
          0.00032 * (1 + 3 * excursion) * (1 + 0.3 * gaussian(seed ^ 0x1b873593, step)),
        ),
        pgLoss: 0.012 * gaussian(seed ^ 0x2c1b3c6d, step),
        pgClipfrac: clamp(
          0.0034 * (1 + 4 * excursion) * Math.exp(0.25 * gaussian(seed ^ 0x297a2d39, step)),
          0,
          1,
        ),
        responseLengthMean: length,
        responseClipRatio: clamp(0.004 + (length - 640) / 42000 + (tail ? 0.018 : 0), 0, 1),
        promptLengthMean: 1852 + 38 * gaussian(seed ^ 0x3c6ef372, step),
        zeroVarianceGroups: clamp(
          0.11 + 0.36 * loss * loss + 0.4 * excursion * 0.2,
          0,
          0.95,
        ),
        actorMfu: actorFlops / update / gpus / 1e12 / peak,
      },
    };
  }

  return frame;
}

// ── the run log ──────────────────────────────────────────────────────────────────────────

export type LogLevel = "INFO" | "WARNING" | "ERROR";
export type LogSource = "trainer" | "monitor" | "checkpoint" | "eval" | "nccl" | "elastic";

export interface LogLine {
  /** Unique within a stage: step plus an ordinal for lines that share a step. */
  readonly id: string;
  readonly step: number;
  readonly level: LogLevel;
  readonly source: LogSource;
  readonly text: string;
  /** Run time the line was written, seconds since the run started. */
  readonly runSeconds: number;
}

const fixed = (value: number, digits: number) =>
  Number.isFinite(value) ? value.toFixed(digits) : "nan";
const grouped = (value: number) => Math.round(value).toLocaleString("en-US");
const scientific = (value: number) => {
  // Python's repr of a small float: 1.87e-05, not 1.87e-5.
  const [mantissa, exponent] = value.toExponential(4).split("e");
  const sign = exponent!.startsWith("-") ? "-" : "+";
  const digits = exponent!.replace(/^[+-]/, "").padStart(2, "0");
  return `${Number(mantissa)}e${sign}${digits}`;
};

/** The trainer's own line for a step, in the stage's framework format. */
export function trainerLine(context: TelemetryContext, frame: StepFrame): string {
  const format = LOG_FORMAT[context.stage.id];
  if (format === "trl") {
    return (
      `{'loss': ${fixed(frame.loss, 4)}, 'grad_norm': ${fixed(frame.gradNorm, 6)}, ` +
      `'learning_rate': ${scientific(frame.lr)}, 'num_tokens': ${Math.round(frame.numTokens ?? 0)}.0, ` +
      `'mean_token_accuracy': ${fixed(frame.meanTokenAccuracy ?? 0, 6)}, 'epoch': ${fixed(frame.epoch ?? 0, 2)}}`
    );
  }
  if (format === "verl" && frame.rl) {
    const rl = frame.rl;
    const time = (id: string) =>
      frame.phases.find((phase) => phase.id === id)?.seconds ?? 0;
    const pairs: [string, number][] = [
      ["actor/entropy", rl.entropy],
      ["actor/kl_loss", rl.klLoss],
      ["actor/pg_loss", rl.pgLoss],
      ["actor/pg_clipfrac", rl.pgClipfrac],
      ["actor/ppo_kl", rl.ppoKl],
      ["actor/grad_norm", frame.gradNorm],
      ["critic/score/mean", rl.scoreMean],
      ["critic/score/max", 1],
      ["critic/score/min", 0],
      ["response_length/mean", rl.responseLengthMean],
      ["response_length/clip_ratio", rl.responseClipRatio],
      ["prompt_length/mean", rl.promptLengthMean],
      ["timing_s/gen", time("gen")],
      ["timing_s/reward", time("reward")],
      ["timing_s/old_log_prob", time("old_log_prob")],
      ["timing_s/ref", time("ref")],
      ["timing_s/adv", time("adv")],
      ["timing_s/update_actor", time("update_actor")],
      ["timing_s/step", frame.stepSeconds],
      ["perf/throughput", frame.tokensPerSecondPerGpu],
      ["perf/mfu/actor", rl.actorMfu],
    ];
    return `step:${frame.step} - ${pairs.map(([key, value]) => `${key}:${fixed(value, 3)}`).join(" - ")}`;
  }
  const parts = [`step: ${frame.step}`, `loss: ${fixed(frame.loss, 4)}`];
  if (frame.klTerm !== undefined && frame.ceTerm !== undefined) {
    parts.push(`kl: ${fixed(frame.klTerm, 4)}`, `ce: ${fixed(frame.ceTerm, 4)}`);
  }
  parts.push(
    `grad_norm: ${fixed(frame.gradNorm, 4)}`,
    `memory: ${fixed(frame.memoryGiB, 2)}GiB(${fixed(frame.memoryShare * 100, 2)}%)`,
    `tps: ${grouped(frame.tokensPerSecondPerGpu)}`,
    `tflops: ${fixed(frame.tflopsPerGpu, 2)}`,
    `mfu: ${fixed(frame.mfu * 100, 2)}%`,
  );
  return parts.join("  ");
}

/** Lines the run monitor and runtime write alongside the trainer at `frame.step`. */
function incidentLines(
  context: TelemetryContext,
  frame: StepFrame,
  recentMedianSeconds: number,
): readonly Omit<LogLine, "id" | "runSeconds">[] {
  const { stage, profile, config } = context;
  const lines: Omit<LogLine, "id" | "runSeconds">[] = [];
  const world = Math.max(1, profile.gpus);
  const perNode = Math.max(1, config.gpusPerNode);
  const node = (rank: number) =>
    `node-${String(Math.floor(rank / perNode) + 1).padStart(2, "0")}`;
  const nominal = nominalStepSeconds(context);
  const share = (id: string) =>
    PHASES[stage.id].find((phase) => phase.id === id)?.share ?? 0;
  const phaseSeconds = (id: string) =>
    frame.phases.find((phase) => phase.id === id)?.seconds ?? 0;
  for (const incident of frame.incidents) {
    // Most incidents are reported once, at onset; a clip burst is reported when it ends.
    const onset = incident.step === frame.step;
    const rank = rankOf(incident, world);
    switch (incident.kind) {
      case "loss-spike":
        if (onset) {
          lines.push({
            step: frame.step,
            level: "WARNING",
            source: "monitor",
            text: `loss spike: ${fixed(frame.loss, 4)} is ${fixed(1 + incident.magnitude * 0.35, 2)}× its 200-step EMA · grad_norm ${fixed(frame.gradNorm, 4)}${frame.clipped ? ` > max_norm ${MAX_GRAD_NORM.toFixed(1)}, clipped` : ""} · no rollback; monitoring recovery`,
          });
        }
        break;
      case "grad-clip-burst":
        if (frame.step === incident.step + incident.duration - 1) {
          lines.push({
            step: frame.step,
            level: "WARNING",
            source: "monitor",
            text: `grad_norm above max_norm ${MAX_GRAD_NORM.toFixed(1)} for ${incident.duration} consecutive steps (peak ${fixed(MAX_GRAD_NORM * incident.magnitude, 3)}) · updates clipped`,
          });
        }
        break;
      case "loader-stall":
        if (onset) {
          lines.push({
            step: frame.step,
            level: "WARNING",
            source: "monitor",
            text: `data-loader wait ${fixed(phaseSeconds("data"), 1)} s at step ${grouped(frame.step)} (typical ${fixed(nominal * share("data"), 2)} s) · shard read from object storage, prefetch queue empty on rank ${rank}`,
          });
        }
        break;
      case "straggler":
        if (onset) {
          lines.push({
            step: frame.step,
            level: "WARNING",
            source: "monitor",
            text: `rank ${rank} (${node(rank)}) is a straggler: step time +${fixed(incident.magnitude * 100, 0)}% vs median over ${incident.duration} steps · other ranks blocked in reduce_scatter`,
          });
        }
        break;
      case "slow-collective":
        lines.push({
          step: frame.step,
          level: "WARNING",
          source: "monitor",
          text: `step ${grouped(frame.step)} took ${fixed(frame.stepSeconds, 1)} s (typical ${fixed(Math.min(recentMedianSeconds, nominal * 1.1), 1)} s): exposed communication ${fixed(phaseSeconds("comm"), 1)} s in reduce_scatter · InfiniBand error counters rising on ${node(rank)}`,
        });
        break;
      case "nonfinite-skip":
        lines.push({
          step: frame.step,
          level: "WARNING",
          source: "trainer",
          text: `non-finite grad_norm at step ${grouped(frame.step)} · optimizer step skipped, loss scale unchanged (BF16)`,
        });
        break;
      case "job-restart":
        lines.push(
          {
            step: frame.step,
            level: "ERROR",
            source: "nccl",
            text: `[rank${rank}]:[E ProcessGroupNCCL.cpp] [Rank ${rank}] Watchdog caught collective operation timeout: WorkNCCL(OpType=_REDUCE_SCATTER_BASE, Timeout(ms)=${RESTART_DOWNTIME.watchdog * 1000}) ran for ${RESTART_DOWNTIME.watchdog * 1000 + 43} milliseconds before timing out.`,
          },
          {
            step: frame.step,
            level: "ERROR",
            source: "monitor",
            text: `${node(rank)}: GPU ${rank % 8} Xid 79 (fallen off the bus) · node cordoned, replaced from spare pool`,
          },
          {
            step: frame.step,
            level: "WARNING",
            source: "elastic",
            text: "[default] Worker group FAILED. 3/3 attempts left; will restart worker group",
          },
          {
            step: frame.step,
            level: "INFO",
            source: "checkpoint",
            text: `Loading the checkpoint at step ${grouped(frame.step - 1)}.`,
          },
          {
            step: frame.step,
            level: "INFO",
            source: "checkpoint",
            text: `Finished loading the checkpoint in ${RESTART_DOWNTIME.load}.27 seconds. Resuming at step ${grouped(frame.step)} (1 step recomputed).`,
          },
        );
        break;
      case "rollout-tail":
        if (onset) {
          lines.push({
            step: frame.step,
            level: "WARNING",
            source: "monitor",
            text: `timing_s/gen ${fixed(phaseSeconds("gen"), 1)} (typical ${fixed(nominal * share("gen"), 1)}) · ${Math.max(1, Math.round(incident.magnitude * 6))} of ${config.globalBatch * (stage.run.rolloutsPerStep ?? 8)} completions reached max_response_length · long-tail decode`,
          });
        }
        break;
      case "kl-excursion":
        if (onset && frame.rl) {
          lines.push({
            step: frame.step,
            level: "WARNING",
            source: "monitor",
            text: `actor/kl_loss ${fixed(frame.rl.klLoss, 4)} (${fixed(1 + 2.4 * incident.magnitude * 0.35, 1)}× 50-step mean) · actor/pg_clipfrac ${fixed(frame.rl.pgClipfrac, 4)} · policy moving faster than the reference budget`,
          });
        }
        break;
      case "entropy-drop":
        if (onset && frame.rl) {
          lines.push({
            step: frame.step,
            level: "WARNING",
            source: "monitor",
            text: `actor/entropy falling ${fixed(incident.magnitude * 100, 0)}% over ${incident.duration} steps · zero-variance prompt groups ${fixed(frame.rl.zeroVarianceGroups * 100, 0)}% · watch for entropy collapse`,
          });
        }
        break;
      case "teacher-queue":
        if (onset) {
          lines.push({
            step: frame.step,
            level: "WARNING",
            source: "monitor",
            text: `student waited ${fixed(Math.max(0, phaseSeconds("teacher") - nominal * share("teacher")), 1)} s for teacher logits · teacher forward is the bottleneck this window`,
          });
        }
        break;
    }
  }
  return lines;
}

/** Checkpoint and evaluation lines at `step`, in the stage framework's wording. */
function cadenceLines(
  context: TelemetryContext,
  frame: StepFrame,
): readonly Omit<LogLine, "id" | "runSeconds">[] {
  const { stage } = context;
  const lines: Omit<LogLine, "id" | "runSeconds">[] = [];
  const format = LOG_FORMAT[stage.id];
  if (frame.step % Math.max(1, stage.run.checkpointEvery) === 0) {
    const text =
      format === "trl"
        ? `Saving model checkpoint to /ckpt/${stage.id}/checkpoint-${frame.step}`
        : format === "verl"
          ? `local_global_step_folder: /ckpt/${stage.id}/global_step_${frame.step}`
          : `Saving the checkpoint (or staging if async is enabled) at step ${grouped(frame.step)} · ${stage.run.checkpointSize}`;
    lines.push({ step: frame.step, level: "INFO", source: "checkpoint", text });
  }
  if (frame.step % Math.max(1, evalEvery(stage)) === 0) {
    const text =
      format === "trl"
        ? `{'eval_loss': ${fixed(frame.loss * 1.12, 4)}, 'eval_runtime': 412.3, 'eval_samples_per_second': 41.4, 'eval_steps_per_second': 0.647, 'epoch': ${fixed(frame.epoch ?? 0, 2)}}`
        : format === "verl"
          ? `val-core/plant_tasks/reward/mean@1:${fixed(frame.loss * 0.97, 3)} - val-core/plant_tasks/reward/mean@8:${fixed(Math.min(1, frame.loss * 1.12), 3)}`
          : `evaluation dispatched for step ${grouped(frame.step)} · held-out split, results publish on completion`;
    lines.push({ step: frame.step, level: "INFO", source: "eval", text });
  }
  return lines;
}

/**
 * The last `count` trainer lines up to `step`, with incident, checkpoint and evaluation lines
 * interleaved where they happened, oldest first. Run time is reconstructed backward from the
 * latest step using each step's own duration, so a slow step or a restart leaves a visible
 * gap in the timestamps.
 */
export function logTail(
  source: FrameSource,
  step: number,
  count: number,
): readonly LogLine[] {
  const { context } = source;
  const last = Math.floor(step);
  if (last < 1) return [];
  const first = Math.max(1, last - count + 1);
  const frames: StepFrame[] = [];
  for (let at = first; at <= last; at += 1) frames.push(source.frame(at));
  const typicalSeconds =
    median(frames.map((frame) => frame.stepSeconds)) ?? nominalStepSeconds(context);

  // Run time at the end of the last completed step, from the planned rate: the same clock
  // the progress card uses for elapsed time.
  const endOfLast = last / Math.max(1e-9, context.profile.stepsPerSecond);
  const ends = new Array<number>(frames.length);
  let cursor = endOfLast;
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    ends[index] = cursor;
    cursor -= frames[index]!.stepSeconds + frames[index]!.downtimeSeconds;
  }

  const lines: Omit<LogLine, "id">[] = [];
  frames.forEach((frame, index) => {
    const at = ends[index]!;
    const extras = incidentLines(context, frame, typicalSeconds);
    // A restart's lines — the watchdog, the fault, the relaunch and the checkpoint load —
    // precede the recomputed step's own trainer line; everything else follows it.
    const restarting = frame.downtimeSeconds > 0;
    const before = extras.filter(
      (line) =>
        line.source === "nccl" ||
        line.source === "elastic" ||
        line.level === "ERROR" ||
        (restarting && line.source === "checkpoint"),
    );
    const after = extras.filter((line) => !before.includes(line));
    const push = (line: Omit<LogLine, "id" | "runSeconds">, offset: number) => {
      lines.push({ ...line, runSeconds: Math.max(0, at + offset) });
    };
    before.forEach((line) => push(line, -frame.stepSeconds));
    push(
      {
        step: frame.step,
        level: frame.skipped ? "WARNING" : "INFO",
        source: "trainer",
        text: trainerLine(context, frame),
      },
      0,
    );
    after.forEach((line) => push(line, 0.01));
    cadenceLines(context, frame).forEach((line) => push(line, 0.4));
  });
  return identify(lines);
}

export type LogFilter = "all" | "warnings" | "checkpoints" | "evals";

/** A stable identity for a line: its step, source, level and position among its peers. */
function identify(lines: readonly Omit<LogLine, "id">[]): LogLine[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const base = `${line.step}:${line.source}:${line.level}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { ...line, id: `${base}:${n}` };
  });
}

/**
 * History for a filtered view, oldest first. A filter over the last few dozen steps would
 * almost always be empty — incidents arrive a few per thousand steps — so each filter reaches
 * back through the run for its own kind of line: the last `limit` incidents, checkpoints or
 * evaluations, each reconstructed from the frame of the step it happened at.
 */
export function historyLines(
  source: FrameSource,
  step: number,
  filter: Exclude<LogFilter, "all">,
  limit: number,
): readonly LogLine[] {
  const { context } = source;
  const { stage } = context;
  const rate = Math.max(1e-9, context.profile.stepsPerSecond);
  const last = Math.floor(step);
  const lines: Omit<LogLine, "id">[] = [];
  const at = (s: number) => s / rate;
  if (filter === "warnings") {
    for (const incident of recentIncidents(stage, last, limit)) {
      const reportAt =
        incident.kind === "grad-clip-burst"
          ? incident.step + incident.duration - 1
          : incident.step;
      if (reportAt > last) continue;
      const frame = source.frame(reportAt);
      for (const line of incidentLines(context, frame, nominalStepSeconds(context))) {
        if (line.level !== "INFO") lines.push({ ...line, runSeconds: at(reportAt) });
      }
    }
  } else {
    const every = filter === "checkpoints" ? stage.run.checkpointEvery : evalEvery(stage);
    const wanted: LogSource = filter === "checkpoints" ? "checkpoint" : "eval";
    for (let k = Math.floor(last / every); k >= 1 && lines.length < limit; k -= 1) {
      const frame = source.frame(k * every);
      for (const line of cadenceLines(context, frame)) {
        if (line.source === wanted)
          lines.push({ ...line, runSeconds: at(k * every) + 0.4 });
      }
    }
  }
  return identify(lines.sort((a, b) => a.step - b.step || a.runSeconds - b.runSeconds));
}

/** Recent incidents for the timeline strip and markers, newest first. */
export function recentRunIncidents(
  stage: Stage,
  step: number,
  limit = 12,
): readonly Incident[] {
  return recentIncidents(stage, step, limit);
}

/**
 * A bounded cache of frames for one run context. A console redraws many times a second at
 * fast replay, but each redraw only ever needs the frames of steps it has not seen yet; with
 * the cache a new step costs one frame, not a whole window.
 */
export interface FrameSource {
  readonly context: TelemetryContext;
  frame(step: number): StepFrame;
}

export function frameSource(context: TelemetryContext, capacity = 4096): FrameSource {
  const cache = new Map<number, StepFrame>();
  return {
    context,
    frame(step: number) {
      const at = Math.max(1, Math.floor(step));
      const hit = cache.get(at);
      if (hit) {
        // Refresh recency: Map iteration order is insertion order.
        cache.delete(at);
        cache.set(at, hit);
        return hit;
      }
      const made = frameAt(context, at);
      cache.set(at, made);
      if (cache.size > capacity) cache.delete(cache.keys().next().value as number);
      return made;
    },
  };
}

/**
 * Steps to sample across [from, to] for a chart `points` wide: evenly spaced, plus the onset
 * and the following steps of every incident in range. Without the extra samples a
 * full-run chart would step over a 20-step spike that the log reports — the exact
 * disagreement this model exists to prevent.
 */
export function sampleSteps(
  stage: Stage,
  from: number,
  to: number,
  points: number,
): readonly number[] {
  const lo = Math.max(1, Math.floor(from));
  const hi = Math.max(lo, Math.floor(to));
  const span = hi - lo;
  const steps = new Set<number>();
  if (span <= points) {
    for (let at = lo; at <= hi; at += 1) steps.add(at);
    return [...steps];
  }
  for (let index = 0; index < points; index += 1) {
    steps.add(Math.round(lo + (span * index) / (points - 1)));
  }
  for (const incident of recentIncidents(stage, hi, 400)) {
    if (incident.step < lo) break;
    for (const offset of [0, 1, 2, Math.round(incident.duration * 0.25)]) {
      const at = incident.step + offset;
      if (at >= lo && at <= hi) steps.add(at);
    }
  }
  return [...steps].sort((a, b) => a - b);
}

/** Median of a list; undefined when empty. */
export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Share of wall-clock time that made forward progress over `frames` — the metric large
 * training fleets track as goodput. A step counts as productive up to its expected duration
 * (with ordinary run-to-run variation allowed); time beyond that, spent stalled on input,
 * waiting on a slow rank or restarting after a fault, does not.
 */
export function goodput(context: TelemetryContext, frames: readonly StepFrame[]): number {
  if (frames.length === 0) return 1;
  const allowance = nominalStepSeconds(context) * 1.08;
  let productive = 0;
  let spent = 0;
  for (const frame of frames) {
    productive += frame.skipped ? 0 : Math.min(frame.stepSeconds, allowance);
    spent += frame.stepSeconds + frame.downtimeSeconds;
  }
  return clamp(productive / Math.max(1e-9, spent), 0, 1);
}

/**
 * Where inside the current step the run is: which phase is executing and how far through it.
 * `fraction` is the share of the in-progress step already done. Phases are laid end to end
 * in execution order, so the answer is a walk over at most six segments.
 */
export function phaseAt(
  frame: StepFrame,
  fraction: number,
): { readonly index: number; readonly progress: number } {
  const target = clamp(fraction, 0, 1) * frame.stepSeconds;
  let elapsed = 0;
  for (let index = 0; index < frame.phases.length; index += 1) {
    const seconds = frame.phases[index]!.seconds;
    if (target <= elapsed + seconds || index === frame.phases.length - 1) {
      return {
        index,
        progress: seconds > 0 ? clamp((target - elapsed) / seconds, 0, 1) : 1,
      };
    }
    elapsed += seconds;
  }
  return { index: 0, progress: 0 };
}

/** Format run seconds as elapsed run time: `3d 04:12:09`. */
export function formatRunTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86400);
  const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return days > 0 ? `${days}d ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
}
