import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ContractLiveCard } from "@/components/modellab/ContractLiveCard";
import { RunClockProvider } from "@/components/modellab/flow/RunClockContext";
import { groupAdvantages } from "@/components/modellab/flow/stepFlow";
import { MixtureLiveCard } from "@/components/modellab/MixtureLiveCard";
import { SampleStrip } from "@/components/modellab/SampleStrip";
import { edgeWidth, joinGraph } from "@/components/modellab/visual/joinGraph";
import {
  claimsOf,
  groupRewards,
  kdDistributions,
  klDivergence,
} from "@/components/modellab/visual/sampleVisuals";
import { buildPlantRegister } from "@/lib/canvas/engineering";
import { buildAdjacency, drawing as fixture, type CanvasDrawing } from "@/lib/canvas/model";
import { fieldClassesFor } from "@/lib/investigation/model";
import { DEFAULT_CONFIG, GROUP_SIZE, runProfile } from "@/lib/modellab/config";
import {
  alignmentMatrix,
  availability,
  buildSamples,
  corpusFacts,
  groundedAnswer,
  verifyAnswer,
} from "@/lib/modellab/samples";
import { stageById, type Stage, type StageId } from "@/lib/modellab/stages";
import { frameAt } from "@/lib/modellab/telemetry";

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
const facts = corpusFacts(drawing, register, "demo", null, null, NOW);

function effective(id: StageId): Stage {
  const base = stageById(id)!;
  const rate = runProfile(id, DEFAULT_CONFIG[id]).stepsPerSecond;
  return { ...base, run: { ...base.run, stepsPerSecond: rate } };
}

function liveProps(id: StageId, step: number) {
  const stage = effective(id);
  const config = DEFAULT_CONFIG[id];
  return {
    stage,
    step,
    progress: step / stage.run.totalSteps,
    now: NOW,
    running: false,
    config,
    profile: runProfile(id, config),
  };
}

describe("join graph", () => {
  it("routes every pretraining alignment pair through its join key, zeros kept as no-join", () => {
    const graph = joinGraph(effective("pretraining"), facts);
    const matrix = alignmentMatrix(facts);
    const edge = (from: string, to: string) =>
      graph.edges.find((e) => e.from === from && e.to === to);
    expect(edge("pid", "node_id")?.count).toBe(matrix[0]![1]);
    expect(edge("graph", "node_id")?.count).toBe(matrix[0]![1]);
    // No photograph is time-stamped against a trend: the join is drawn, empty.
    expect(graph.joins.find((j) => j.id === "timestamp")?.count).toBe(0);
    expect(edge("images", "timestamp")?.count).toBe(0);
    expect(graph.inputs.map((i) => i.id)).toContain("spatial");
  });

  it("conserves each dataset row's real count from source to key", () => {
    for (const id of ["sft", "distillation"] as const) {
      const stage = effective(id);
      const graph = joinGraph(stage, facts);
      const counts = availability(id, facts);
      for (const source of graph.sources) {
        expect(source.count).toBe(counts.get(source.id)?.count ?? 0);
        const out = graph.edges.filter((e) => e.stage === "join" && e.from === source.id);
        expect(out.length).toBeGreaterThan(0);
        for (const e of out) expect(e.count).toBe(source.count);
      }
      const into = graph.edges
        .filter((e) => e.stage === "join")
        .reduce((sum, e) => sum + e.count, 0);
      expect(graph.joins.reduce((sum, j) => sum + j.count, 0)).toBe(into);
    }
  });

  it("widens edges monotonically on a log scale and draws nothing for zero", () => {
    expect(edgeWidth(0, 100)).toBe(0);
    expect(edgeWidth(1, 100)).toBeLessThan(edgeWidth(10, 100));
    expect(edgeWidth(100, 100)).toBeCloseTo(10, 9);
  });
});

describe("ContractLiveCard", () => {
  it("draws the join graph for every dataset stage, and no prose footnote", () => {
    for (const id of ["pretraining", "sft", "distillation"] as const) {
      const { unmount, container } = render(
        <ContractLiveCard {...liveProps(id, 1200)} facts={facts} />,
      );
      const figure = screen.getByRole("img", {
        name: /join graph\. Sources, available now/,
      });
      expect(figure.getAttribute("aria-label")).toMatch(/Joined on: [a-z_]+ \d/);
      expect(container.textContent).not.toMatch(
        /Counts are derived from the loaded corpus/,
      );
      unmount();
    }
  });

  it("draws the reward contract as weights whose contributions sum to the batch total", () => {
    render(<ContractLiveCard {...liveProps("rl", 400)} facts={facts} />);
    const figure = screen.getByRole("img", { name: /^Reward contract at step 400/ });
    expect(figure.getAttribute("aria-label")).toMatch(
      /Hallucination penalty weight -0\.20/,
    );
    expect(figure.getAttribute("aria-label")).toMatch(/Batch total [+−]\d\.\d{3}/);
  });
});

