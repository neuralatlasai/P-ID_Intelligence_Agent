import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, runProfile, type RunConfig } from "@/lib/modellab/config";
import {
  ACCELERATOR_TDP_W,
  configChanges,
  draftStepsPerSecond,
  etaSeconds,
  formatEta,
  gpuTelemetry,
  TELEMETRY_BUCKET_MS,
} from "@/lib/modellab/hardware";

/**
 * Simulated cluster telemetry must be a pure function of the configuration and the clock, stay
 * physically plausible, and agree with the planning estimate it is derived from.
 */

const NOW = Date.UTC(2026, 8, 16, 15, 0, 0);
const config = DEFAULT_CONFIG.pretraining;
const profile = runProfile("pretraining", config);

describe("gpuTelemetry", () => {
  it("is deterministic for the same inputs and within a 5-second bucket", () => {
    const a = gpuTelemetry(profile, config, profile.stepsPerSecond, true, NOW);
    const b = gpuTelemetry(profile, config, profile.stepsPerSecond, true, NOW);
    expect(a).toEqual(b);
    const bucketStart = Math.floor(NOW / TELEMETRY_BUCKET_MS) * TELEMETRY_BUCKET_MS;
    const later = gpuTelemetry(
      profile,
      config,
      profile.stepsPerSecond,
      true,
      bucketStart + 4_999,
    );
    expect(later.nodes).toEqual(
      gpuTelemetry(profile, config, profile.stepsPerSecond, true, bucketStart).nodes,
    );
  });

  it("lays out one sample per configured GPU", () => {
    const t = gpuTelemetry(profile, config, profile.stepsPerSecond, true, NOW);
    expect(t.nodes).toHaveLength(config.nodes);
    expect(t.gpuCount).toBe(config.nodes * config.gpusPerNode);
    expect(t.nodes[0]!.name).toBe("node-01");
    expect(t.simulated).toBe(true);
  });

  it("idles when not running and loads up when running", () => {
    const tdp = ACCELERATOR_TDP_W.h100!;
    for (let k = 0; k < 40; k += 1) {
      const now = NOW + k * 37_000;
      const idle = gpuTelemetry(profile, config, profile.stepsPerSecond, false, now);
      const busy = gpuTelemetry(profile, config, profile.stepsPerSecond, true, now);
      expect(idle.samplesPerSecond).toBe(0);
      expect(idle.interconnect.state).toBe("idle");
      for (const node of idle.nodes) {
        for (const gpu of node.gpus) {
          expect(gpu.utilPct).toBeGreaterThanOrEqual(3);
          expect(gpu.utilPct).toBeLessThanOrEqual(8);
          expect(gpu.powerW).toBeLessThan(tdp * 0.12);
        }
      }
      expect(busy.avgUtilPct).toBeGreaterThan(85);
      expect(busy.powerKw).toBeGreaterThan(idle.powerKw * 5);
      for (const node of busy.nodes) {
        for (const gpu of node.gpus) {
          expect(gpu.powerW).toBeLessThanOrEqual(tdp);
          if (!gpu.hot) {
            expect(gpu.tempC).toBeGreaterThanOrEqual(62);
            expect(gpu.tempC).toBeLessThanOrEqual(78);
          }
        }
      }
    }
  });

  it("never reports more memory than the accelerator has", () => {
    const heavy: RunConfig = {
      ...config,
      backbone: "llama-3.2-90b-vision",
      accelerator: "l40s",
      nodes: 1,
      gpusPerNode: 4,
      trainable: "full",
    };
    const heavyProfile = runProfile("pretraining", heavy);
    expect(heavyProfile.fits).toBe(false);
    for (const [cfg, prof] of [
      [config, profile],
      [heavy, heavyProfile],
    ] as const) {
      const t = gpuTelemetry(prof, cfg, prof.stepsPerSecond, true, NOW);
      for (const node of t.nodes) {
        for (const gpu of node.gpus) {
          expect(gpu.memUsedGb).toBeLessThanOrEqual(gpu.memTotalGb);
          expect(gpu.memTotalGb).toBe(prof.accelerator.memoryGb);
        }
      }
    }
  });

  it("keeps live samples/s within ±5 % of the planning estimate", () => {
    for (let k = 0; k < 200; k += 1) {
      const t = gpuTelemetry(
        profile,
        config,
        profile.stepsPerSecond,
        true,
        NOW + k * 5_000,
      );
      const ratio = t.samplesPerSecond / profile.samplesPerSecond;
      expect(ratio).toBeGreaterThan(0.95);
      expect(ratio).toBeLessThan(1.05);
      expect(t.tokensPerSecond).toBeCloseTo(
        t.samplesPerSecond * profile.tokensPerSample,
        6,
      );
    }
  });

  it("produces a straggler and a hot spot some of the time, deterministically", () => {
    let stragglers = 0;
    let hot = 0;
    for (let k = 0; k < 120; k += 1) {
      const t = gpuTelemetry(
        profile,
        config,
        profile.stepsPerSecond,
        true,
        NOW + k * 180_000,
      );
      if (t.straggler) {
        stragglers += 1;
        expect(t.straggler.utilPct).toBeLessThan(80);
      }
      if (t.hotSpot) hot += 1;
    }
    expect(stragglers).toBeGreaterThan(0);
    expect(stragglers).toBeLessThan(120);
    expect(hot).toBeGreaterThan(0);
  });
});

