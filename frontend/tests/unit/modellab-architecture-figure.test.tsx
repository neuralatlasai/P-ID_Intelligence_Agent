import { render } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import { ArchitectureFigure } from "@/components/modellab/ArchitectureFigure";
import { RunClockProvider } from "@/components/modellab/flow/RunClockContext";
import {
  accumulation,
  liveTerms,
  momentOf,
  stepSegments,
} from "@/components/modellab/flow/stepFlow";
import { buildPlantRegister } from "@/lib/canvas/engineering";
import { buildAdjacency, drawing as fixture, type CanvasDrawing } from "@/lib/canvas/model";
import { fieldClassesFor } from "@/lib/investigation/model";
import { architectureSpec } from "@/lib/modellab/architecture";
import { DEFAULT_CONFIG, runProfile, type RunConfig } from "@/lib/modellab/config";
import { corpusFacts } from "@/lib/modellab/samples";
import { STAGES, type Stage } from "@/lib/modellab/stages";
import { frameAt } from "@/lib/modellab/telemetry";

/**
 * Figure 03 drawn at many instants of a step, for every stage: it must render every phase,
 * name the phase and step in its accessible label, carry gradient only where the phase is
 * backward, and keep the one reference packet the end-to-end suite looks for.
 */

const NOW = Date.UTC(2026, 8, 17, 16, 0, 0);
const drawing: CanvasDrawing = { ...fixture, imagePath: "PID2Graph OPEN100/0.png" };
const adjacency = buildAdjacency(drawing.nodes, drawing.edges, drawing.directed);
const register = buildPlantRegister(
  drawing,
  adjacency,
  NOW,
  new Set(["tank67"]),
  fieldClassesFor(drawing),
);
const facts = corpusFacts(drawing, register, "demo", null, null, NOW);

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  globalThis.IntersectionObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
});

