import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, experimentId, runProfile } from "@/lib/modellab/config";
import { stepAt } from "@/lib/modellab/run";
import {
  SESSION_KEY,
  applyConfig,
  effectiveStage,
  freshSession,
  lastCheckpointStep,
  lineageOf,
  loadSession,
  resumeFromCheckpoint,
  stopRun,
} from "@/lib/modellab/session";
import { stageById } from "@/lib/modellab/stages";

/**
 * A session is where the realism of the model lab lives: rates follow the configuration,
 * reconfiguring restarts from the last checkpoint, and every restart is recorded.
 */

const NOW = Date.UTC(2026, 8, 16, 18, 0, 0);
const pretraining = stageById("pretraining")!;

describe("planning estimate", () => {
  it("reports physically plausible throughput for a 33B model on 24 H100s", () => {
    const profile = runProfile("pretraining", DEFAULT_CONFIG.pretraining);
    // 6·N / 4·N FLOPs per token at 38 % MFU: thousands of tokens per GPU, not hundreds of samples.
    expect(profile.samplesPerSecond).toBeGreaterThan(3);
    expect(profile.samplesPerSecond).toBeLessThan(40);
    expect(profile.fits).toBe(true);
  });

  it("scales with GPUs and slows for full fine-tuning", () => {
    const base = DEFAULT_CONFIG.pretraining;
    const small = runProfile("pretraining", base);
    const large = runProfile("pretraining", { ...base, nodes: base.nodes * 2 });
    const full = runProfile("pretraining", { ...base, trainable: "full" });
    expect(large.samplesPerSecond).toBeCloseTo(small.samplesPerSecond * 2, 6);
    expect(full.samplesPerSecond).toBeLessThan(small.samplesPerSecond);
    expect(full.memoryPerGpuGb).toBeGreaterThan(small.memoryPerGpuGb);
  });

  it("derives a stable experiment id from configuration and apply time", () => {
    const a = experimentId("sft", DEFAULT_CONFIG.sft, NOW);
    expect(a).toMatch(/^exp-2026-09-16-sft-[0-9a-f]{6}$/);
    expect(experimentId("sft", DEFAULT_CONFIG.sft, NOW)).toBe(a);
    expect(experimentId("sft", { ...DEFAULT_CONFIG.sft, globalBatch: 256 }, NOW)).not.toBe(
      a,
    );
  });
});

describe("session", () => {
  it("opens every stage at its planned step with the default configuration", () => {
    const session = freshSession(NOW);
    const { stage } = effectiveStage(pretraining, session.applied.pretraining);
    expect(stepAt(session.controls.pretraining, stage.run, NOW)).toBe(
      pretraining.run.openingStep,
    );
    expect(stage.run.stepsPerSecond).toBeCloseTo(
      runProfile("pretraining", DEFAULT_CONFIG.pretraining).stepsPerSecond,
      9,
    );
  });

  it("restarts from the last checkpoint and archives the old run when reconfigured", () => {
    const session = freshSession(NOW);
    const next = applyConfig(
      session,
      "pretraining",
      { ...DEFAULT_CONFIG.pretraining, nodes: 6 },
      NOW,
    );
    const { stage } = effectiveStage(pretraining, next.applied.pretraining);
    expect(next.controls.pretraining.step).toBe(
      lastCheckpointStep(stage, pretraining.run.openingStep),
    );
    expect(next.history[0]?.reason).toBe("reconfigured");
    expect(stage.experimentId).not.toBe(
      effectiveStage(pretraining, session.applied.pretraining).stage.experimentId,
    );
  });

  it("rolls back to a checkpoint and stops with records", () => {
    const session = freshSession(NOW);
    const rolled = resumeFromCheckpoint(session, "sft", 1_000, NOW);
    expect(rolled.controls.sft.step).toBe(1_000);
    expect(rolled.history[0]?.reason).toBe("resumed-from-checkpoint");
    const stopped = stopRun(rolled, "sft", NOW + 1000);
    expect(stopped.controls.sft.status).toBe("paused");
    expect(stopped.history[0]?.reason).toBe("stopped");
  });

  it("warm-starts later stages from the predecessor's latest checkpoint and blocks without one", () => {
    const session = freshSession(NOW);
    const lineage = lineageOf(session, "sft", NOW);
    expect(lineage.source).toBe("checkpoint");
    expect(lineage.parent?.interim).toBe(true);
    expect(lineageOf(session, "pretraining", NOW).source).toBe("backbone");

    const empty = {
      ...session,
      controls: {
        ...session.controls,
        pretraining: { status: "paused" as const, step: 10, at: NOW },
      },
    };
    expect(lineageOf(empty, "sft", NOW).source).toBe("blocked");
  });

  it("survives corrupt storage and restores a valid saved session", () => {
    expect(loadSession(NOW, { getItem: () => "{not json" }).history).toEqual([]);
    const saved = applyConfig(
      freshSession(NOW),
      "rl",
      { ...DEFAULT_CONFIG.rl, accelerator: "h100" },
      NOW,
    );
    const restored = loadSession(NOW, {
      getItem: (key) => (key === SESSION_KEY ? JSON.stringify(saved) : null),
    });
    expect(restored.applied.rl.config.accelerator).toBe("h100");
    expect(restored.history).toHaveLength(1);
  });
});
