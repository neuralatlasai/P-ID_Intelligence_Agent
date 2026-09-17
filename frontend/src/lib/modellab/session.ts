/**
 * The viewer's model-lab session: which configuration each stage runs, where each run is, and
 * the runs that came before.
 *
 * A stage's step rate is not a constant of its plan. It follows from the applied
 * configuration (see `config.ts`), so the effective stage — the plan with its rate and
 * experiment identity replaced — is what every card and every run function receives.
 * Applying a new configuration is a restart: the old run is archived to history and the new
 * one resumes from the last checkpoint the old one wrote, which is what a real trainer does.
 *
 * Persisted per viewer in localStorage; everything tolerates storage being absent or corrupt.
 */

import {
  DEFAULT_CONFIG,
  experimentId,
  runProfile,
  type RunConfig,
  type RunProfile,
} from "./config";
import { openingControl, stepAt, type RunControl } from "./run";
import { STAGES, stageById, type Stage, type StageId } from "./stages";

export const SESSION_KEY = "pid.modellab.session.v3";

export interface AppliedConfig {
  readonly config: RunConfig;
  readonly appliedAt: number;
}

export interface RunRecord {
  readonly experimentId: string;
  readonly stage: StageId;
  readonly config: RunConfig;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly finalStep: number;
  readonly reason: "reconfigured" | "stopped" | "resumed-from-checkpoint" | "reset";
}

export interface LabSession {
  readonly controls: Record<StageId, RunControl>;
  readonly applied: Record<StageId, AppliedConfig>;
  readonly history: readonly RunRecord[];
}

/** A run opened for the first time has been going for as long as its opening step implies. */
function openingAppliedAt(stageId: StageId, now: number): number {
  const stage = stageById(stageId)!;
  const rate = runProfile(stageId, DEFAULT_CONFIG[stageId]).stepsPerSecond;
  return now - (stage.run.openingStep / rate) * 1000;
}

export function freshSession(now: number): LabSession {
  const controls = {} as Record<StageId, RunControl>;
  const applied = {} as Record<StageId, AppliedConfig>;
  for (const stage of STAGES) {
    controls[stage.id] = openingControl(stage.run, now);
    applied[stage.id] = {
      config: DEFAULT_CONFIG[stage.id],
      appliedAt: openingAppliedAt(stage.id, now),
    };
  }
  return { controls, applied, history: [] };
}

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export function loadSession(
  now: number,
  storage: Pick<Storage, "getItem"> | undefined,
): LabSession {
  const fresh = freshSession(now);
  try {
    const raw = storage?.getItem(SESSION_KEY);
    if (!raw) return fresh;
    const parsed = JSON.parse(raw) as Partial<LabSession>;
    const controls = { ...fresh.controls };
    const applied = { ...fresh.applied };
    for (const stage of STAGES) {
      const control = parsed.controls?.[stage.id];
      if (
        control &&
        (control.status === "running" || control.status === "paused") &&
        isNumber(control.step) &&
        isNumber(control.at)
      ) {
        controls[stage.id] = {
          status: control.status,
          step: Math.min(Math.max(0, control.step), stage.run.totalSteps),
          at: Math.min(control.at, now),
        };
      }
      const config = parsed.applied?.[stage.id];
      if (
        config &&
        isNumber(config.appliedAt) &&
        config.config &&
        typeof config.config.backbone === "string"
      ) {
        applied[stage.id] = {
          config: { ...DEFAULT_CONFIG[stage.id], ...config.config },
          appliedAt: Math.min(config.appliedAt, now),
        };
      }
    }
    const history = Array.isArray(parsed.history) ? parsed.history.slice(0, 50) : [];
    return { controls, applied, history };
  } catch {
    return fresh;
  }
}

/** The stage plan with its step rate and identity replaced by those of the applied run. */
export function effectiveStage(
  stage: Stage,
  applied: AppliedConfig,
): { stage: Stage; profile: RunProfile } {
  const profile = runProfile(stage.id, applied.config);
  return {
    profile,
    stage: {
      ...stage,
      experimentId: experimentId(stage.id, applied.config, applied.appliedAt),
      run: { ...stage.run, stepsPerSecond: profile.stepsPerSecond },
    },
  };
}

export function lastCheckpointStep(stage: Stage, step: number): number {
  return Math.floor(step / stage.run.checkpointEvery) * stage.run.checkpointEvery;
}

