/**
 * Where inside an optimiser step the run is, in the same terms the run console uses.
 *
 * `phaseAt` (telemetry.ts) lays a step's phases end to end. The console's step anatomy goes
 * one level further: under gradient accumulation the forward and backward passes alternate
 * per micro-batch (a teacher forward precedes each student forward in distillation), and
 * verl's actor update is split into PPO mini-batches. The figure must agree with the console
 * at every instant, so it uses that same layout rather than `phaseAt`, which would report
 * "backward" for the whole middle of a step that is in fact alternating micro-batches.
 *
 * Pure: every function here is a function of the step frame, the configuration and the
 * fraction of the step already done.
 */

import {
  GROUP_SIZE,
  TEACHER_ACTIVE_B,
  type RunConfig,
  type RunProfile,
} from "@/lib/modellab/config";
import { batchRewards, objectiveShares } from "@/lib/modellab/ingestion";
import { clamp, gaussian, seedOf, unit } from "@/lib/modellab/noise";
import { curveAt, learningRateAt } from "@/lib/modellab/run";
import type { RunSpec, Stage, StageId } from "@/lib/modellab/stages";
import { MAX_GRAD_NORM, PHASES, type StepFrame } from "@/lib/modellab/telemetry";

/** PPO mini-batches per reinforcement-learning actor update (as the console shows them). */
export const PPO_MINI_BATCHES = 4;

export interface Segment {
  readonly phase: string;
  readonly label: string;
  /** Seconds into the step this segment starts. */
  readonly start: number;
  readonly seconds: number;
  /** 1-based micro-batch (or PPO mini-batch) this segment belongs to. */
  readonly part?: number;
  readonly parts?: number;
}

/** Micro-batches per rank per optimiser step: global batch over data-parallel ranks. */
export function accumulation(config: RunConfig, gpus: number): number {
  const perRank = config.globalBatch / Math.max(1, gpus);
  const micro = perRank > 8 ? 2 : 1;
  return Math.max(1, Math.round(perRank / micro));
}

/** A step's phases in execution order, split the way the console's step anatomy splits them. */
export function stepSegments(
  stageId: StageId,
  frame: StepFrame,
  microBatches: number,
): Segment[] {
  const seconds = (id: string) =>
    frame.phases.find((phase) => phase.id === id)?.seconds ?? 0;
  const label = (id: string) =>
    PHASES[stageId].find((phase) => phase.id === id)?.label ?? id;
  const out: Segment[] = [];
  let cursor = 0;
  const add = (phase: string, duration: number, part?: number, parts?: number) => {
    out.push({ phase, label: label(phase), start: cursor, seconds: duration, part, parts });
    cursor += duration;
  };
  if (stageId === "rl") {
    for (const phase of PHASES.rl) {
      if (phase.id === "update_actor") {
        for (let part = 1; part <= PPO_MINI_BATCHES; part += 1) {
          add(
            "update_actor",
            seconds("update_actor") / PPO_MINI_BATCHES,
            part,
            PPO_MINI_BATCHES,
          );
        }
      } else {
        add(phase.id, seconds(phase.id));
      }
    }
    return out;
  }
  const m = Math.max(1, microBatches);
  add("data", seconds("data"));
  for (let part = 1; part <= m; part += 1) {
    if (stageId === "distillation") add("teacher", seconds("teacher") / m, part, m);
    add("forward", seconds("forward") / m, part, m);
    add("backward", seconds("backward") / m, part, m);
  }
  add("comm", seconds("comm"));
  add("optimizer", seconds("optimizer"));
  return out;
}

export interface StepMoment {
  readonly segment: Segment;
  readonly index: number;
  /** Share of the current segment done, 0..1. */
  readonly within: number;
  /** Seconds into the step. */
  readonly elapsed: number;
  /** Seconds the step takes. */
  readonly total: number;
  /** Backward micro-batches (or PPO mini-batches) finished so far in this step. */
  readonly partsDone: number;
}

/** Locate `fraction` of the step inside its segments. */
export function momentOf(segments: readonly Segment[], fraction: number): StepMoment {
  const total = segments.reduce((sum, segment) => sum + segment.seconds, 0);
  const elapsed = clamp(fraction, 0, 1) * total;
  let index = segments.length - 1;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    if (elapsed < segment.start + segment.seconds) {
      index = i;
      break;
    }
  }
  const segment = segments[index]!;
  const within =
    segment.seconds > 0 ? clamp((elapsed - segment.start) / segment.seconds, 0, 1) : 1;
  let partsDone = 0;
  for (let i = 0; i < index; i += 1) {
    const phase = segments[i]!.phase;
    if (phase === "backward" || phase === "update_actor") partsDone += 1;
  }
  return { segment, index, within, elapsed, total, partsDone };
}

