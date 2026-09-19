import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  ACCELERATORS,
  BACKBONES,
  DEFAULT_CONFIG,
  GRAPH_ENCODERS,
  SPATIAL_ENCODERS,
  memoryBreakdown,
  runProfile,
  type RunConfig,
} from "@/lib/modellab/config";
import type { LabSample } from "@/lib/modellab/samples";
import { STAGES, type StageId } from "@/lib/modellab/stages";
import {
  PACKING,
  buildLanes,
  packSequence,
  smartResize,
  visionRuleFor,
  type ConversionInput,
} from "@/components/modellab/visual/conversion";
import { ConversionDiagram } from "@/components/modellab/visual/ConversionDiagram";
import { ExecutionDiagrams } from "@/components/modellab/visual/ExecutionDiagrams";

const STAGE_IDS: readonly StageId[] = ["pretraining", "sft", "rl", "distillation"];

/** The memory formula as runProfile computed it before memoryBreakdown existed. */
function legacyMemory(stage: StageId, config: RunConfig): number {
  const backbone = BACKBONES.find((b) => b.id === config.backbone) ?? BACKBONES[0]!;
  const spatial =
    SPATIAL_ENCODERS.find((e) => e.id === config.spatial) ?? SPATIAL_ENCODERS[0]!;
  const graph = GRAPH_ENCODERS.find((e) => e.id === config.graph) ?? GRAPH_ENCODERS[0]!;
  const gpus = Math.max(1, config.nodes * config.gpusPerNode);
  const encodersB = (spatial.paramsM + graph.paramsM) / 1000;
  // Reinforcement learning under LoRA trains the adapters only; its encoders stay frozen.
  const encodersTrained = stage === "rl" ? 0 : encodersB;
  const trainableB =
    config.trainable === "full"
      ? backbone.params + encodersB
      : backbone.params * 0.015 + encodersTrained;
  const weightBytes = config.precision === "fp8" ? 1 : 2;
  const frozenGb =
    ((backbone.params +
      encodersB -
      (config.trainable === "full" ? backbone.params + encodersB : encodersTrained)) *
      weightBytes) /
    gpus;
  const trainedGb = (trainableB * 16) / gpus;
  const tokens = { pretraining: 4096, sft: 3072, rl: 2900, distillation: 2048 }[stage];
  const activationGb = 6 + (tokens / 4096) * (backbone.active / 33) * 14;
  return frozenGb + trainedGb + activationGb;
}

describe("memoryBreakdown", () => {
  it("is the formula runProfile uses, across the configuration space", () => {
    for (const stage of STAGE_IDS) {
      for (const backbone of BACKBONES)
        for (const accelerator of ACCELERATORS)
          for (const trainable of ["lora", "full"] as const)
            for (const precision of ["bf16", "fp8"] as const)
              for (const nodes of [1, 3, 8]) {
                const config: RunConfig = {
                  ...DEFAULT_CONFIG[stage],
                  backbone: backbone.id,
                  accelerator: accelerator.id,
                  trainable,
                  precision,
                  nodes,
                };
                const parts = memoryBreakdown(stage, config);
                const profile = runProfile(stage, config);
                expect(profile.memoryPerGpuGb).toBe(legacyMemory(stage, config));
                expect(profile.memoryPerGpuGb).toBe(parts.totalGb);
                expect(profile.trainableB).toBe(parts.trainableB);
                const sum =
                  parts.frozenGb +
                  parts.weightsGb +
                  parts.gradientsGb +
                  parts.optimizerGb +
                  parts.activationGb;
                expect(sum).toBeCloseTo(parts.totalGb, 9);
                // 2 B weight + 2 B gradient + 12 B optimizer state per trainable parameter.
                expect(parts.optimizerGb).toBeCloseTo(parts.weightsGb * 6, 9);
              }
    }
  });
});