describe("MixtureLiveCard", () => {
  it("streams the recent batches against the planned shares, advancing with the step", () => {
    const { unmount } = render(<MixtureLiveCard {...liveProps("sft", 500)} />);
    const figure = screen.getByRole("img", {
      name: /^Instruction mixture, last 32 batches/,
    });
    expect(figure.getAttribute("aria-label")).toMatch(/to step 500/);
    expect(figure.getAttribute("aria-label")).toMatch(/Plant QA: plan 25%/);
    unmount();
    render(<MixtureLiveCard {...liveProps("sft", 501)} />);
    expect(screen.getByRole("img", { name: /to step 501/ })).toBeTruthy();
  });
});

describe("sample visuals", () => {
  it("splits a grounded answer into claims tagged with their evidence", () => {
    const stage = effective("sft");
    const sample = buildSamples(stage, drawing, register, adjacency)[0]!;
    const answer = groundedAnswer(sample, register, NOW);
    const claims = claimsOf(answer);
    expect(claims.map((c) => c.text).join(" ")).toBe(answer.text);
    expect(claims[0]!.kind).toBe("P&ID");
    if (answer.cites.includes("Topology"))
      expect(claims.some((c) => c.kind === "Topology")).toBe(true);
  });

  it("reproduces the architecture figure's advantages from the group rewards", () => {
    for (const step of [3, 57, 400]) {
      const rewards = groupRewards(step, 0.55, 0, GROUP_SIZE);
      const mean = rewards.reduce((a, b) => a + b, 0) / rewards.length;
      const std = Math.sqrt(
        rewards.reduce((a, b) => a + (b - mean) ** 2, 0) / rewards.length,
      );
      const advantages = groupAdvantages(step, 0.55, 0, GROUP_SIZE);
      rewards.forEach((r, k) => expect((r - mean) / std).toBeCloseTo(advantages[k]!, 9));
    }
    const flat = groupRewards(9, 0.4, 1, GROUP_SIZE);
    expect(new Set(flat).size).toBe(1);
  });

  it("draws teacher and student distributions whose KL is the run's KL term", () => {
    for (const target of [0.05, 0.2, 0.34, 0.9]) {
      const { teacher, student, kl } = kdDistributions("n1", 7, target);
      expect(kl).toBeCloseTo(target, 4);
      expect(teacher.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
      expect(student.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
      expect(kl).toBeCloseTo(klDivergence(teacher, student), 12);
      expect(kl).toBeLessThanOrEqual(target + 1e-6);
    }
    expect(kdDistributions("n1", 7, 0).kl).toBeCloseTo(0, 9);
  });
});

describe("SampleStrip figures", () => {
  function strip(id: "rl" | "distillation" | "sft") {
    const stage = effective(id);
    const config = DEFAULT_CONFIG[id];
    const profile = runProfile(id, config);
    const samples = buildSamples(stage, drawing, register, adjacency);
    const sample = samples[0]!;
    const answer = groundedAnswer(sample, register, NOW);
    const student = groundedAnswer(sample, register, NOW, true);
    const verification = verifyAnswer(
      answer.text,
      sample,
      drawing,
      register,
      adjacency,
      NOW,
    );
    const studentVerification = verifyAnswer(
      student.text,
      sample,
      drawing,
      register,
      adjacency,
      NOW,
    );
    return render(
      <RunClockProvider
        control={{ status: "paused", step: 240, at: 0, speed: 1 }}
        stage={stage}
        profile={profile}
        config={config}
        now={NOW}
        blocked={false}
      >
        <SampleStrip
          stage={stage}
          sample={sample}
          samples={samples}
          index={0}
          onChoose={() => undefined}
          autoCycle={false}
          onToggleCycle={() => undefined}
          drawing={drawing}
          imageUrl="/sheet.png"
          register={register}
          answer={answer}
          student={student}
          verification={verification}
          studentVerification={studentVerification}
          now={NOW}
          running={false}
        />
      </RunClockProvider>,
    );
  }

  it("keeps the overall verdict readable and draws the G = 8 group for RL", () => {
    const { container, unmount } = strip("rl");
    expect(container.textContent).toContain("Overall verifier result");
    expect(
      screen.getByRole("img", {
        name: new RegExp(`^Prompt group at step 240: ${GROUP_SIZE}`),
      }),
    ).toBeTruthy();
    unmount();
  });

  it("draws the distillation token distributions at the run's KL", () => {
    const stage = effective("distillation");
    const kl = frameAt(
      {
        stage,
        profile: runProfile("distillation", DEFAULT_CONFIG.distillation),
        config: DEFAULT_CONFIG.distillation,
      },
      240,
    ).klTerm!;
    strip("distillation");
    const figure = screen.getByRole("img", { name: /^Top-8 next-token distributions/ });
    expect(figure.getAttribute("aria-label")).toContain(`forward KL ${kl.toFixed(3)}`);
    expect(
      screen.getByRole("group", { name: "Teacher and student responses" }),
    ).toBeTruthy();
  });

  it("shows the SFT response as grounded claim spans under its loss mask", () => {
    strip("sft");
    const trace = screen.getByRole("group", { name: "Reasoning trace" });
    expect(trace.querySelectorAll("a").length).toBeGreaterThan(0);
    expect(trace.textContent).toMatch(/−100 · \d+/);
  });
});