/**
 * Completions of a rollout batch finished `progress` of the way through generation. Decode
 * throughput is flat but completion lengths are long-tailed: most sequences end early and a
 * few run to the length limit, so the count rises fast and then crawls. Same curve as the
 * console's step anatomy.
 */
export function completionsDone(progress: number, total: number): number {
  return Math.min(
    total,
    Math.floor(total * (1 - Math.pow(1 - clamp(progress, 0, 1), 3.2))),
  );
}

/** Generation progress at which the k-th of `group` equal shares of completions is done. */
export function completionFinish(k: number, group: number): number {
  const share = Math.min(1, (k + 1) / Math.max(1, group));
  return 1 - Math.pow(1 - share, 1 / 3.2);
}

export interface LiveTerm {
  /** Matches `ArchBox.lossKey`. */
  readonly key: string;
  readonly weight: number;
  /** The term's own loss (or verifier score). */
  readonly value: number;
  /** weight × value: what it adds to the aggregate. */
  readonly contribution: number;
}

export interface LiveTerms {
  readonly kind: "loss" | "reward";
  readonly terms: readonly LiveTerm[];
  /** Σ of the contributions. */
  readonly total: number;
}

/**
 * The live terms of the stage's aggregate at `step`, read from the same functions the
 * signal-composition figure and the curve panels use: objective losses for pretraining and
 * supervised fine-tuning, verifier rewards for reinforcement learning, and for distillation
 * the terms of the total objective as its curve defines them.
 */
export function liveTerms(stage: Stage, step: number): LiveTerms {
  const at = Math.max(0, Math.min(stage.run.totalSteps, Math.floor(step)));
  if (stage.id === "rl") {
    const terms = batchRewards(stage, at, at / stage.run.totalSteps).map((row) => ({
      key: row.name,
      weight: row.weight,
      value: row.score,
      contribution: row.value,
    }));
    return { kind: "reward", terms, total: sum(terms) };
  }
  const objectives = objectiveShares(stage, at);
  if (objectives.length) {
    const terms = objectives.map((row) => ({
      key: row.key,
      weight: row.weight,
      value: row.loss,
      contribution: row.weight * row.loss,
    }));
    return { kind: "loss", terms, total: sum(terms) };
  }
  const siblings = stage.curves.flatMap((tab) => tab.curves);
  const totalCurve = stage.curves[0]?.curves[0];
  const terms: LiveTerm[] = [];
  for (const term of totalCurve?.sumOf ?? []) {
    const curve = siblings.find((item) => item.key === term.key);
    if (!curve) continue;
    const value = Math.max(0, curveAt(curve, at, stage));
    terms.push({
      key: term.key,
      weight: term.weight,
      value,
      contribution: term.weight * value,
    });
  }
  return { kind: "loss", terms, total: sum(terms) };
}

const sum = (terms: readonly LiveTerm[]) =>
  terms.reduce((total, term) => total + term.contribution, 0);

/**
 * Group-relative advantages of one prompt group at `step`: G completion rewards around the
 * batch's mean score, normalised by the group's own mean and standard deviation. A group
 * whose completions all scored alike carries no signal — every advantage is zero — with the
 * probability the telemetry reports for zero-variance groups.
 */
export function groupAdvantages(
  step: number,
  scoreMean: number,
  zeroVarianceShare: number,
  group: number,
): readonly number[] {
  const rewards = groupRewards(step, scoreMean, zeroVarianceShare, group);
  const mean = rewards.reduce((a, b) => a + b, 0) / group;
  const std = Math.sqrt(rewards.reduce((a, b) => a + (b - mean) ** 2, 0) / group);
  return rewards.map((reward) => (std > 1e-6 ? (reward - mean) / std : 0));
}

/**
 * The G verifier rewards of one prompt group at `step`, in [0, 1], that `groupAdvantages`
 * normalises. A zero-variance group scored every completion alike: all G rewards are equal
 * (all passing or all failing, on the side of the batch mean).
 */
export function groupRewards(
  step: number,
  scoreMean: number,
  zeroVarianceShare: number,
  group: number,
): readonly number[] {
  const seed = seedOf("rl:group-advantage");
  const at = Math.max(0, Math.floor(step));
  if (unit(seed ^ 0x2545f491, at) < zeroVarianceShare) {
    return new Array<number>(group).fill(scoreMean >= 0.5 ? 1 : 0);
  }
  return Array.from({ length: group }, (_, k) =>
    clamp(scoreMean + 0.22 * clamp(gaussian(seed, at * 16 + k), -2.5, 2.5), 0, 1),
  );
}

// ── what the figure draws inside one step ──────────────────────────────────────────────────

