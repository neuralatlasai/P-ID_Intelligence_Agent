/**
 * The incident timeline of a simulated run — the single source of truth for everything that
 * goes wrong in it.
 *
 * Before this module the run log narrated loss spikes, clipping bursts and loader stalls that
 * the charts could not show: the curves were smooth analytic functions and the log was a
 * separate hash of the step. An engineer reading "loss spike at step 12,400" found a clean
 * curve at step 12,400. Now there is one timeline. The loss curve, the gradient-norm trace,
 * the step-time breakdown, the throughput figures and the run log all read the same
 * incidents, so what the log says happened is visible wherever it would be measured.
 *
 * Scheduling is bucketed: each 200-step bucket decides, from a hash of the stage and the
 * bucket index alone, which incidents begin inside it. Any step's active incidents are found
 * by looking back only as far as the longest incident lasts, so a query is O(1) regardless of
 * how far into a 100,000-step run it is — and the answer never depends on the run
 * configuration, so reconfiguring a run does not rewrite its history.
 *
 * Rates and magnitudes follow what is reported for runs of this scale: occasional
 * self-recovering loss spikes, gradient-clipping bursts, input-pipeline stalls, straggling
 * ranks and slow collectives; rare non-finite steps; and, for the long pretraining job, a
 * hardware fault that forces a restart from the last checkpoint. Reinforcement learning has
 * its own failure vocabulary — long-tail rollouts, KL excursions and entropy collapse — and
 * distillation adds teacher-side back-pressure.
 */

import { clamp, lerp, seedOf, unit } from "./noise";
import type { Stage, StageId } from "./stages";

export type IncidentKind =
  /** Loss and gradient norm jump together and relax back within tens of steps. */
  | "loss-spike"
  /** Gradient norm exceeds the clip threshold for a run of consecutive steps. */
  | "grad-clip-burst"
  /** The input pipeline cannot keep up; ranks wait on the next batch. */
  | "loader-stall"
  /** One rank runs slow; every collective waits for it. */
  | "straggler"
  /** A single step's collective takes far longer than usual (link flap, congestion). */
  | "slow-collective"
  /** A non-finite gradient norm; the optimiser step is skipped. */
  | "nonfinite-skip"
  /** A hardware fault aborts the job; it restarts from the last checkpoint. */
  | "job-restart"
  /** Reinforcement learning: a few very long completions hold up the rollout phase. */
  | "rollout-tail"
  /** Reinforcement learning: the policy moves away from the reference faster than planned. */
  | "kl-excursion"
  /** Reinforcement learning: token entropy falls sharply — the early sign of collapse. */
  | "entropy-drop"
  /** Distillation: teacher forward passes fall behind the student's consumption. */
  | "teacher-queue";

export type IncidentSeverity = "warn" | "error";

interface IncidentModel {
  readonly kind: IncidentKind;
  /** Expected onsets per 1,000 optimiser steps. */
  readonly per1k: number;
  /** Steps the incident's effect lasts, [min, max]. */
  readonly duration: readonly [number, number];
  /** Kind-specific strength, [min, max]; drawn skewed toward the low end. */
  readonly magnitude: readonly [number, number];
  readonly severity: IncidentSeverity;
}

/**
 * Per-stage incident catalogues. Rates are per optimiser step, so a stage with long steps
 * (reinforcement learning) sees fewer per hour than one with short steps.
 */
