import { hashString } from "@/lib/canvas/engineering";

import { evalEvery, lastEvalStep, metricAtEval } from "./evaluation";
import { learningRateAt, meetsTarget } from "./run";
import type { LabSample } from "./samples";
import type { Stage, StageId } from "./stages";
import { frameAt, nominalStepSeconds, PHASES, type TelemetryContext } from "./telemetry";

export interface ExecutionPhase {
  readonly name: string;
  readonly operation: string;
  readonly output: string;
}

interface ExecutionRecipe {
  readonly objective: string;
  readonly phases: readonly ExecutionPhase[];
  readonly diagnostics: readonly [string, string, string];
  readonly evaluation: string;
  readonly caveat: string;
  readonly sources: readonly string[];
}

/**
 * Reference methods verified against primary documentation on 2026-09-18. These are
 * execution specifications, not claims that the browser implements a training framework.
 * Model-specific features (MLA, MoE routing, FP8) must not be attributed to every backbone.
 */
export const EXECUTION_RECIPES: Record<StageId, ExecutionRecipe> = {
  pretraining: {
    objective: "Multimodal domain adaptation",
    phases: [
      {
        name: "Shard prefetch",
        operation: "Resolve source IDs and modality availability masks.",
        output: "Versioned source manifest",
      },
      {
        name: "Batch collation",
        operation: "Bucket by sequence length; preserve image and source boundaries.",
        output: "pixel_values · input_ids · attention_mask",
      },
      {
        name: "Encoder forward",
        operation: "Encode available modalities; project features to backbone width.",
        output: "Modality embeddings + validity masks",
      },
      {
        name: "Objective reduction",
        operation:
          "Reduce masked reconstruction, alignment and graph losses over valid targets.",
        output: "Per-objective loss denominators",
      },
      {
        name: "Gradient update",
        operation:
          "Accumulate gradients; clip global norm; apply AdamW with warmup and cosine decay.",
        output: "Updated adapters / trainable parameters",
      },
      {
        name: "Validation dispatch",
        operation:
          "Queue held-out retrieval, OCR and topology evaluations at the configured cadence.",
        output: "Evaluation job → checkpoint selection",
      },
    ],
    diagnostics: ["Data-loader wait", "Sequence occupancy", "Gradient norm"],
    evaluation:
      "Track retrieval Recall@k, OCR character error rate and topology precision/recall separately. Split by drawing or plant before augmentation.",
    caveat:
      "A lower alignment loss does not establish downstream reasoning quality. Missing modalities need explicit masks; duplicate crops must not cross evaluation splits.",
    sources: ["deepspeed", "amd", "deepseek", "gemma"],
  },
  sft: {
    objective: "Supervised instruction tuning",
    phases: [
      {
        name: "Instruction sampling",
        operation:
          "Sample source-grounded instructions with generator and source provenance.",
        output: "Instruction · evidence · reviewed response",
      },
      {
        name: "Target verification",
        operation:
          "Reject unsupported entities and duplicate targets before dataset admission.",
        output: "Accepted / rejected / quarantined records",
      },
      {
        name: "Chat-template encoding",
        operation:
          "Apply the model processor; mask prompt and padding positions with −100.",
        output: "Assistant-only supervision mask",
      },
      {
        name: "Causal LM forward",
        operation: "Compute token cross-entropy only over supervised response positions.",
        output: "Response NLL · supervised token count",
      },
      {
        name: "Adapter update",
        operation:
          "Update configured trainable modules with gradient accumulation and norm clipping.",
        output: "LoRA or full-parameter checkpoint",
      },
      {
        name: "Regression evaluation",
        operation:
          "Evaluate instruction compliance, citations and free-form task completion.",
        output: "Held-out task results + failure cases",
      },
    ],
    diagnostics: ["Data-loader wait", "Supervised token share", "Gradient norm"],
    evaluation:
      "Report instruction-following, schema validity and evidence attribution by task slice. Audit synthetic targets independently of their generator.",
    caveat:
      "Low response NLL can coexist with memorization. Length bucketing is not permission to truncate image tokens or leak attention between packed examples.",
    sources: ["sft", "curator", "anthropic", "openai"],
  },
  rl: {
    objective: "Reinforcement learning with verifiable rewards",
    phases: [
      {
        name: "Prompt dispatch",
        operation: "Snapshot evidence and dispatch a prompt group to rollout workers.",
        output: "Prompt ID · policy version · evidence snapshot",
      },
      {
        name: "Policy rollout",
        operation:
          "Sample multiple completions per prompt and retain token log probabilities.",
        output: "Completion group · response masks",
      },
      {
        name: "Reward verification",
        operation:
          "Score topology, attribution and schema checks against the frozen evidence.",
        output: "Component rewards · verifier failures",
      },
      {
        name: "Group advantages",
        operation: "Center rewards within each prompt group; monitor zero-variance groups.",
        output: "Group-relative advantages",
      },
      {
        name: "Clipped policy update",
        operation:
          "Apply the configured GRPO loss; track importance ratios and policy drift.",
        output: "Clipping statistics · entropy · KL diagnostics",
      },
      {
        name: "Policy evaluation",
        operation:
          "Evaluate on independent prompts; inspect reward exploitation and regressions.",
        output: "Held-out task success + failure transcripts",
      },
    ],
    diagnostics: ["Rollout queue wait", "Zero-variance groups", "Clip fraction"],
    evaluation:
      "Report pass@1, reward dispersion, completion length and verifier disagreement. Pin loss normalization and reward scaling; GRPO, DAPO and Dr. GRPO are not interchangeable labels.",
    caveat:
      "Constant rewards produce no within-group learning signal. Higher training reward does not prove better task success; inspect reward exploitation on independent cases.",
    sources: ["grpo", "deepseek", "anthropic", "openai"],
  },
  distillation: {
    objective: "Compression and recovery distillation",
    phases: [
      {
        name: "Calibration sampling",
        operation:
          "Select representative calibration records; keep recovery and held-out sets distinct.",
        output: "Calibration manifest · source distribution",
      },
      {
        name: "Sensitivity estimation",
        operation: "Estimate activation importance across supported width and depth axes.",
        output: "Per-axis sensitivity scores",
      },
      {
        name: "Architecture selection",
        operation:
          "Compare candidate architectures under memory and measured latency constraints.",
        output: "Candidate configuration · pruning mask",
      },
      {
        name: "Teacher forward",
        operation: "Freeze the teacher and align teacher/student token distributions.",
        output: "Soft targets when logits are available",
      },
      {
        name: "Recovery update",
        operation:
          "Minimize forward KL; use explicitly configured auxiliary losses for supported layer mappings.",
        output: "Recovered student checkpoint",
      },
      {
        name: "Capability evaluation",
        operation:
          "Compare free-form generation, reasoning, context length and deployment measurements.",
        output: "Per-task deltas · TTFT · inter-token latency",
      },
    ],
    diagnostics: ["Teacher queue wait", "Target coverage", "Student gradient norm"],
    evaluation:
      "Compare teacher/student per-task deltas with matched prompts. Measure p50/p95 latency on a pinned device, precision, batch size and context length.",
    caveat:
      "This panel replays a compression workflow; pruning is not repeated per optimizer step. Text-only teacher outputs support sequence distillation, not logit KL. Parameter reduction is not a latency measurement.",
    sources: ["modelopt", "minitron", "gemma", "anthropic"],
  },
};