/**
 * Magnitude of the backward pass as the figure draws it: the logged pre-clip global norm,
 * its share of the clip threshold, and whether the update was clipped or skipped. Every mark
 * of gradient in the figure takes its weight from this, so it moves with the console's
 * `grad_norm` column.
 */
export interface GradMagnitude {
  readonly norm: number;
  /** norm / max_norm, capped at 1.6 so a spike reads as a spike without swamping the figure. */
  readonly share: number;
  readonly clipped: boolean;
  readonly skipped: boolean;
  /** Stroke width of a gradient path, in the figure's coordinate space. */
  readonly width: number;
}

export function gradMagnitude(frame: StepFrame): GradMagnitude {
  const finite = Number.isFinite(frame.gradNorm);
  const share = finite ? clamp(frame.gradNorm / MAX_GRAD_NORM, 0, 1.6) : 0;
  return {
    norm: frame.gradNorm,
    share,
    clipped: frame.clipped,
    skipped: frame.skipped,
    // The applied update is clipped at max_norm; the drawn width saturates there as well.
    width: finite ? 1.1 + 3.2 * Math.min(1, share) : 1,
  };
}

/**
 * Per-position losses of one sequence whose mean is exactly `mean`: a long-tailed spread
 * (a few hard tokens, many easy ones) seeded by step, so a position's loss is stable while a
 * step executes and the mean always equals the live term the aggregate reads.
 */
export function tokenLosses(
  key: string,
  step: number,
  mean: number,
  positions: number,
): readonly number[] {
  const seed = seedOf(`token-loss:${key}`);
  const at = Math.max(0, Math.floor(step));
  const raw = Array.from({ length: positions }, (_, i) =>
    Math.exp(0.75 * clamp(gaussian(seed, at * 64 + i), -2.5, 2.5)),
  );
  const scale = mean / Math.max(1e-12, raw.reduce((a, b) => a + b, 0) / positions);
  return raw.map((value) => value * scale);
}

/** KL(p ‖ q) in nats. */
export function klDivergence(p: readonly number[], q: readonly number[]): number {
  let total = 0;
  p.forEach((pi, i) => {
    if (pi > 0) total += pi * Math.log(pi / Math.max(1e-300, q[i] ?? 0));
  });
  return total;
}

function softmax(logits: readonly number[], temperature: number): number[] {
  const scaled = logits.map((value) => value / temperature);
  const top = Math.max(...scaled);
  const exp = scaled.map((value) => Math.exp(value - top));
  const z = exp.reduce((a, b) => a + b, 0);
  return exp.map((value) => value / z);
}

export interface TransferPair {
  /** Teacher token distribution over the top-`bins` vocabulary slice, at temperature T. */
  readonly teacher: readonly number[];
  /** Student distribution over the same slice; KL(teacher ‖ student) = `kl`. */
  readonly student: readonly number[];
  readonly kl: number;
  /** A slice of the teacher hidden state and of the projected student state W·h_S. */
  readonly hiddenTeacher: readonly number[];
  readonly hiddenStudent: readonly number[];
  /** Mean squared error over that slice: the live hidden-state term. */
  readonly mse: number;
}

/**
 * One position of the teacher → student transfer, constructed so the drawn distributions
 * have exactly the live forward-KL term between them and the drawn hidden states exactly the
 * live hidden-state MSE. The teacher's logits are fixed per step; the student's are the
 * teacher's plus a seeded perturbation whose scale is solved by bisection (KL is monotone in
 * it) for the target, so as the KL term falls the student's bars close onto the teacher's.
 */
export function transferPair(
  step: number,
  kl: number,
  mse: number,
  bins = 12,
  temperature = 2,
): TransferPair {
  const seed = seedOf("kd:transfer");
  const at = Math.max(0, Math.floor(step));
  // A peaked, ranked teacher: logits falling with rank, plus a little per-step variation.
  const logits = Array.from(
    { length: bins },
    (_, i) => 4.2 - 1.05 * Math.sqrt(i * 3) + 0.25 * gaussian(seed, at * 32 + i),
  ).sort((a, b) => b - a);
  const noise = Array.from({ length: bins }, (_, i) =>
    gaussian(seed ^ 0x6a09e667, at * 32 + i),
  );
  const teacher = softmax(logits, temperature);
  const studentAt = (scale: number) =>
    softmax(
      logits.map((value, i) => value + scale * noise[i]!),
      temperature,
    );
  const target = Math.max(0, kl);
  let lo = 0;
  let hi = 1;
  while (klDivergence(teacher, studentAt(hi)) < target && hi < 1024) hi *= 2;
  for (let k = 0; k < 48; k += 1) {
    const mid = (lo + hi) / 2;
    if (klDivergence(teacher, studentAt(mid)) < target) lo = mid;
    else hi = mid;
  }
  const student = studentAt((lo + hi) / 2);

  const width = 16;
  const hiddenTeacher = Array.from({ length: width }, (_, i) =>
    clamp(gaussian(seed ^ 0x3c6ef372, at * 32 + i), -2.5, 2.5),
  );
  const error = Array.from({ length: width }, (_, i) =>
    gaussian(seed ^ 0xa54ff53a, at * 32 + i),
  );
  const power = error.reduce((a, b) => a + b * b, 0) / width;
  const k = Math.sqrt(Math.max(0, mse) / Math.max(1e-12, power));
  const hiddenStudent = hiddenTeacher.map((value, i) => value + k * error[i]!);
  return {
    teacher,
    student,
    kl: klDivergence(teacher, student),
    hiddenTeacher,
    hiddenStudent,
    mse:
      hiddenTeacher.reduce((sum, value, i) => sum + (value - hiddenStudent[i]!) ** 2, 0) /
      width,
  };
}