const MODELS: Record<StageId, readonly IncidentModel[]> = {
  // A healthy LoRA continued-pretraining run: a handful of self-recovering loss spikes over
  // its whole length, occasional clipping, and the infrastructure noise any 32-GPU job has.
  pretraining: [
    {
      kind: "loss-spike",
      per1k: 0.22,
      duration: [18, 60],
      magnitude: [0.06, 0.42],
      severity: "warn",
    },
    {
      kind: "grad-clip-burst",
      per1k: 0.9,
      duration: [3, 12],
      magnitude: [1.1, 2.2],
      severity: "warn",
    },
    {
      kind: "loader-stall",
      per1k: 0.7,
      duration: [2, 8],
      magnitude: [0.4, 2.0],
      severity: "warn",
    },
    {
      kind: "straggler",
      per1k: 0.45,
      duration: [12, 50],
      magnitude: [0.08, 0.22],
      severity: "warn",
    },
    {
      kind: "slow-collective",
      per1k: 0.3,
      duration: [1, 1],
      magnitude: [1.6, 4.2],
      severity: "warn",
    },
    {
      kind: "nonfinite-skip",
      per1k: 0.08,
      duration: [1, 1],
      magnitude: [1, 1],
      severity: "warn",
    },
    {
      kind: "job-restart",
      per1k: 0.05,
      duration: [1, 1],
      magnitude: [1, 1],
      severity: "error",
    },
  ],
  // Fine-tuning clips more often early — the gradient norm starts high — and otherwise
  // shares the same infrastructure noise.
  sft: [
    {
      kind: "loss-spike",
      per1k: 0.3,
      duration: [10, 36],
      magnitude: [0.05, 0.3],
      severity: "warn",
    },
    {
      kind: "grad-clip-burst",
      per1k: 1.4,
      duration: [2, 9],
      magnitude: [1.1, 1.9],
      severity: "warn",
    },
    {
      kind: "loader-stall",
      per1k: 0.9,
      duration: [2, 7],
      magnitude: [0.3, 1.5],
      severity: "warn",
    },
    {
      kind: "straggler",
      per1k: 0.4,
      duration: [8, 36],
      magnitude: [0.06, 0.18],
      severity: "warn",
    },
    {
      kind: "slow-collective",
      per1k: 0.3,
      duration: [1, 1],
      magnitude: [1.5, 3.2],
      severity: "warn",
    },
  ],
  // Per step, not per hour: a GRPO step is ~3.5 minutes, so these are rarer in wall-clock
  // time than their rates suggest. Long-tail generation is the common case.
  rl: [
    {
      kind: "rollout-tail",
      per1k: 14,
      duration: [1, 3],
      magnitude: [0.25, 1.0],
      severity: "warn",
    },
    {
      kind: "kl-excursion",
      per1k: 4,
      duration: [4, 14],
      magnitude: [0.4, 1.4],
      severity: "warn",
    },
    {
      kind: "entropy-drop",
      per1k: 2.5,
      duration: [8, 24],
      magnitude: [0.12, 0.32],
      severity: "warn",
    },
    {
      kind: "grad-clip-burst",
      per1k: 4,
      duration: [1, 4],
      magnitude: [1.1, 1.8],
      severity: "warn",
    },
    {
      kind: "straggler",
      per1k: 2,
      duration: [2, 8],
      magnitude: [0.05, 0.16],
      severity: "warn",
    },
  ],
  distillation: [
    {
      kind: "teacher-queue",
      per1k: 0.6,
      duration: [3, 10],
      magnitude: [0.3, 1.2],
      severity: "warn",
    },
    {
      kind: "loss-spike",
      per1k: 0.2,
      duration: [12, 40],
      magnitude: [0.05, 0.3],
      severity: "warn",
    },
    {
      kind: "grad-clip-burst",
      per1k: 0.7,
      duration: [2, 8],
      magnitude: [1.1, 1.7],
      severity: "warn",
    },
    {
      kind: "loader-stall",
      per1k: 0.5,
      duration: [2, 6],
      magnitude: [0.3, 1.1],
      severity: "warn",
    },
    {
      kind: "slow-collective",
      per1k: 0.2,
      duration: [1, 1],
      magnitude: [1.4, 2.8],
      severity: "warn",
    },
  ],
};

export interface Incident {
  /** Stable identity: stage, kind and onset step. */
  readonly id: string;
  readonly kind: IncidentKind;
  readonly severity: IncidentSeverity;
  /** Onset, an integer optimiser step. */
  readonly step: number;
  /** Steps the effect lasts; the incident covers [step, step + duration). */
  readonly duration: number;
  readonly magnitude: number;
  /**
   * Which rank is implicated, as a fraction of the world size. Stored as a fraction so the
   * timeline does not depend on how many GPUs the run is configured with; resolve it with
   * `rankOf` at display time.
   */
  readonly rankShare: number;
}

/** Steps per scheduling bucket. */
const BUCKET = 200;