/**
 * Apply a new configuration to a stage: archive the running experiment, restart from its last
 * checkpoint under the new identity, and keep the run's running/paused state.
 */
export function applyConfig(
  session: LabSession,
  stageId: StageId,
  config: RunConfig,
  now: number,
): LabSession {
  const base = stageById(stageId)!;
  const current = effectiveStage(base, session.applied[stageId]);
  const control = session.controls[stageId];
  const step = stepAt(control, current.stage.run, now);
  const restartStep = lastCheckpointStep(current.stage, step);
  const record: RunRecord = {
    experimentId: current.stage.experimentId,
    stage: stageId,
    config: session.applied[stageId].config,
    startedAt: session.applied[stageId].appliedAt,
    endedAt: now,
    finalStep: Math.floor(step),
    reason: "reconfigured",
  };
  return {
    controls: {
      ...session.controls,
      [stageId]: { status: control.status, step: restartStep, at: now },
    },
    applied: { ...session.applied, [stageId]: { config, appliedAt: now } },
    history: [record, ...session.history].slice(0, 50),
  };
}

/** Resume a stage from one of its written checkpoints. Recorded in history as its own event. */
export function resumeFromCheckpoint(
  session: LabSession,
  stageId: StageId,
  checkpointStep: number,
  now: number,
): LabSession {
  const base = stageById(stageId)!;
  const current = effectiveStage(base, session.applied[stageId]);
  const step = stepAt(session.controls[stageId], current.stage.run, now);
  const record: RunRecord = {
    experimentId: current.stage.experimentId,
    stage: stageId,
    config: session.applied[stageId].config,
    startedAt: session.applied[stageId].appliedAt,
    endedAt: now,
    finalStep: Math.floor(step),
    reason: "resumed-from-checkpoint",
  };
  return {
    ...session,
    controls: {
      ...session.controls,
      [stageId]: { status: "running", step: Math.min(checkpointStep, step), at: now },
    },
    history: [record, ...session.history].slice(0, 50),
  };
}

/** Stop a stage: it is paused at its current step and the stop is recorded. */
export function stopRun(session: LabSession, stageId: StageId, now: number): LabSession {
  const base = stageById(stageId)!;
  const current = effectiveStage(base, session.applied[stageId]);
  const step = stepAt(session.controls[stageId], current.stage.run, now);
  const record: RunRecord = {
    experimentId: current.stage.experimentId,
    stage: stageId,
    config: session.applied[stageId].config,
    startedAt: session.applied[stageId].appliedAt,
    endedAt: now,
    finalStep: Math.floor(step),
    reason: "stopped",
  };
  return {
    ...session,
    controls: { ...session.controls, [stageId]: { status: "paused", step, at: now } },
    history: [record, ...session.history].slice(0, 50),
  };
}

/**
 * Where a stage's weights come from. Stage 1 starts from the public backbone; each later stage
 * warm-starts from the best checkpoint its predecessor has written so far, which is an interim
 * snapshot until that predecessor completes. A predecessor with no checkpoint blocks the stage.
 */
export interface Lineage {
  readonly source: "backbone" | "checkpoint" | "blocked";
  readonly parent?:
    | {
        readonly stage: Stage;
        readonly experimentId: string;
        readonly step: number;
        readonly interim: boolean;
      }
    | undefined;
}

export function lineageOf(session: LabSession, stageId: StageId, now: number): Lineage {
  const index = STAGES.findIndex((stage) => stage.id === stageId);
  if (index <= 0) return { source: "backbone" };
  const parentBase = STAGES[index - 1]!;
  const parent = effectiveStage(parentBase, session.applied[parentBase.id]);
  const parentStep = stepAt(session.controls[parentBase.id], parent.stage.run, now);
  const checkpointStep = lastCheckpointStep(parent.stage, parentStep);
  if (checkpointStep <= 0)
    return {
      source: "blocked",
      parent: {
        stage: parent.stage,
        experimentId: parent.stage.experimentId,
        step: 0,
        interim: true,
      },
    };
  return {
    source: "checkpoint",
    parent: {
      stage: parent.stage,
      experimentId: parent.stage.experimentId,
      step: checkpointStep,
      interim: parentStep < parent.stage.run.totalSteps,
    },
  };
}
