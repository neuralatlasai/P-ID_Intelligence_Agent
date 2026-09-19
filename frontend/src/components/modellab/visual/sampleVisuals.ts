/**
 * Pure helpers behind the sample strip's figures: an answer split into its claims with the
 * evidence each rests on, a GRPO prompt group's rewards, and a teacher/student next-token
 * distribution pair whose divergence is the run's logged KL term.
 */

import { clamp, gaussian, seedOf, unit } from "@/lib/modellab/noise";
import type { GroundedAnswer } from "@/lib/modellab/samples";

import { textTokens } from "./conversion";

// ── claims ───────────────────────────────────────────────────────────────────────────────

export type ClaimKind = GroundedAnswer["cites"][number];

export interface Claim {
  readonly text: string;
  readonly kind: ClaimKind;
  /** Estimated tokens, the conversion diagram's chars ÷ 4 rule. */
  readonly tokens: number;
}

/**
 * The answer's sentences, each tagged with the evidence it is grounded in. The composer writes
 * one sentence per fact (identity, connections, loop, reading, procedure), so the kind follows
 * from the sentence's own wording.
 */
export function claimsOf(answer: GroundedAnswer): readonly Claim[] {
  return answer.text
    .split(/(?<=\.)\s+(?=[A-Z])/)
    .map((raw) => raw.trim())
    .filter((text) => text.length > 0)
    .map((text) => {
      const kind: ClaimKind = /connected to|shares loop/i.test(text)
        ? "Topology"
        : /\breads\b|alarm/i.test(text)
          ? "Trend"
          : /procedure reference/i.test(text)
            ? "Procedure"
            : "P&ID";
      return { text, kind, tokens: textTokens(text) };
    });
}

// ── GRPO group ───────────────────────────────────────────────────────────────────────────

/**
 * The G completion rewards behind `groupAdvantages` (flow/stepFlow.ts) at the same step: the
 * same seed and draw, so normalising these reproduces those advantages exactly. A
 * zero-variance group scores every completion alike.
 */
export function groupRewards(
  step: number,
  scoreMean: number,
  zeroVarianceShare: number,
  group: number,
): readonly number[] {
  const seed = seedOf("rl:group-advantage");
  const at = Math.max(0, Math.floor(step));
  if (unit(seed ^ 0x2545f491, at) < zeroVarianceShare)
    return new Array(group).fill(clamp(scoreMean, 0, 1));
  return Array.from({ length: group }, (_, k) =>
    clamp(scoreMean + 0.22 * clamp(gaussian(seed, at * 16 + k), -2.5, 2.5), 0, 1),
  );
}

// ── distillation ─────────────────────────────────────────────────────────────────────────

export const KD_TEMPERATURE = 2;
export const KD_TOP_K = 8;

export interface TokenDistributions {
  readonly teacher: readonly number[];
  readonly student: readonly number[];
  /** KL(p_T ∥ p_S) of the pair as drawn. */
  readonly kl: number;
}

const softmax = (logits: readonly number[], t: number) => {
  const top = Math.max(...logits);
  const e = logits.map((z) => Math.exp((z - top) / t));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / sum);
};

export const klDivergence = (p: readonly number[], q: readonly number[]) =>
  p.reduce(
    (sum, pi, i) => (pi > 0 ? sum + pi * Math.log(pi / Math.max(1e-12, q[i]!)) : sum),
    0,
  );

/**
 * Top-k teacher and student distributions at one response position, softened at
 * `temperature`. The student is the teacher mixed toward its own seeded logits by the amount
 * that makes KL(p_T ∥ p_S) equal `targetKl` (capped where the pair cannot diverge further),
 * so the bars' disagreement is the run's KL term, not a picture of one.
 */
export function kdDistributions(
  key: string,
  position: number,
  targetKl: number,
  temperature = KD_TEMPERATURE,
  k = KD_TOP_K,
): TokenDistributions {
  const seed = seedOf(`kd:${key}`);
  const teacherLogits = Array.from(
    { length: k },
    (_, i) => 4 - 1.05 * i + 0.45 * gaussian(seed, position * 32 + i),
  ).sort((a, b) => b - a);
  // The divergent end of the mix: the teacher's ranking inverted, jittered — the student's
  // mass on the tail the teacher assigns least to, which is where forward KL is paid.
  const own = teacherLogits.map(
    (_, i) =>
      teacherLogits[k - 1 - i]! + 0.6 * gaussian(seed ^ 0x51ed27, position * 32 + i),
  );
  const teacher = softmax(teacherLogits, temperature);
  const drift = softmax(own, temperature);
  const mix = (alpha: number) => teacher.map((p, i) => (1 - alpha) * p + alpha * drift[i]!);
  const goal = Math.max(0, targetKl);
  let lo = 0;
  let hi = 1;
  if (klDivergence(teacher, mix(1)) <= goal) lo = 1;
  else
    for (let i = 0; i < 40; i += 1) {
      const mid = (lo + hi) / 2;
      if (klDivergence(teacher, mix(mid)) < goal) lo = mid;
      else hi = mid;
    }
  const student = mix(lo);
  return { teacher, student, kl: klDivergence(teacher, student) };
}