/** The longest any incident lasts, per stage — how far back a query must look. */
const LOOKBACK: Record<StageId, number> = Object.fromEntries(
  (Object.keys(MODELS) as StageId[]).map((id) => [
    id,
    Math.max(...MODELS[id].map((model) => model.duration[1])),
  ]),
) as Record<StageId, number>;

type TimelineStage = Pick<Stage, "id" | "run">;

const cache = new Map<string, readonly Incident[]>();

/** Incidents whose onset falls in bucket `bucket`. Pure; memoised. */
function bucketIncidents(stage: TimelineStage, bucket: number): readonly Incident[] {
  const key = `${stage.id}:${stage.run.checkpointEvery}:${stage.run.totalSteps}:${bucket}`;
  const cached = cache.get(key);
  if (cached) return cached;
  if (cache.size > 6000) cache.clear();

  const found: Incident[] = [];
  const models = MODELS[stage.id];
  const start = bucket * BUCKET;
  const every = Math.max(1, stage.run.checkpointEvery);
  for (let index = 0; index < models.length; index += 1) {
    const model = models[index]!;
    const seed = seedOf(`${stage.id}:incident:${model.kind}`);
    let draws: number;
    let restartAt = 0;
    if (model.kind === "job-restart") {
      // A restart resumes from the most recent checkpoint. The fault is placed in the step
      // just after one, so what the log shows is exact — one step recomputed — and the
      // timeline never has to rewind. Only the bucket holding that step can draw it, and it
      // draws with the probability of a fault anywhere in the checkpoint interval, so the
      // rate per step is unchanged.
      const checkpoint = Math.ceil((start - 1) / every) * every;
      restartAt = checkpoint + 1;
      const inBucket = checkpoint > 0 && restartAt >= start && restartAt < start + BUCKET;
      draws = inBucket && unit(seed, bucket * 8) < (model.per1k * every) / 1000 ? 1 : 0;
    } else {
      const expected = (model.per1k * BUCKET) / 1000;
      // Up to two onsets per bucket: a Poisson draw truncated where it stops mattering.
      draws =
        unit(seed, bucket * 8) < expected
          ? unit(seed, bucket * 8 + 1) < expected / 2
            ? 2
            : 1
          : 0;
    }
    for (let draw = 0; draw < draws; draw += 1) {
      const salt = bucket * 8 + 2 + draw * 3;
      const step =
        model.kind === "job-restart"
          ? restartAt
          : start + Math.floor(unit(seed, salt) * BUCKET);
      if (step < 1 || step >= stage.run.totalSteps) continue;
      const [lo, hi] = model.duration;
      const duration = Math.round(lerp(lo, hi, unit(seed, salt + 1)));
      const [mlo, mhi] = model.magnitude;
      // Skewed toward small: most incidents are minor, a few are not.
      const magnitude = lerp(mlo, mhi, Math.pow(unit(seed, salt + 2), 1.7));
      found.push({
        id: `${stage.id}:${model.kind}:${step}`,
        kind: model.kind,
        severity: model.severity,
        step,
        duration: Math.max(1, duration),
        magnitude,
        rankShare: unit(seed, salt + 5),
      });
    }
  }
  found.sort((a, b) => a.step - b.step);
  cache.set(key, found);
  return found;
}

/** Incidents with onset in [from, to], in step order. */
export function incidentsBetween(
  stage: TimelineStage,
  from: number,
  to: number,
): readonly Incident[] {
  if (to < from) return [];
  const first = Math.max(0, Math.floor(from / BUCKET));
  const last = Math.floor(to / BUCKET);
  const result: Incident[] = [];
  for (let bucket = first; bucket <= last; bucket += 1) {
    for (const incident of bucketIncidents(stage, bucket)) {
      if (incident.step >= from && incident.step <= to) result.push(incident);
    }
  }
  return result;
}

/** Incidents in effect at `step`. */
export function activeIncidents(stage: TimelineStage, step: number): readonly Incident[] {
  const at = Math.floor(step);
  return incidentsBetween(stage, at - LOOKBACK[stage.id], at).filter(
    (incident) => at < incident.step + incident.duration,
  );
}

/**
 * The most recent `limit` incidents with onset at or before `step`, newest first. Walks back
 * bucket by bucket, so its cost follows how many are asked for, not how long the run is.
 */
