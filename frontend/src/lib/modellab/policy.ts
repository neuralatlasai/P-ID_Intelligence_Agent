/**
 * Policy rollouts: the answers a model under training actually gives, not the perfect ones.
 *
 * `groundedAnswer` composes an answer from register facts alone, so it never errs. A policy in
 * training does: it invents tags, claims connections the graph does not have, quotes a reading
 * from hours ago, drops its citation or names the wrong line. This module takes the grounded
 * answer and corrupts it with exactly those errors, each decided deterministically from the
 * sample, the rollout and the error kind against a probability taken from the stage's own
 * metrics. The real verifier in `samples.ts` then judges the corrupted text, so what the page
 * shows as caught is what the verifier really caught.
 */

import { hashString, type PlantRegister } from "@/lib/canvas/engineering";
import { equipmentNeighbours, type CanvasDrawing } from "@/lib/canvas/model";
import { isEquipment } from "@/lib/canvas/taxonomy";
import { telemetryFor } from "@/lib/canvas/telemetry";

import { metricAt } from "./run";
import {
  groundedAnswer,
  type CheckId,
  type GroundedAnswer,
  type LabSample,
  type Verification,
} from "./samples";
import type { Stage } from "./stages";

export type PolicyErrorKind =
  "hallucination" | "wrongConnection" | "staleReading" | "missingCitation" | "wrongLine";

export const POLICY_ERROR_KINDS: readonly PolicyErrorKind[] = [
  "hallucination",
  "wrongConnection",
  "staleReading",
  "missingCitation",
  "wrongLine",
];

/** Probability, per rollout, that the policy makes each kind of error. */
export interface ErrorProfile {
  readonly hallucination: number;
  readonly wrongConnection: number;
  readonly staleReading: number;
  readonly missingCitation: number;
  readonly wrongLine: number;
  /**
   * Distinguishes two models answering the same rollout (teacher and student), so their
   * errors are drawn independently. Absent for the stage 3 policy.
   */
  readonly seed?: string;
}

export interface InjectedError {
  readonly kind: PolicyErrorKind;
  /** Human-readable account of the error, e.g. "Hallucinated tag XV-9412". */
  readonly detail: string;
  /** The offending token the answer now contains (a tag, a line, a reading), if any. */
  readonly value?: string;
}

export interface PolicyAnswer {
  readonly answer: GroundedAnswer;
  readonly injected: readonly InjectedError[];
}

/** A new rollout every 30 s of a running stage. */
export const ROLLOUT_MS = 30_000;

export function rolloutIndexAt(composedAt: number): number {
  return Math.floor(composedAt / ROLLOUT_MS);
}

const TAG = /\b[A-Z]{1,4}-\d{3,4}[A-Z]?\b/g;
const WHOLE_TAG = /^[A-Z]{1,4}-\d{3,4}[A-Z]?$/;
const STALE_OFFSETS_H = [2, 3, 4, 6, 8, 12, 18, 24];

const unit = (key: string) => hashString(key) / 4294967296;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function decide(
  sample: LabSample,
  rolloutIndex: number,
  kind: PolicyErrorKind,
  profile: ErrorProfile,
): boolean {
  const key = profile.seed
    ? `${sample.nodeId}:${rolloutIndex}:${profile.seed}:${kind}`
    : `${sample.nodeId}:${rolloutIndex}:${kind}`;
  return unit(key) < clamp01(profile[kind]);
}

function fabricateTag(
  like: string,
  register: PlantRegister,
  key: string,
  avoid: ReadonlySet<string>,
): string {
  const prefix = /^([A-Z]{1,4})-/.exec(like)?.[1] ?? "XV";
  let number = 9000 + (hashString(key) % 1000);
  for (let tries = 0; tries < 1000; tries += 1) {
    const tag = `${prefix}-${number}`;
    if (!register.nodeByTag.has(tag) && !avoid.has(tag)) return tag;
    number = number >= 9999 ? 9000 : number + 1;
  }
  return `${prefix}-9999`;
}

/**
 * The grounded answer, corrupted with the errors this rollout draws. Pure and deterministic:
 * the same (sample, rollout, profile) always yields the same answer.
 *
 * `compact` selects the distilled student's shorter answer as the starting point.
 */