describe("draft ETA", () => {
  it("counts changed fields", () => {
    expect(configChanges(config, config)).toEqual([]);
    expect(configChanges(config, { ...config, nodes: 6, precision: "fp8" }).sort()).toEqual(
      ["nodes", "precision"],
    );
  });

  it("scales the applied step rate by the ratio of planning estimates", () => {
    const draft: RunConfig = { ...config, nodes: config.nodes * 2 };
    const draftProfile = runProfile("pretraining", draft);
    const applied = 1.6;
    const draftRate = draftStepsPerSecond(applied, profile, draftProfile);
    expect(draftRate).toBeCloseTo(applied * 2, 6);
    expect(draftStepsPerSecond(applied, profile, profile)).toBeCloseTo(applied, 9);

    const total = 100_000;
    const step = 40_000;
    expect(etaSeconds(total, step, applied)).toBeCloseTo(60_000 / 1.6, 6);
    expect(etaSeconds(total, step, draftRate)).toBeCloseTo(
      etaSeconds(total, step, applied) / 2,
      6,
    );
    expect(etaSeconds(total, total, applied)).toBe(0);
    expect(etaSeconds(total, step, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("formats compact ETAs", () => {
    expect(formatEta(3 * 86400 + 4 * 3600 + 120)).toBe("3d 4h");
    expect(formatEta(86400 + 9 * 3600)).toBe("1d 9h");
    expect(formatEta(5 * 3600 + 7 * 60)).toBe("5h 07m");
    expect(formatEta(12 * 60)).toBe("12m");
    expect(formatEta(20)).toBe("<1m");
    expect(formatEta(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("runProfile monotonicity", () => {
  it("more GPUs → more samples/s", () => {
    const counts = [1, 2, 4, 8];
    const rates = counts.map(
      (nodes) => runProfile("sft", { ...config, nodes }).samplesPerSecond,
    );
    for (let i = 1; i < rates.length; i += 1)
      expect(rates[i]!).toBeGreaterThan(rates[i - 1]!);
    expect(
      runProfile("sft", { ...config, gpusPerNode: 8 }).samplesPerSecond,
    ).toBeGreaterThan(runProfile("sft", { ...config, gpusPerNode: 4 }).samplesPerSecond);
  });

  it("FP8 on H100 is faster than BF16", () => {
    const h100 = { ...config, accelerator: "h100" };
    expect(
      runProfile("sft", { ...h100, precision: "fp8" }).samplesPerSecond,
    ).toBeGreaterThan(runProfile("sft", { ...h100, precision: "bf16" }).samplesPerSecond);
  });

  it("full fine-tune is slower than LoRA", () => {
    expect(
      runProfile("sft", { ...config, trainable: "full" }).samplesPerSecond,
    ).toBeLessThan(runProfile("sft", { ...config, trainable: "lora" }).samplesPerSecond);
  });
});

describe("telemetry and runtime cards render", () => {
  it("renders both cards with a pending draft that does not fit", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { STAGES } = await import("@/lib/modellab/stages");
    const { HardwareCard } = await import("@/components/modellab/HardwareCard");
    const { RuntimeConfigCard } = await import("@/components/modellab/RuntimeConfigCard");
    const stage = STAGES.find((s) => s.id === "pretraining")!;
    const live = {
      stage,
      step: 40_000,
      progress: 0.4,
      now: NOW,
      running: true,
      config,
      profile,
    };
    const hardware = renderToStaticMarkup(createElement(HardwareCard, live));
    expect(hardware).toContain("Simulated");
    expect(hardware).toContain("node-03");
    const draft: RunConfig = {
      ...config,
      accelerator: "l40s",
      trainable: "full",
      nodes: 1,
    };
    const noop = () => {};
    const runtime = renderToStaticMarkup(
      createElement(RuntimeConfigCard, {
        ...live,
        draft,
        onDraft: noop,
        onApply: noop,
        onDiscard: noop,
        statusChip: null,
      }),
    );
    expect(runtime).toContain("3 changes");
    expect(runtime).toContain("Does not fit");
    expect(runtime).toMatch(/<button[^>]*disabled[^>]*>Apply &amp; restart/);
    expect(`${hardware}${runtime}`).not.toMatch(/confidence\s*[:=]?\s*\d/i);
  });
});
