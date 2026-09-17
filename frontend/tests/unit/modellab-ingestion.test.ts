import { describe, expect, it } from "vitest";

import { buildPlantRegister } from "@/lib/canvas/engineering";
import { buildAdjacency, drawing as fixture, type CanvasDrawing } from "@/lib/canvas/model";
import { fieldClassesFor } from "@/lib/investigation/model";
import {
  batchRewards,
  deploymentMeasurements,
  ingestionFor,
  mixtureCounts,
  objectiveShares,
} from "@/lib/modellab/ingestion";
import { DEFAULT_CONFIG, runProfile } from "@/lib/modellab/config";
import { lastEvalStep, metricAtEval } from "@/lib/modellab/evaluation";
import { curveAt } from "@/lib/modellab/run";
import { availability, corpusFacts } from "@/lib/modellab/samples";
import { STAGES, stageById, type Stage } from "@/lib/modellab/stages";

/** A stage as the page runs it: the step rate of its default configuration. */
function effective(id: "pretraining" | "sft" | "rl" | "distillation"): Stage {
  const base = stageById(id)!;
  const rate = runProfile(id, DEFAULT_CONFIG[id]).stepsPerSecond;
  return { ...base, run: { ...base.run, stepsPerSecond: rate } };
}

/**
 * Live contract views mix real corpus counts with a simulated run. These tests pin that the
 * simulated side never inflates the real side, that shares and batches add up, and that
 * everything is a pure function of its inputs.
 */

const NOW = Date.UTC(2026, 8, 16, 15, 0, 0);
const drawing: CanvasDrawing = { ...fixture, imagePath: "PID2Graph OPEN100/0.png" };
const adjacency = buildAdjacency(drawing.nodes, drawing.edges, drawing.directed);
const register = buildPlantRegister(
  drawing,
  adjacency,
  NOW,
  new Set(["tank67"]),
  fieldClassesFor(drawing),
);
const demoFacts = corpusFacts(drawing, register, "demo", null, null, NOW);
const backendFacts = corpusFacts(drawing, register, "backend", 120, 480, NOW);

describe("ingestion", () => {
  const contractStages = STAGES.filter((stage) => stage.contract.length > 0);

  it("never consumes more than the corpus makes available", () => {
    for (const facts of [demoFacts, backendFacts]) {
      for (const stage of contractStages) {
        const available = availability(stage.id, facts);
        for (const step of [0, 1, 777, 12_345, 68_240, stage.run.totalSteps]) {
          for (const batch of [1, 64, 256, 4096]) {
            const rows = ingestionFor(stage, facts, step, batch, NOW + step * 997);
            for (const row of stage.contract) {
              const live = rows.get(row.id)!;
              const count = available.get(row.id)?.count ?? 0;
              expect(live.available).toBe(count);
              expect(live.consumed).toBeGreaterThanOrEqual(0);
              expect(live.consumed).toBeLessThanOrEqual(count);
              expect(live.epochShare).toBeGreaterThanOrEqual(0);
              expect(live.epochShare).toBeLessThan(1);
            }
          }
        }
      }
    }
  });

  it("reports Not connected when a row has nothing, or no real source", () => {
    const distillation = stageById("distillation")!;
    const rows = ingestionFor(distillation, backendFacts, 20_000, 128, NOW);
    expect(rows.get("dialogues")!.status).toBe("Not connected");
    expect(rows.get("dialogues")!.consumed).toBe(0);

    const empty = { ...backendFacts, telemetryTags: 0 };
    const pretraining = stageById("pretraining")!;
    const pre = ingestionFor(pretraining, empty, 50_000, 256, NOW);
    expect(pre.get("ts")!.status).toBe("Not connected");
    for (const row of pre.values()) {
      if (row.available === 0) expect(row.status).toBe("Not connected");
    }
  });

  it("labels offline fixture rows honestly and syncs backend rows on schedule", () => {
    const pretraining = stageById("pretraining")!;
    const offline = ingestionFor(pretraining, demoFacts, 1000, 256, NOW);
    expect(offline.get("pid")!.syncLabel).toMatch(/bundled fixture/i);
    expect(offline.get("pid")!.lastSyncAt).toBeNull();

    const online = ingestionFor(pretraining, backendFacts, 1000, 256, NOW);
    const ts = online.get("ts")!;
    expect(ts.intervalSeconds).toBe(60);
    expect(ts.lastSyncAt).not.toBeNull();
    expect(ts.lastSyncAt!).toBeLessThanOrEqual(NOW);
    expect(NOW - ts.lastSyncAt!).toBeLessThan(2 * 60_000);
  });

  it("is deterministic", () => {
    const stage = stageById("sft")!;
    const a = ingestionFor(stage, backendFacts, 4321, 128, NOW);
    const b = ingestionFor(stage, backendFacts, 4321, 128, NOW);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });
});