/**
 * Batch geometry of one optimiser step, in the terms `accumulation` uses: data-parallel
 * ranks, sequences per micro-batch, micro-batches accumulated per rank, and the sequence
 * length.
 */
export interface BatchGeometry {
  readonly nodes: number;
  readonly gpusPerNode: number;
  readonly ranks: number;
  readonly micro: number;
  readonly accumulation: number;
  readonly globalBatch: number;
  /** Tokens per sequence (reinforcement learning: prompt plus mean response). */
  readonly sequence: number;
  /** Sequences per sample: the GRPO group in reinforcement learning, otherwise one. */
  readonly group: number;
  readonly tokensPerStep: number;
}

export function batchGeometry(
  stageId: StageId,
  config: RunConfig,
  profile: RunProfile,
): BatchGeometry {
  const ranks = Math.max(1, profile.gpus);
  const perRank = config.globalBatch / ranks;
  const group = stageId === "rl" ? GROUP_SIZE : 1;
  return {
    nodes: config.nodes,
    gpusPerNode: config.gpusPerNode,
    ranks,
    micro: perRank > 8 ? 2 : 1,
    accumulation: accumulation(config, ranks),
    globalBatch: config.globalBatch,
    sequence: Math.round(profile.tokensPerSample / group),
    group,
    tokensPerStep: profile.tokensPerSample * config.globalBatch,
  };
}

/**
 * Parameters by role, billions: what the optimizer updates and what it never touches. The
 * trainable parts sum to the planner's `trainableB` (config.ts `memoryBreakdown`).
 */
export interface ParameterPart {
  readonly id: "base" | "lora" | "encoders" | "teacher";
  readonly billions: number;
  readonly trainable: boolean;
}

export function parameterBudget(
  stageId: StageId,
  config: RunConfig,
  profile: RunProfile,
): readonly ParameterPart[] {
  const backbone = profile.backbone.params;
  const encoders = (profile.spatial.paramsM + profile.graph.paramsM) / 1000;
  const parts: ParameterPart[] = [];
  if (config.trainable === "full") {
    parts.push({ id: "base", billions: backbone, trainable: true });
    parts.push({ id: "encoders", billions: encoders, trainable: true });
  } else {
    parts.push({ id: "base", billions: backbone, trainable: false });
    parts.push({ id: "lora", billions: backbone * 0.015, trainable: true });
    // Reinforcement learning keeps the policy's encoders frozen; other stages train them.
    parts.push({ id: "encoders", billions: encoders, trainable: stageId !== "rl" });
  }
  if (stageId === "distillation") {
    parts.push({ id: "teacher", billions: TEACHER_ACTIVE_B, trainable: false });
  }
  return parts.filter((part) => part.billions > 0);
}

/** The learning-rate schedule sampled across the run, denser through warmup. */
export function scheduleSeries(
  run: RunSpec,
  points = 96,
): readonly { readonly step: number; readonly lr: number }[] {
  const warm = Math.min(run.totalSteps, run.warmupSteps);
  const steps = new Set<number>([0, warm, run.totalSteps]);
  for (let i = 0; i <= 12; i += 1) steps.add(Math.round((warm * i) / 12));
  for (let i = 0; i < points; i += 1) {
    steps.add(Math.round(warm + ((run.totalSteps - warm) * i) / (points - 1)));
  }
  return [...steps]
    .sort((a, b) => a - b)
    .map((step) => ({ step, lr: learningRateAt(run, step) }));
}

/** Seconds, formatted as the console formats them. */
export function formatSeconds(value: number): string {
  return value >= 100
    ? `${value.toFixed(0)} s`
    : value >= 10
      ? `${value.toFixed(1)} s`
      : `${value.toFixed(2)} s`;
}
