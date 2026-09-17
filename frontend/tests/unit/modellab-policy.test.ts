import { describe, expect, it } from "vitest";

import { buildPlantRegister } from "@/lib/canvas/engineering";
import { buildAdjacency, drawing as fixture, type CanvasDrawing } from "@/lib/canvas/model";
import { fieldClassesFor } from "@/lib/investigation/model";
import {
  POLICY_ERROR_KINDS,
  policyAnswer,
  rlPolicyProfile,
  rolloutIndexAt,
  sampleProvenance,
  studentProfile,
  teacherProfile,
  verifierFindings,
  type ErrorProfile,
  type PolicyErrorKind,
} from "@/lib/modellab/policy";
import { buildSamples, groundedAnswer, verifyAnswer } from "@/lib/modellab/samples";
import { STAGES } from "@/lib/modellab/stages";

/**
 * Policy rollouts are corrupted grounded answers. The point of these tests is that the real
 * verifier, reading only the text, catches each injected error — nothing is marked caught by
 * the code that injected it.
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
const rl = STAGES.find((stage) => stage.id === "rl")!;
const distillation = STAGES.find((stage) => stage.id === "distillation")!;
const samples = buildSamples(rl, drawing, register, adjacency);

const CLEAN: ErrorProfile = {
  hallucination: 0,
  wrongConnection: 0,
  staleReading: 0,
  missingCitation: 0,
  wrongLine: 0,
};
const only = (kind: PolicyErrorKind): ErrorProfile => ({ ...CLEAN, [kind]: 1 });

const rollout = (sample: (typeof samples)[number], profile: ErrorProfile, index = 7) => {
  const result = policyAnswer(sample, register, drawing, adjacency, NOW, profile, index);
  const verification = verifyAnswer(
    result.answer.text,
    sample,
    drawing,
    register,
    adjacency,
    NOW,
  );
  return { ...result, verification };
};

describe("policy rollouts", () => {
  it("has samples to roll out", () => {
    expect(samples.length).toBeGreaterThan(0);
  });

  it("leaves a clean rollout identical to the grounded answer, and it passes", () => {
    for (const sample of samples) {
      const { answer, injected, verification } = rollout(sample, CLEAN);
      expect(injected).toEqual([]);
      expect(answer.text).toBe(groundedAnswer(sample, register, NOW).text);
      expect(verification.pass).toBe(true);
    }
  });

  it("catches a hallucinated tag in the grounding parse", () => {
    for (const sample of samples) {
      const { injected, verification } = rollout(sample, only("hallucination"));
      const error = injected.find((e) => e.kind === "hallucination")!;
      expect(error).toBeDefined();
      expect(verification.fabricated).toContain(error.value);
      expect(verification.checks.find((c) => c.id === "grounding")!.score).toBeLessThan(1);
      expect(verification.pass).toBe(false);
      const [finding] = verifierFindings(injected, verification);
      expect(finding!.caught).toBe(true);
      expect(finding!.summary).toMatch(/caught by grounding parse/);
    }
  });

  it("fails topology for a connection the graph does not have", () => {
    for (const sample of samples) {
      const { injected, verification } = rollout(sample, only("wrongConnection"));
      expect(injected.map((e) => e.kind)).toEqual(["wrongConnection"]);
      const topology = verification.checks.find((c) => c.id === "topology")!;
      expect(topology.pass).toBe(false);
      expect(verification.fabricated).toEqual([]);
      expect(verification.pass).toBe(false);
      expect(verifierFindings(injected, verification)[0]!.caught).toBe(true);
    }
  });

  it("drops the simulator score for a stale reading", () => {
    let tried = 0;
    for (const sample of samples) {
      const clean = rollout(sample, CLEAN).verification;
      const { injected, verification } = rollout(sample, only("staleReading"));
      if (!injected.length) continue; // no reading claimed for this sample
      tried += 1;
      const before = clean.checks.find((c) => c.id === "simulator")!.score;
      const after = verification.checks.find((c) => c.id === "simulator")!;
      expect(after.score).toBeLessThan(before);
      expect(after.pass).toBe(false);
      expect(verifierFindings(injected, verification)[0]!.caught).toBe(true);
    }
    expect(tried).toBeGreaterThan(0);
  });

  it("removes the procedure citation, which the citation check catches", () => {
    let tried = 0;
    for (const sample of samples) {
      const { answer, injected, verification } = rollout(sample, only("missingCitation"));
      if (!injected.length) continue; // this asset holds no procedure document
      tried += 1;
      expect(answer.text).not.toMatch(/Procedure reference/);
      expect(answer.cites).not.toContain("Procedure");
      expect(verification.checks.find((c) => c.id === "citation")!.detail).toBe(
        "No document cited",
      );
      expect(verification.checks.find((c) => c.id === "citation")!.pass).toBe(false);
      expect(verifierFindings(injected, verification)[0]!.caught).toBe(true);
    }
    expect(tried).toBeGreaterThan(0);
  });

  it("names a real but wrong line, which the grounding parse catches", () => {
    const sample = samples.find((item) => item.line)!;
    const { answer, injected, verification } = rollout(sample, only("wrongLine"));
    expect(injected).toHaveLength(1);
    expect(answer.text).not.toContain(sample.line!.number);
    expect(verification.fabricated).toEqual([]);
    expect(verification.checks.find((c) => c.id === "grounding")!.pass).toBe(false);
    expect(verifierFindings(injected, verification)[0]!.caught).toBe(true);
  });

  it("is deterministic per rollout and varies across rollouts", () => {
    const sample = samples[0]!;
    const profile = rlPolicyProfile(rl, 0);
    const a = rollout(sample, profile, 11);
    const b = rollout(sample, profile, 11);
    expect(a.answer.text).toBe(b.answer.text);
    const texts = new Set(
      Array.from({ length: 40 }, (_, i) => rollout(sample, profile, i).answer.text),
    );
    expect(texts.size).toBeGreaterThan(1);
  });

  it("fails early in RL far more often than late", () => {
    const failures = (progress: number) => {
      const profile = rlPolicyProfile(rl, progress);
      let failed = 0;
      for (let i = 0; i < 60; i += 1)
        for (const sample of samples)
          if (!rollout(sample, profile, i).verification.pass) failed += 1;
      return failed;
    };
    expect(failures(0)).toBeGreaterThan(failures(1));
    // 600 verified rollouts: slow under a loaded full-suite run, not a correctness signal.
  }, 30_000);

  it("derives profiles from the stage metrics", () => {
    const early = rlPolicyProfile(rl, 0);
    const late = rlPolicyProfile(rl, 1);
    expect(early.hallucination).toBeCloseTo(0.15);
    expect(late.hallucination).toBeCloseTo(0.035);
    expect(early.wrongConnection).toBeCloseTo(0.24);
    for (const kind of POLICY_ERROR_KINDS)
      expect(late[kind]).toBeLessThanOrEqual(early[kind]);

    const teacher = teacherProfile(distillation);
    expect(teacher.missingCitation).toBeCloseTo(1 - 0.978);
    const studentEarly = studentProfile(distillation, 0);
    const studentLate = studentProfile(distillation, 1);
    for (const kind of POLICY_ERROR_KINDS) {
      expect(studentLate[kind]).toBeLessThanOrEqual(studentEarly[kind]);
      expect(studentLate[kind]).toBeGreaterThanOrEqual(teacher[kind] - 1e-9);
    }
  });

  it("advances the rollout every 30 s", () => {
    expect(rolloutIndexAt(NOW + 29_999)).toBe(rolloutIndexAt(NOW));
    expect(rolloutIndexAt(NOW + 30_000)).toBe(rolloutIndexAt(NOW) + 1);
  });
});

describe("sample provenance", () => {
  it("gives a stable split, shard, id and sources", () => {
    const sample = samples[0]!;
    const a = sampleProvenance(rl, sample, 42, drawing.source);
    expect(a).toEqual(sampleProvenance(rl, sample, 42, drawing.source));
    expect(["train", "val"]).toContain(a.split);
    expect(a.shard).toMatch(/^pid-lab-(train|val)-\d{5}-of-\d{5}$/);
    expect(a.sampleId).toMatch(/^smp-[0-9a-f]{8}$/);
    expect(a.rolloutId).toMatch(/^rollout [\d,]+$/);
    expect(sampleProvenance(rl, sample, 43).rolloutId).not.toBe(a.rolloutId);
    expect(a.sources.map((s) => s.value)).toEqual([
      sample.nodeId,
      sample.annotationId,
      drawing.source,
    ]);
    expect(sampleProvenance(distillation, sample, 42).rolloutId).toBeUndefined();
  });
});