export function recentIncidents(
  stage: TimelineStage,
  step: number,
  limit: number,
): readonly Incident[] {
  const result: Incident[] = [];
  for (
    let bucket = Math.floor(step / BUCKET);
    bucket >= 0 && result.length < limit;
    bucket -= 1
  ) {
    const found = bucketIncidents(stage, bucket).filter(
      (incident) => incident.step <= step,
    );
    for (let index = found.length - 1; index >= 0 && result.length < limit; index -= 1) {
      result.push(found[index]!);
    }
  }
  return result;
}

/**
 * How strongly an incident is felt `step` steps into it, in [0, 1].
 *
 * Shapes follow the physical process. A loss spike rises in a few steps and relaxes
 * exponentially; a stall or a slow rank holds for its whole duration; an entropy drop is a
 * smooth dip and recovery.
 */
export function envelope(incident: Incident, step: number): number {
  const at = Math.floor(step);
  if (at < incident.step || at >= incident.step + incident.duration) return 0;
  const t = incident.duration <= 1 ? 0 : (at - incident.step) / incident.duration;
  switch (incident.kind) {
    case "loss-spike":
    case "kl-excursion":
      return t < 0.08 ? 0.35 + (0.65 * t) / 0.08 : Math.exp(-(t - 0.08) * 4.2);
    case "entropy-drop":
      return Math.sin(Math.PI * clamp(t, 0, 1));
    case "grad-clip-burst":
      return Math.pow(Math.sin(Math.PI * clamp(t * 0.9 + 0.05, 0, 1)), 0.5);
    default:
      return 1;
  }
}

/** How a plotted signal responds to incidents. Undefined: it does not. */
export type CurveResponse = "loss" | "reward" | "kl" | "entropy" | "length";

/**
 * The multiplicative factor incidents apply to a signal of the given response at `step`.
 * This is the function that keeps the charts and the log in agreement: both read it.
 */
export function perturbation(
  stage: TimelineStage,
  response: CurveResponse | undefined,
  step: number,
): number {
  if (!response) return 1;
  let factor = 1;
  for (const incident of activeIncidents(stage, step)) {
    const e = envelope(incident, step);
    if (e === 0) continue;
    const m = incident.magnitude;
    switch (response) {
      case "loss":
        if (incident.kind === "loss-spike") factor *= 1 + m * e;
        break;
      case "kl":
        if (incident.kind === "kl-excursion") factor *= 1 + 2.4 * m * e;
        break;
      case "reward":
        if (incident.kind === "kl-excursion") factor *= 1 - 0.09 * m * e;
        if (incident.kind === "entropy-drop") factor *= 1 - 0.05 * m * e;
        break;
      case "entropy":
        if (incident.kind === "entropy-drop") factor *= 1 - m * e;
        break;
      case "length":
        if (incident.kind === "rollout-tail") factor *= 1 + 0.35 * m * e;
        break;
    }
  }
  return factor;
}

/** Resolve an incident's implicated rank against a world size. */
export function rankOf(incident: Incident, worldSize: number): number {
  return Math.min(worldSize - 1, Math.floor(incident.rankShare * Math.max(1, worldSize)));
}

/**
 * The expected fraction of wall-clock time lost to incidents that lengthen steps, per stage.
 * Nominal step time is shortened by this share so that, averaged over a window, the logged
 * step times agree with the run's planned throughput rather than drifting above it.
 */
export function expectedOverhead(stageId: StageId): number {
  let share = 0;
  for (const model of MODELS[stageId]) {
    const duration = (model.duration[0] + model.duration[1]) / 2;
    const magnitude = (model.magnitude[0] + model.magnitude[1]) / 2;
    const perStep = model.per1k / 1000;
    if (model.kind === "loader-stall" || model.kind === "teacher-queue") {
      share += perStep * duration * magnitude;
    } else if (model.kind === "straggler") {
      share += perStep * duration * magnitude;
    } else if (model.kind === "slow-collective") {
      share += perStep * magnitude;
    } else if (model.kind === "rollout-tail") {
      share += perStep * duration * magnitude * 0.6;
    }
  }
  return clamp(share, 0, 0.2);
}