describe("vision token rules", () => {
  it("snaps Qwen images to the merge grid and clamps the pixel count", () => {
    expect(smartResize(500, 700, 32, 65536, 16777216)).toEqual([512, 704]);
    // Too small: scaled up to at least the minimum pixel count.
    const [h, w] = smartResize(40, 40, 32, 65536, 16777216);
    expect(h * w).toBeGreaterThanOrEqual(65536);
  });
  it("counts one position per merged 32-px cell plus two boundaries for Qwen3-VL", () => {
    const rule = visionRuleFor(BACKBONES.find((b) => b.family === "Qwen3-VL")!);
    const estimate = rule.estimate(704, 512);
    expect(estimate.cols * estimate.rows).toBe(22 * 16);
    expect(estimate.positions).toBe(22 * 16 + 2);
    expect(estimate.shape).toBe(`pixel_values [${22 * 16 * 4}, 1536]`);
  });
  it("gives Llama cross-attention images a single sequence position", () => {
    const rule = visionRuleFor(BACKBONES.find((b) => b.family === "Llama 3.2")!);
    expect(rule.estimate(1200, 800)).toMatchObject({ positions: 1, crossAttention: true });
  });
});

const sample = {
  nodeId: "n1",
  annotationId: "ann-1",
  tag: "P-101",
  name: "Feed pump",
  fieldClass: "Pump",
  image: "/demo/field.png",
  box: { x: 10, y: 20, width: 50, height: 40 },
  node: { id: "n1", kind: "pump", x: 200, y: 200, width: 40, height: 40 },
  asset: {},
  line: undefined,
  neighbours: [
    { id: "n2", tag: "V-1", name: "Vessel", group: "process", hops: 1, sampled: false },
    { id: "n3", tag: "E-2", name: "Exchanger", group: "process", hops: 2, sampled: false },
  ],
  joinedCount: 4,
  evidence: { fieldImages: 1, pid: 1, twin: 1, graph: 4, timeSeries: 2, manuals: 0 },
} as unknown as LabSample;

const answer = {
  question: "What is P-101 connected to?",
  text: "P-101 is a feed pump connected to V-1 and E-2.",
  cites: ["P&ID"] as const,
};

function inputFor(stage: StageId, sized = true): ConversionInput {
  const config = DEFAULT_CONFIG[stage];
  return {
    stage,
    config,
    profile: runProfile(stage, config),
    sample,
    answer: { ...answer, cites: [...answer.cites] },
    fieldSize: sized ? { width: 1400, height: 1000 } : undefined,
  };
}

describe("packed sequence", () => {
  it("supervises exactly the positions each stage trains on", () => {
    const loss = (stage: StageId) => {
      const input = inputFor(stage);
      return packSequence(input, buildLanes(input)).spans.map((span) => [
        span.id,
        span.loss,
      ]);
    };
    expect(Object.fromEntries(loss("pretraining"))).toMatchObject({
      vision: "align",
      text: "ntp",
    });
    const sft = Object.fromEntries(loss("sft"));
    expect(sft.response).toBe("response");
    expect(sft.system).toBe("none");
    expect(sft.instruction).toBe("none");
    expect(Object.fromEntries(loss("rl")).response).toBe("advantage");
    const kd = loss("distillation").filter(([id]) => id !== "pad");
    expect(kd.every(([, kind]) => kind === "kd" || kind === "kd+ce")).toBe(true);
  });

  it("orders spans in model input order and pads only unpacked stages", () => {
    const sft = inputFor("sft");
    const packed = packSequence(sft, buildLanes(sft));
    expect(packed.spans.map((span) => span.id)).toEqual([
      "system",
      "vision",
      "drawing",
      "topology",
      "telemetry",
      "instruction",
      "response",
    ]);
    expect(PACKING.sft.packed).toBe(true);
    expect(packed.total).toBe(packed.used);
    const rl = inputFor("rl");
    const padded = packSequence(rl, buildLanes(rl));
    expect(padded.total % 64).toBe(0);
    expect(padded.spans.at(-1)?.id).toBe("pad");
  });

  it("marks the vision span pending until the image size is measured, never guessing", () => {
    const input = inputFor("sft", false);
    const lanes = buildLanes(input);
    const packed = packSequence(input, lanes);
    expect(lanes.find((lane) => lane.id === "vision")?.positions).toBeUndefined();
    expect(packed.pending).toBe(true);
    expect(packed.spans.some((span) => span.id === "vision")).toBe(false);
  });

  it("renders absent modalities with a one-word reason", () => {
    const lanes = buildLanes(inputFor("sft"));
    expect(lanes.find((lane) => lane.id === "spatial")?.absent).toBe("unmeasured");
    expect(lanes.find((lane) => lane.id === "documents")?.absent).toBe("none");
    for (const lane of lanes) if (lane.absent) expect(lane.absent).toMatch(/^\S+$/);
  });
});