export function policyAnswer(
  sample: LabSample,
  register: PlantRegister,
  drawing: CanvasDrawing,
  adjacency: ReadonlyMap<string, readonly string[]>,
  composedAt: number,
  errorProfile: ErrorProfile,
  rolloutIndex: number,
  compact = false,
): PolicyAnswer {
  const base = groundedAnswer(sample, register, composedAt, compact);
  const injected: InjectedError[] = [];
  let text = base.text;
  let cites = [...base.cites];
  const salt = `${sample.nodeId}:${rolloutIndex}:${errorProfile.seed ?? ""}`;
  const errs = (kind: PolicyErrorKind) => decide(sample, rolloutIndex, kind, errorProfile);

  // Wrong line: a real line number on this sheet, but not the one the device sits on.
  if (errs("wrongLine") && sample.line && text.includes(sample.line.number)) {
    const others = [...register.lines.values()]
      .map((line) => line.number)
      .filter((number) => number !== sample.line!.number)
      .sort();
    if (others.length) {
      const wrong = others[hashString(`${salt}:line`) % others.length]!;
      text = text.split(sample.line.number).join(wrong);
      injected.push({
        kind: "wrongLine",
        detail: `Placed on line ${wrong} (registered on ${sample.line.number})`,
        value: wrong,
      });
    }
  }

  // Stale reading: the value the tag read hours before the answer was composed.
  if (errs("staleReading")) {
    const reading = /([A-Z]{1,4}-\d{3,4}[A-Z]?) reads (-?[\d.]+) /.exec(text);
    const asset = reading
      ? register.assets.get(register.nodeByTag.get(reading[1]!) ?? "")
      : undefined;
    const live = asset ? telemetryFor(asset, register, "1H", composedAt) : undefined;
    if (reading && asset && live) {
      const tolerance = Math.max(
        live.stats.sigma * 3,
        (live.normal[1] - live.normal[0]) * 0.05,
      );
      let chosen: { hours: number; pv: number } | undefined;
      for (const hours of STALE_OFFSETS_H) {
        const past = telemetryFor(asset, register, "1H", composedAt - hours * 3_600_000);
        if (!past) continue;
        const pv = past.current.pv;
        if (
          !chosen ||
          Math.abs(pv - live.current.pv) > Math.abs(chosen.pv - live.current.pv)
        )
          chosen = { hours, pv };
        if (Math.abs(pv - live.current.pv) >= tolerance * 2) break;
      }
      if (chosen) {
        const stated = chosen.pv.toFixed(2);
        text = text.replace(reading[0], `${reading[1]} reads ${stated} `);
        injected.push({
          kind: "staleReading",
          detail: `Quoted ${reading[1]} = ${stated} ${live.unit} from ${chosen.hours} h earlier`,
          value: stated,
        });
      }
    }
  }

  // Connections: wrong (real but not joined) and hallucinated (not in the register) tags.
  const wantsWrong = errs("wrongConnection");
  const wantsFabricated = errs("hallucination");
  if (wantsWrong || wantsFabricated) {
    const clause = /It is connected to ([^.]*)\./.exec(text);
    const claimed = clause ? (clause[1]!.match(TAG) ?? []) : [];
    const list = [...claimed];
    const replaced = new Set<number>();

    if (wantsWrong) {
      const kindOf = new Map(drawing.nodes.map((node) => [node.id, node.kind]));
      const joined = new Set(
        equipmentNeighbours(
          adjacency,
          (id) => isEquipment(kindOf.get(id) ?? ""),
          sample.nodeId,
          60,
        ).map(({ id }) => id),
      );
      const candidates = [...register.assets.values()]
        .filter(
          (asset) =>
            asset.nodeId !== sample.nodeId &&
            !joined.has(asset.nodeId) &&
            WHOLE_TAG.test(asset.tag) &&
            !list.includes(asset.tag),
        )
        .map((asset) => asset.tag)
        .sort();
      if (candidates.length) {
        const count = Math.max(1, Math.ceil(list.length / 2));
        const offset = hashString(`${salt}:wrong`) % candidates.length;
        const wrong: string[] = [];
        for (let i = 0; i < count && i < candidates.length; i += 1) {
          wrong.push(candidates[(offset + i * 7) % candidates.length]!);
        }
        const unique = [...new Set(wrong)];
        unique.forEach((tag, i) => {
          const position = list.length - 1 - i;
          if (position >= 0 && claimed.length > 0) {
            list[position] = tag;
            replaced.add(position);
          } else {
            list.push(tag);
            replaced.add(list.length - 1);
          }
        });
        injected.push({
          kind: "wrongConnection",
          detail: `Claimed connection to ${unique.join(", ")}, not joined to ${sample.tag}`,
          value: unique.join(", "),
        });
      }
    }

    if (wantsFabricated) {
      const like = list[0] ?? sample.tag;
      const tag = fabricateTag(like, register, `${salt}:fabricated`, new Set(list));
      if (list.length > 0 && !replaced.has(0)) list[0] = tag;
      else list.push(tag);
      injected.push({
        kind: "hallucination",
        detail: `Hallucinated tag ${tag}`,
        value: tag,
      });
    }

    const sentence = `It is connected to ${list.join(", ")}.`;
    if (clause) {
      text = text.replace(clause[0], sentence);
    } else {
      const end = text.indexOf(". ");
      text =
        end >= 0
          ? `${text.slice(0, end + 1)} ${sentence}${text.slice(end + 1)}`
          : `${text} ${sentence}`;
      if (!cites.includes("Topology")) cites.push("Topology");
    }
  }

  // Missing citation: the procedure reference is dropped.
  if (errs("missingCitation")) {
    const procedure = /\s*Procedure reference: ([^\s]+\.pdf)\./.exec(text);
    if (procedure) {
      text = text.replace(procedure[0], "");
      cites = cites.filter((cite) => cite !== "Procedure");
      injected.push({
        kind: "missingCitation",
        detail: `Dropped procedure reference ${procedure[1]}`,
        value: procedure[1],
      });
    }
  }

  return { answer: { ...base, text, cites }, injected };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Error profiles from stage metrics
// ────────────────────────────────────────────────────────────────────────────────────────────

function metricValue(stage: Stage, label: string, progress: number): number | undefined {
  const metric = stage.metrics.find((m) => m.label.startsWith(label));
  return metric ? metricAt(metric, clamp01(progress)) : undefined;
}

function metricReference(stage: Stage, label: string): number | undefined {
  const reference = stage.metrics.find((m) => m.label.startsWith(label))?.reference;
  return typeof reference === "number" ? reference : undefined;
}

/**
 * Stage 3 policy error rates at a share of the run, read from the stage's own metrics: early
 * rollouts fail often, late ones rarely.
 */
export function rlPolicyProfile(stage: Stage, progress: number): ErrorProfile {
  const value = (label: string, fallback: number) =>
    metricValue(stage, label, progress) ?? fallback;
  const faithfulness = value("Grounded answer faithfulness", 1);
  return {
    hallucination: clamp01(value("Hallucination rate", 0)),
    wrongConnection: clamp01(1 - value("Topology constraint satisfaction", 1)),
    staleReading: clamp01(1 - value("Simulation consistency score", 1)),
    missingCitation: clamp01(value("Unsupported assertion rate", 0)),
    wrongLine: clamp01((1 - faithfulness) * 0.5),
  };
}

/** The distillation teacher: a strong, fixed model with small residual error rates. */
export function teacherProfile(stage: Stage): ErrorProfile {
  const topology = metricReference(stage, "Topology F1") ?? 0.962;
  const citation = metricReference(stage, "Citation precision") ?? 0.978;
  return {
    hallucination: 0.02,
    wrongConnection: clamp01(1 - topology),
    staleReading: 0.03,
    missingCitation: clamp01(1 - citation),
    wrongLine: 0.02,
    seed: "teacher",
  };
}

/** The distilled student at a share of the run, derived from its deltas against the teacher. */
export function studentProfile(stage: Stage, progress: number): ErrorProfile {
  const teacher = teacherProfile(stage);
  const value = (label: string) => metricValue(stage, label, progress) ?? 1;
  const retention = value("Teacher retention score");
  const grounding = value("Grounding delta vs teacher");
  const topology = value("Topology F1 delta");
  const citation = value("Citation precision delta");
  return {
    hallucination: clamp01(1 - grounding * (1 - teacher.hallucination)),
    wrongConnection: clamp01(1 - topology),
    staleReading: clamp01(1 - retention * (1 - teacher.staleReading)),
    missingCitation: clamp01(1 - citation),
    wrongLine: clamp01((1 - grounding) * 0.5),
    seed: "student",
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// What the verifier made of the injected errors
// ────────────────────────────────────────────────────────────────────────────────────────────

const CHECK_FOR: Record<PolicyErrorKind, CheckId | undefined> = {
  hallucination: "grounding",
  wrongConnection: "topology",
  staleReading: "simulator",
  missingCitation: "citation",
  wrongLine: "grounding",
};

export interface Finding {
  readonly kind: PolicyErrorKind;
  readonly detail: string;
  /** True when the verifier failed the check this error should trip. */
  readonly caught: boolean;
  /** One line for the page, e.g. "Hallucinated tag XV-9412 — caught by grounding parse". */
  readonly summary: string;
}

/**
 * Join each injected error to the verifier's result. Nothing is assumed caught: a hallucination
 * counts as caught only if the verifier listed the tag as fabricated, the others only if their
 * check actually failed. A dropped citation lowers the citation score below its pass mark
 * when the asset holds documents, and a real line that is not the component's own line fails
 * the grounding parse, so both are caught by the checks that should catch them.
 */
export function verifierFindings(
  injected: readonly InjectedError[],
  verification: Verification,
): readonly Finding[] {
  const byId = new Map(verification.checks.map((check) => [check.id, check]));
  return injected.map((error) => {
    const checkId = CHECK_FOR[error.kind];
    const check = checkId ? byId.get(checkId) : undefined;
    let caught = false;
    let how: string;
    if (error.kind === "hallucination") {
      caught = error.value !== undefined && verification.fabricated.includes(error.value);
      how = caught
        ? `caught by ${(check?.label ?? "grounding parse").toLowerCase()}`
        : "missed by grounding parse";
    } else if (check) {
      caught = !check.pass;
      how = caught
        ? `caught by ${check.label.toLowerCase()} (${check.score.toFixed(2)})`
        : `missed: ${check.label.toLowerCase()} reports "${check.detail}"`;
    } else {
      how = "missed: no verifier check compares the line to the register";
    }
    return {
      kind: error.kind,
      detail: error.detail,
      caught,
      summary: `${error.detail} — ${how}`,
    };
  });
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Provenance
// ────────────────────────────────────────────────────────────────────────────────────────────

export interface SampleProvenance {
  readonly split: "train" | "val";
  readonly shard: string;
  readonly sampleId: string;
  /** Stage 3 only, e.g. "rollout 482,113". */
  readonly rolloutId: string | undefined;
  readonly sources: readonly { readonly label: string; readonly value: string }[];
}

const SHARDS: Record<Stage["id"], number> = {
  pretraining: 1024,
  sft: 128,
  rl: 256,
  distillation: 64,
};

const pad5 = (value: number) => String(value).padStart(5, "0");

/**
 * Where a sample sits in the stage's dataset: its split, shard, stable id and sources. The
 * split is a fixed 90/10 hash of the stage and field reference, so a sample never moves
 * between train and validation.
 */
export function sampleProvenance(
  stage: Stage,
  sample: LabSample,
  rolloutIndex: number,
  sheet?: string,
): SampleProvenance {
  const key = `${stage.id}:${sample.nodeId}:${sample.annotationId}`;
  const hash = hashString(key);
  const split = hash % 10 === 0 ? "val" : "train";
  const total = split === "train" ? SHARDS[stage.id] : Math.max(1, SHARDS[stage.id] / 8);
  const shardIndex = hashString(`${key}:shard`) % total;
  const { rolloutsPerStep, rolloutsTotal } = stage.run;
  const rolloutId =
    stage.id === "rl"
      ? `rollout ${(
          (Math.max(0, rolloutIndex) * (rolloutsPerStep ?? 9) +
            (hash % (rolloutsPerStep ?? 9))) %
          (rolloutsTotal ?? 900_000)
        ).toLocaleString("en-US")}`
      : undefined;
  return {
    split,
    shard: `pid-lab-${split}-${pad5(shardIndex)}-of-${pad5(total)}`,
    sampleId: `smp-${hashString(`${key}:id`).toString(16).padStart(8, "0")}`,
    rolloutId,
    sources: [
      { label: "GraphML node", value: sample.nodeId },
      { label: "Field reference", value: sample.annotationId },
      { label: "Sheet", value: sheet ?? "current sheet" },
    ],
  };
}