export const METHOD_SOURCES: Record<
  string,
  { readonly title: string; readonly url: string }
> = {
  modelopt: {
    title: "NVIDIA · Model Optimizer pruning",
    url: "https://github.com/NVIDIA/Model-Optimizer/blob/main/examples/pruning/README.md",
  },
  minitron: {
    title: "NVIDIA · Minitron recovery study",
    url: "https://arxiv.org/abs/2408.11796",
  },
  curator: {
    title: "NVIDIA · NeMo synthetic data",
    url: "https://docs.nvidia.com/nemo/curator/curate-text/synthetic",
  },
  sft: {
    title: "Hugging Face · SFTTrainer",
    url: "https://huggingface.co/docs/trl/main/en/sft_trainer",
  },
  grpo: {
    title: "Hugging Face · GRPOTrainer",
    url: "https://huggingface.co/docs/trl/main/en/grpo_trainer",
  },
  deepspeed: {
    title: "Microsoft · DeepSpeed ZeRO",
    url: "https://deepspeed.readthedocs.io/en/latest/zero3.html",
  },
  amd: {
    title: "AMD · Primus training",
    url: "https://rocm.docs.amd.com/projects/primus/en/latest/02-user-guide/megatron-lm-training.html",
  },
  deepseek: {
    title: "DeepSeek · Architecture and training",
    url: "https://github.com/deepseek-ai/DeepSeek-V3",
  },
  gemma: {
    title: "Google · Gemma 3 technical report",
    url: "https://arxiv.org/abs/2503.19786",
  },
  anthropic: {
    title: "Anthropic · Evaluation harnesses",
    url: "https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents",
  },
  openai: {
    title: "OpenAI · Evaluation validity",
    url: "https://openai.com/index/trustworthy-third-party-evaluations-foundations/",
  },
};