describe("architecture figure", () => {
  for (const stage of STAGES) {
    const config = DEFAULT_CONFIG[stage.id];
    const profile = runProfile(stage.id, config);
    const spec = architectureSpec(stage, config, profile, facts);
    const base = stage.run.openingStep;
    const frame = frameAt({ stage, profile, config }, base + 1);
    const segments = stepSegments(stage.id, frame, accumulation(config, profile.gpus));

    it(`${stage.id}: draws every phase of a step`, () => {
      const seen = new Set<string>();
      for (let i = 0; i < 60; i += 1) {
        const fraction = (i + 0.5) / 60;
        const phase = momentOf(segments, fraction).segment.phase;
        const { container, unmount } = render(
          <RunClockProvider
            control={{ status: "paused", step: base + fraction, at: 0, speed: 1 }}
            stage={stage}
            profile={profile}
            config={config}
            now={NOW}
            blocked={false}
          >
            <ArchitectureFigure
              spec={spec}
              running={false}
              sampleTag="T-1"
              stepSeconds={10}
            />
          </RunClockProvider>,
        );
        const figure = container.querySelector("figure")!;
        expect(figure.getAttribute("aria-label")).toMatch(/^FIGURE 03 .* step [\d,]+ of/);
        expect(container.querySelectorAll('[data-testid="reference-packet"]')).toHaveLength(
          1,
        );
        const gradient = container.querySelectorAll('path[data-style="grad"]').length;
        if (phase === "backward" || phase === "update_actor")
          seen.add(`${phase}:${gradient > 0}`);
        if (phase === "forward" || phase === "gen" || phase === "teacher") {
          expect(gradient, phase).toBe(0);
        }
        seen.add(phase);
        unmount();
      }
      for (const phase of new Set(segments.map((segment) => segment.phase))) {
        if (
          segments
            .filter((s) => s.phase === phase)
            .every((s) => s.seconds / frame.stepSeconds < 1 / 120)
        ) {
          continue; // Too short to be sampled at this resolution (advantages: 0.4 %).
        }
        expect(seen, phase).toContain(phase);
      }
      if (seen.has("backward")) expect(seen).toContain("backward:true");
      if (seen.has("update_actor")) expect(seen).toContain("update_actor:true");
    }, 60_000);
  }

  function renderAt(stage: Stage, config: RunConfig, step: number) {
    const profile = runProfile(stage.id, config);
    const spec = architectureSpec(stage, config, profile, facts);
    return {
      spec,
      ...render(
        <RunClockProvider
          control={{ status: "paused", step, at: 0, speed: 1 }}
          stage={stage}
          profile={profile}
          config={config}
          now={NOW}
          blocked={false}
        >
          <ArchitectureFigure spec={spec} running={false} />
        </RunClockProvider>,
      ),
    };
  }

  it("never truncates a label: box lines are identifiers and values", () => {
    const variants: [string, Partial<RunConfig>][] = [
      ["default", {}],
      ["full", { trainable: "full" }],
      ["no graph", { graph: "none" }],
      ["no points", { spatial: "none" }],
      ["MoE", { backbone: "qwen3-vl-30b-a3b" }],
      ["Llama", { backbone: "llama-3.2-90b-vision", graph: "gat-v2", spatial: "uni3d-g" }],
    ];
    for (const stage of STAGES) {
      for (const [name, change] of variants) {
        const config = { ...DEFAULT_CONFIG[stage.id], ...change };
        const { container, unmount } = renderAt(stage, config, stage.run.openingStep + 0.5);
        const svg = container.querySelector("svg[role=img]")!;
        const texts = [...svg.querySelectorAll("text")].map(
          (node) => node.textContent ?? "",
        );
        for (const text of texts) expect(text, `${stage.id} · ${name}`).not.toContain("…");
        unmount();
      }
    }
  }, 60_000);

  it("shows no sentence: the description is the figure's accessible description", () => {
    for (const stage of STAGES) {
      const { container, spec, unmount } = renderAt(
        stage,
        DEFAULT_CONFIG[stage.id],
        stage.run.openingStep + 0.5,
      );
      const figure = container.querySelector("figure")!;
      expect(
        spec.heading.split(/\s+/).filter((w) => /\w/.test(w)).length,
      ).toBeLessThanOrEqual(4);
      const description = container.querySelector(
        `#${CSS.escape(figure.getAttribute("aria-describedby")!)}`,
      );
      expect(description?.textContent).toBe(spec.description);
      expect(description?.className).toBe("srOnly");
      unmount();
    }
  });

  it("gauges read the step's gradient norm and learning rate", () => {
    for (const stage of STAGES) {
      const config = DEFAULT_CONFIG[stage.id];
      const step = stage.run.openingStep + 0.5;
      const { container, unmount } = renderAt(stage, config, step);
      const frame = frameAt(
        { stage, profile: runProfile(stage.id, config), config },
        Math.floor(step) + 1,
      );
      const text = container.querySelector("svg[role=img]")!.textContent ?? "";
      expect(text).toContain(`‖g‖ ${frame.gradNorm.toFixed(3)}`);
      expect(text).toContain(`lr ${frame.lr.toExponential(2)}`);
      unmount();
    }
  });

  it("draws the stage's own inset: sequence, rollout group or transfer", () => {
    const rl = STAGES.find((stage) => stage.id === "rl")!;
    const kd = STAGES.find((stage) => stage.id === "distillation")!;
    const rlView = renderAt(rl, DEFAULT_CONFIG.rl, rl.run.openingStep + 0.99);
    // After the update every completion has a reward cell and the group its advantages.
    expect(rlView.container.textContent).toContain("Â");
    rlView.unmount();
    const kdView = renderAt(kd, DEFAULT_CONFIG.distillation, kd.run.openingStep + 0.99);
    const kl = liveTerms(kd, kd.run.openingStep + 1).terms.find((t) => t.key === "kd-kl")!;
    expect(kdView.container.textContent).toContain(`KL ${kl.value.toFixed(4)}`);
    kdView.unmount();
  });

  it("draws a static specification outside a run clock", () => {
    const stage = STAGES[0]!;
    const config = DEFAULT_CONFIG[stage.id];
    const spec = architectureSpec(stage, config, runProfile(stage.id, config), facts);
    const { container } = render(
      <ArchitectureFigure
        spec={spec}
        running={false}
        sampleTag={undefined}
        stepSeconds={10}
      />,
    );
    expect(container.querySelector("figure")!.getAttribute("aria-label")).toBe(spec.figure);
    expect(container.querySelectorAll('[data-testid="reference-packet"]')).toHaveLength(0);
  });
});