describe("objective shares", () => {
  it("sum to one and follow the stage's loss curves", () => {
    for (const id of ["pretraining", "sft"] as const) {
      const stage = stageById(id)!;
      for (const step of [0, 500, 20_000, stage.run.totalSteps]) {
        const shares = objectiveShares(stage, step);
        expect(shares.length).toBeGreaterThan(0);
        const total = shares.reduce((sum, item) => sum + item.share, 0);
        expect(total).toBeCloseTo(1, 9);
        const weights = shares.reduce((sum, item) => sum + item.weight, 0);
        expect(weights).toBeCloseTo(1, 9);
      }
    }
    expect(objectiveShares(stageById("rl")!, 100)).toEqual([]);
  });
});

describe("instruction mixture", () => {
  it("composes each batch to exactly the global batch, and changes with the step", () => {
    const compositions = new Set<string>();
    for (const batch of [1, 7, 64, 128, 256, 1024]) {
      for (let step = 0; step < 60; step += 1) {
        const mix = mixtureCounts(step + 0.4, batch, NOW);
        const sum = mix.families.reduce((acc, family) => acc + family.lastBatch, 0);
        expect(sum).toBe(batch);
        const seen = mix.families.reduce((acc, family) => acc + family.seen, 0);
        expect(seen).toBe(step * batch);
        if (batch === 128) compositions.add(mix.families.map((f) => f.lastBatch).join(","));
      }
    }
    expect(compositions.size).toBeGreaterThan(10);
  });

  it("is deterministic", () => {
    expect(mixtureCounts(18_240.7, 128, NOW)).toEqual(mixtureCounts(18_240.7, 128, NOW));
  });
});

describe("deployment measurements", () => {
  it("marks the local profile Ready exactly when p95 is under one second", () => {
    let sawReady = false;
    let sawPending = false;
    const stage = effective("distillation");
    for (let index = 0; index <= 200; index += 1) {
      const measured = deploymentMeasurements(
        stage,
        (index / 200) * stage.run.totalSteps,
        NOW,
      );
      const localProfile = measured.targets.find((target) => target.id === "local")!;
      expect(localProfile.status === "Ready").toBe(localProfile.p95 < 1);
      if (localProfile.status === "Ready") sawReady = true;
      else sawPending = true;
      for (const target of measured.targets) {
        expect(target.p95).toBeGreaterThanOrEqual(target.p50);
      }
    }
    expect(sawReady).toBe(true);
    expect(sawPending).toBe(true);
  });

  it("is deterministic and changes only when an evaluation publishes", () => {
    const stage = effective("distillation");
    expect(deploymentMeasurements(stage, 26_431, NOW)).toEqual(
      deploymentMeasurements(stage, 26_431, NOW),
    );
    const a = deploymentMeasurements(stage, 26_500, NOW);
    const b = deploymentMeasurements(stage, 26_900, NOW);
    expect(lastEvalStep(stage, 26_500)).toBe(lastEvalStep(stage, 26_900));
    expect(a.targets).toEqual(b.targets);
  });

  it("reports the local profile with the metrics table's numbers at the same evaluation", () => {
    const stage = effective("distillation");
    const step = stage.run.openingStep + 321;
    const local = deploymentMeasurements(stage, step, NOW).targets.find(
      (target) => target.id === "local",
    )!;
    const metric = (prefix: string) =>
      metricAtEval(stage.metrics.find((m) => m.label.startsWith(prefix))!, stage, step);
    expect(local.p50).toBeCloseTo(metric("Latency per sample"), 9);
    expect(local.tokensPerSecond).toBeCloseTo(metric("Throughput"), 9);
    expect(local.memoryGb).toBeCloseTo(metric("Peak VRAM"), 9);
  });
});

describe("batch rewards", () => {
  it("keeps the penalty negative and scores within bounds", () => {
    const stage = stageById("rl")!;
    const rewards = batchRewards(stage, 53_556, 0.53);
    expect(rewards).toHaveLength(stage.rewards!.length);
    // One decomposition of the plotted mean reward, not a second estimate of it.
    const mean = curveAt(
      stage.curves.flatMap((tab) => tab.curves).find((curve) => curve.key === "reward")!,
      53_556,
    );
    expect(rewards.reduce((sum, reward) => sum + reward.value, 0)).toBeCloseTo(mean, 6);
    for (const reward of rewards) {
      expect(reward.score).toBeGreaterThanOrEqual(0);
      expect(reward.score).toBeLessThanOrEqual(1);
      expect(Math.sign(reward.value) || 1).toBe(Math.sign(reward.weight));
    }
  });
});