export type DiagnosticScenario = "nominal" | "input-stall" | "quality-regression";

/** The phase a stage's phase flow uses for its own evaluation step. */
const EVALUATION_PHASE = 5;

/**
 * Bounded O(1) replay: six phases and 24 diagnostic points, derived solely from run progress.
 * No independent wall clock: pause/resume and checkpoint rewind remain deterministic.
 * Phase timing illustrates workflow activity, not a measured accelerator trace.
 *
 * Given the run's telemetry context, the diagnostics are read from the same step frames as
 * the run console (telemetry.ts) — the input-wait trace, the gradient norm, the clip
 * fraction and the zero-variance share are the values the console plots for those steps —
 * and the evaluation phase lights only when an evaluation is actually dispatched. The
 * injected scenarios still override the traces; they never touch the evaluation gates.
 */
export function executionSnapshot(
  stage: Stage,
  step: number,
  scenario: DiagnosticScenario,
  context?: TelemetryContext,
) {
  const safeStep = Number.isFinite(step)
    ? Math.max(0, Math.min(step, stage.run.totalSteps))
    : 0;
  const rate = Math.max(0.000001, stage.run.stepsPerSecond);
  const tick = Math.floor(safeStep / rate);
  const unit = (at: number) => hashString(`${stage.id}:execution:${at}`) / 4294967296;
  const stalledTrace = (at: number) => 70 + unit(at) * 25;

  let phase = scenario === "input-stall" ? 0 : Math.floor(tick / 3) % 6;
  let trace = Array.from({ length: 24 }, (_, i) => {
    const at = Math.max(0, tick - 23 + i);
    return scenario === "input-stall" ? stalledTrace(at) : 12 + unit(at) * 22;
  });
  const dispersion =
    scenario === "quality-regression" ? 0.82 : 0.02 + unit(Math.floor(tick / 4)) * 0.07;
  let secondary =
    stage.id === "rl" ? dispersion * 100 : 73 + unit(Math.floor(tick / 5)) * 18;
  let tertiary =
    stage.id === "rl"
      ? scenario === "quality-regression"
        ? 0.38
        : 0.04 + unit(tick) * 0.08
      : 0.6 + unit(tick) * (scenario === "quality-regression" ? 5 : 0.8);

  if (context && Number.isFinite(step)) {
    const current = Math.max(1, Math.floor(safeStep));
    const frames = Array.from({ length: 24 }, (_, i) =>
      frameAt(context, Math.max(1, current - 23 + i)),
    );
    const latest = frames[frames.length - 1]!;
    const nominal = nominalStepSeconds(context);
    // What each stage waits on: the input pipeline, the rollout engine, or the teacher.
    const waitPhase =
      stage.id === "rl" ? "gen" : stage.id === "distillation" ? "teacher" : "data";
    const planned = PHASES[stage.id].find((item) => item.id === waitPhase)?.share ?? 0;
    const waitShare = (frame: (typeof frames)[number]) => {
      const seconds = frame.phases.find((item) => item.id === waitPhase)?.seconds ?? 0;
      // Input wait is idle time outright; for generation and teacher forward, only the
      // excess over their planned share is time the update spent waiting.
      const idle =
        waitPhase === "data" ? seconds : Math.max(0, seconds - planned * nominal);
      return (idle / frame.stepSeconds) * 100;
    };
    if (scenario !== "input-stall") trace = frames.map(waitShare);
    if (scenario === "nominal") {
      if (stage.id === "rl" && latest.rl) {
        secondary = latest.rl.zeroVarianceGroups * 100;
        tertiary = latest.rl.pgClipfrac;
      } else if (stage.id !== "rl") {
        tertiary = latest.gradNorm;
      }
    }
    // The evaluation phase is a cadence event, not part of every step.
    const every = Math.max(1, evalEvery(stage));
    const dispatched = current % every === 0 || (current - 1) % every === 0;
    if (scenario !== "input-stall") {
      phase = dispatched ? EVALUATION_PHASE : Math.floor(tick / 3) % EVALUATION_PHASE;
    }
  }

  const wait = trace[trace.length - 1]!;
  return {
    tick,
    phase,
    phaseProgress: scenario === "input-stall" ? 0 : ((tick % 3) + 1) / 3,
    trace,
    wait,
    secondary,
    tertiary,
    learningRate: learningRateAt(stage.run, safeStep),
    evaluationStep: lastEvalStep(stage, safeStep),
    gates: stage.metrics
      .filter((metric) => metric.target !== undefined)
      .slice(0, 4)
      .map((metric) => {
        const value = metricAtEval(metric, stage, safeStep);
        return {
          label: metric.label,
          value,
          target: metric.target!,
          digits: metric.digits,
          direction: metric.direction,
          pass: meetsTarget(metric, value) === true,
        };
      }),
  };
}