describe("ExecutionDiagrams", () => {
  it("draws the applied device mesh and the HBM verdict", () => {
    const stage = STAGES.find((item) => item.id === "pretraining")!;
    const config = DEFAULT_CONFIG.pretraining;
    const profile = runProfile("pretraining", config);
    render(
      <ExecutionDiagrams
        stage={stage}
        step={10.5}
        running={false}
        config={config}
        profile={profile}
      />,
    );
    expect(
      screen.getByRole("img", {
        name: /Device mesh: 4 nodes × 8 H100 80GB, 32 ranks in one FSDP2 full-shard group/,
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("img", { name: /Per-GPU HBM by owner: .*no KV cache in training/ }),
    ).toBeTruthy();
    expect(screen.getByRole("img", { name: /Serving path, not connected/ })).toBeTruthy();
    expect(screen.getByText(/4×8 · DP 32/)).toBeTruthy();
  });
});

describe("ConversionDiagram", () => {
  it("states its lanes, packed sequence and rules in its accessible name, for every stage", () => {
    const drawing = {
      source: "demo",
      imagePath: "sheet.png",
      width: 1000,
      height: 800,
      directed: false,
      nodes: [
        sample.node,
        { id: "n2", kind: "vessel", x: 260, y: 210, width: 30, height: 30 },
      ],
      edges: [],
    };
    for (const stage of STAGE_IDS) {
      const config = DEFAULT_CONFIG[stage];
      const { unmount } = render(
        <ConversionDiagram
          stage={stage}
          config={config}
          profile={runProfile(stage, config)}
          sample={sample}
          drawing={drawing}
          answer={{ ...answer, cites: [...answer.cites] }}
        />,
      );
      const figure = screen.getByRole("group", { name: /^Input conversion for P-101/ });
      expect(figure.getAttribute("aria-label")).toMatch(/spatial absent \(unmeasured\)/);
      expect(figure.getAttribute("aria-label")).toMatch(/Packed sequence of \d+ positions/);
      expect(figure.getAttribute("aria-label")).toMatch(/Estimation rules: vision/);
      // The walkthrough draws the real crop, its patch grid and the projected subgraph.
      expect(
        screen.getByRole("img", { name: /^P&ID crop around P-101: 2 detected symbols/ }),
      ).toBeTruthy();
      expect(
        screen.getByRole("img", {
          name: /patch grid over the crop: \d+ by \d+ = \d+ visual tokens/,
        }),
      ).toBeTruthy();
      expect(
        screen.getByRole("img", {
          name: /^Subgraph of P-101: 2 neighbours shown of 4 reachable/,
        }),
      ).toBeTruthy();
      // No explanatory legend sentences are printed.
      expect(figure.textContent).not.toMatch(/B batch · L length/);
      unmount();
    }
  });
});

describe("reinforcement learning trainable set", () => {
  it("trains LoRA adapters only; the policy's encoders stay frozen", () => {
    const config = DEFAULT_CONFIG.rl;
    const backbone = BACKBONES.find((b) => b.id === config.backbone)!;
    expect(memoryBreakdown("rl", config).trainableB).toBeCloseTo(
      backbone.params * 0.015,
      9,
    );
    expect(memoryBreakdown("sft", DEFAULT_CONFIG.sft).trainableB).toBeGreaterThan(
      memoryBreakdown("rl", config).trainableB,
    );
  });
});