export interface SyntheticCandidate {
  readonly id: string;
  readonly sourceId: string;
  readonly nodeId: string;
  readonly prompt: string;
  readonly response: string;
  readonly generator: "source-template-v1";
  readonly decision: "review" | "duplicate" | "invalid-reference";
}

/**
 * Executed local QC, not model inference. At most eight source records yield sixteen
 * candidates. Exact dedup uses Set membership (expected O(n), bounded worst-case n=16).
 * Entity checks compare against source records; no semantic correctness is inferred.
 * Every structurally valid candidate stays in review until a source-group split manifest
 * and independent target review exist. Never silently admit synthetic data to training.
 */
export function buildSyntheticCandidates(
  samples: readonly LabSample[],
  sourceId: string,
  batch: number,
): readonly SyntheticCandidate[] {
  const seen = new Set<string>();
  const boundedSamples = samples.slice(0, 8);
  const sourceNodes = new Set(boundedSamples.map((sample) => sample.nodeId));
  return boundedSamples.flatMap((sample, index) => {
    const prompt =
      batch % 2 === 0
        ? `Identify ${sample.tag} using the source register.`
        : `Which registered asset corresponds to node ${sample.nodeId}?`;
    const response = `${sample.tag}: ${sample.name}. Source node: ${sample.nodeId}.`;
    return [0, 1].map((variant) => {
      const invalid = variant === 1 && index % 2 === 1;
      const candidateResponse = invalid
        ? `${sample.tag}: unregistered node __qc_missing__.`
        : response;
      const nodeId = invalid ? "__qc_missing__" : sample.nodeId;
      const key = JSON.stringify([sourceId, prompt, candidateResponse]);
      const decision = !sourceNodes.has(nodeId)
        ? "invalid-reference"
        : seen.has(key)
          ? "duplicate"
          : "review";
      seen.add(key);
      return {
        id: `sdg-${batch}-${index}-${variant}`,
        sourceId,
        nodeId,
        prompt,
        response: candidateResponse,
        generator: "source-template-v1",
        decision,
      };
    });
  });
}
