/**
 * The four stages of the industrial multimodal model's training lifecycle.
 *
 * Everything here is the *plan* of a stage: its recipe, its data contract, its runtime, the
 * metrics it is judged on and the artifacts it must emit. None of it claims a run happened.
 * What is live — how far the run has got, what the corpus can supply today, which samples
 * pass verification — is computed elsewhere and joined to this plan on the page.
 */

export type StageId = "pretraining" | "sft" | "rl" | "distillation";

export interface KeyValue {
  readonly key: string;
  readonly value: string | readonly string[];
}

/** One row of a data contract: what the stage consumes, and how much it needs. */
export interface ContractRow {
  readonly id: string;
  readonly name: string;
  readonly colour: string;
  readonly format: string;
  /** Samples the contract calls for. */
  readonly target: number;
  readonly targetLabel: string;
  readonly volume: string;
  readonly notes: string;
}

export interface RewardRow {
  readonly name: string;
  readonly colour: string;
  readonly weight: number;
  readonly source: string;
  readonly notes: string;
}

export type Direction = "up" | "down";

/** A metric that moves from its value at the start of the stage toward where it lands. */
export interface MetricSpec {
  readonly label: string;
  readonly direction: Direction;
  /** Pass criterion; undefined for metrics reported without a gate. */
  readonly target?: number;
  readonly start: number;
  readonly final: number;
  readonly digits: number;
  /** Stage 3 shows the SFT baseline; stage 4 shows the teacher. Undefined when absent. */
  readonly reference?: number | string;
  readonly format?: "percent-delta" | "absolute-delta" | "ratio";
}

export interface CurveSpec {
  readonly key: string;
  readonly label: string;
  readonly colour: string;
  /** Value at step 0 and the level it settles to. */
  readonly start: number;
  readonly end: number;
  /** Steps over which most of the change happens. */
  readonly tau: number;
  readonly noise: number;
  readonly dashed?: boolean;
}

export interface CurveTab {
  readonly id: string;
  readonly label: string;
  readonly log: boolean;
  readonly curves: readonly CurveSpec[];
}

export interface RunSpec {
  /** Total optimiser steps for the stage. */
  readonly totalSteps: number;
  /** Where a fresh visitor finds the run, so the page opens mid-stage as a live run would. */
  readonly openingStep: number;
  readonly stepsPerSecond: number;
  readonly checkpointEvery: number;
  readonly checkpointSize: string;
  /**
   * Planned passes over the contract. Steps per epoch are not stored: they follow from the
   * contract's sample count and the applied global batch (see `epochPosition`).
   */
  readonly epochs?: number;
  readonly rolloutsPerStep?: number;
  readonly rolloutsTotal?: number;
  readonly learningRate: number;
  readonly warmupSteps: number;
}

export interface ArtifactSpec {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly detail: string;
  readonly icon:
    | "cube"
    | "book"
    | "target"
    | "graph"
    | "box"
    | "code"
    | "table"
    | "db"
    | "flag"
    | "file"
    | "gear"
    | "shield"
    | "chart"
    | "rocket";
  /** Share of the run after which the artifact exists. */
  readonly readyAt: number;
  /**
   * What a download produces. Configuration and profiles are small, real files generated from
   * the run; weights are not, because a simulated run trains none.
   */
  readonly download?:
    "manifest" | "serving-config" | "profile" | "behavior-profile" | "weights";
}

export interface Stage {
  readonly id: StageId;
  readonly number: string;
  readonly title: string;
  readonly required: boolean;
  readonly tagline: string;
  readonly subtitle: string;
  readonly recipeTitle: string;
  readonly recipe: readonly KeyValue[];
  readonly contractTitle: string;
  readonly contractColumns: readonly [string, string, string, string, string];
  readonly contract: readonly ContractRow[];
  readonly rewards?: readonly RewardRow[];
  readonly runtimeTitle: string;
  readonly runtime: readonly KeyValue[];
  readonly teacherStudent?: readonly (readonly [string, string, string])[];
  readonly sampleTitle: string;
  readonly progressTitle: string;
  readonly metricsTitle: string;
  readonly metricColumns: readonly [string, string, string, string];
  readonly metrics: readonly MetricSpec[];
  readonly curves: readonly CurveTab[];
  readonly run: RunSpec;
  readonly outputsTitle: string;
  readonly outputs: readonly ArtifactSpec[];
  readonly experimentId: string;
  /** Nodes shown in the sample carousel, in order. Only those present on the sheet are used. */
  readonly sampleNodes: readonly string[];
}

const BLUE = "#2563eb";
const RED = "#dc2626";
const PURPLE = "#7c3aed";
const GREEN = "#16a34a";
const ORANGE = "#f59e0b";
const CYAN = "#06b6d4";

export const STAGES: readonly Stage[] = [
  {
    id: "pretraining",
    number: "01",
    title: "Domain-Adaptive Multimodal Pretraining",
    required: true,
    tagline: "Representation alignment across modalities",
    subtitle: "Stage 1 / required — representation alignment across industrial modalities",
    recipeTitle: "Training recipe",
    recipe: [
      { key: "Backbone VLM", value: "Qwen3-VL-32B" },
      { key: "3D encoder", value: "Point Transformer V3 + Uni3D bridge" },
      { key: "Graph encoder", value: "Graph Transformer (GT-XL)" },
      { key: "Context window", value: "128K+" },
      { key: "Precision", value: "BF16" },
      {
        key: "Trainable modules",
        value: "Multimodal projector, LoRA adapters, alignment heads",
      },
      {
        key: "Objectives",
        value: [
          "Masked multimodal modeling",
          "Contrastive alignment",
          "OCR / tag grounding",
          "Topology prediction",
          "2D ↔ 3D registration consistency",
        ],
      },
    ],
    contractTitle: "Training data contract",
    contractColumns: ["Modality", "Format", "Objects / samples", "Volume", "Notes"],
    contract: [
      {
        id: "pid",
        name: "P&ID drawings",
        colour: BLUE,
        format: "PDF / PNG",
        target: 12430,
        targetLabel: "12,430",
        volume: "18 GB",
        notes: "Rasters + vector text",
      },
      {
        id: "graph",
        name: "GraphML topology",
        colour: RED,
        format: "GraphML",
        target: 12430,
        targetLabel: "12,430 graphs",
        volume: "220 MB",
        notes: "Connectivity + attributes",
      },
      {
        id: "images",
        name: "Field images (RGB)",
        colour: PURPLE,
        format: "JPG / PNG",
        target: 1_200_000,
        targetLabel: "1.2M",
        volume: "640 GB",
        notes: "Inspections + operations",
      },
      {
        id: "3d",
        name: "3D CAD / point clouds",
        colour: GREEN,
        format: "STEP / E57",
        target: 8340,
        targetLabel: "8,340",
        volume: "1.1 TB",
        notes: "Equipment + structures",
      },
      {
        id: "ts",
        name: "Telemetry / time-series",
        colour: GREEN,
        format: "Parquet",
        target: 320,
        targetLabel: "320 tags",
        volume: "48 GB",
        notes: "1 Hz – 1 min (3 years)",
      },
      {
        id: "docs",
        name: "Manuals / work orders",
        colour: ORANGE,
        format: "PDF / TXT / JSON",
        target: 54200,
        targetLabel: "54,200",
        volume: "12 GB",
        notes: "Procedures + metadata",
      },
    ],
    runtimeTitle: "Model stack / runtime",
    runtime: [
      { key: "Vision-language model", value: "Qwen3-VL-32B" },
      { key: "3D spatial encoder", value: ["Point Transformer V3", "+ Uni3D bridge"] },
      { key: "Graph encoder", value: "Graph Transformer (GT-XL)" },
      { key: "Tokenizer / context", value: "128K+ (multimodal)" },
      { key: "Training framework", value: "PyTorch + DeepSpeed" },
      { key: "Precision", value: "BF16 (mixed)" },
      { key: "Hardware", value: "8 × H100 80GB (per node)" },
      { key: "Cluster status", value: "cluster" },
      { key: "Global batch size", value: "256" },
      { key: "Sequence length", value: "128K" },
      { key: "Throughput", value: "throughput" },
      { key: "Checkpoint cadence", value: "Every 2,000 steps" },
      { key: "Experiment ID", value: "exp-2025-09-16-001" },
    ],
    sampleTitle: "Synchronized sample (multimodal alignment)",
    progressTitle: "Training progress",
    metricsTitle: "Representation objectives (pretraining losses & metrics)",
    metricColumns: ["Metric", "Target", "Current", "Trend"],
    metrics: [
      {
        label: "Cross-modal retrieval R@1",
        direction: "up",
        target: 0.6,
        start: 0.08,
        final: 0.71,
        digits: 2,
      },
      {
        label: "Cross-modal retrieval R@5",
        direction: "up",
        target: 0.85,
        start: 0.21,
        final: 0.94,
        digits: 2,
      },
      {
        label: "Grounding pre-score mAP@[.50:.95]",
        direction: "up",
        target: 0.5,
        start: 0.05,
        final: 0.6,
        digits: 2,
      },
      {
        label: "Symbol / tag OCR F1",
        direction: "up",
        target: 0.9,
        start: 0.41,
        final: 0.95,
        digits: 2,
      },
      {
        label: "Graph edge F1 (topology)",
        direction: "up",
        target: 0.85,
        start: 0.33,
        final: 0.9,
        digits: 2,
      },
      {
        label: "2D ↔ 3D registration RMSE (m)",
        direction: "down",
        target: 0.1,
        start: 0.62,
        final: 0.07,
        digits: 2,
      },
      {
        label: "Calibration ECE",
        direction: "down",
        target: 0.05,
        start: 0.21,
        final: 0.035,
        digits: 2,
      },
    ],
    curves: [
      {
        id: "losses",
        label: "Losses",
        log: true,
        curves: [
          {
            key: "total",
            label: "Total loss",
            colour: "#1d4ed8",
            start: 12,
            end: 0.021,
            tau: 900,
            noise: 0.05,
          },
          {
            key: "mlm",
            label: "MLM loss",
            colour: PURPLE,
            start: 7,
            end: 0.012,
            tau: 800,
            noise: 0.06,
          },
          {
            key: "contrastive",
            label: "Contrastive loss",
            colour: "#a855f7",
            start: 4,
            end: 0.0085,
            tau: 1100,
            noise: 0.07,
          },
          {
            key: "grounding",
            label: "Grounding loss",
            colour: GREEN,
            start: 3,
            end: 0.0045,
            tau: 1300,
            noise: 0.08,
          },
          {
            key: "topology",
            label: "Topology loss",
            colour: ORANGE,
            start: 2.5,
            end: 0.0065,
            tau: 1000,
            noise: 0.07,
          },
        ],
      },
      {
        id: "retrieval",
        label: "Retrieval",
        log: false,
        curves: [
          {
            key: "r1",
            label: "Retrieval R@1",
            colour: "#1d4ed8",
            start: 0.08,
            end: 0.71,
            tau: 14000,
            noise: 0.012,
          },
          {
            key: "r5",
            label: "Retrieval R@5",
            colour: GREEN,
            start: 0.21,
            end: 0.94,
            tau: 11000,
            noise: 0.01,
          },
        ],
      },
      {
        id: "grounding",
        label: "Grounding",
        log: false,
        curves: [
          {
            key: "map",
            label: "Grounding mAP",
            colour: "#1d4ed8",
            start: 0.05,
            end: 0.6,
            tau: 16000,
            noise: 0.012,
          },
          {
            key: "ocr",
            label: "Tag OCR F1",
            colour: PURPLE,
            start: 0.41,
            end: 0.95,
            tau: 9000,
            noise: 0.008,
          },
        ],
      },
      {
        id: "topology",
        label: "Topology",
        log: false,
        curves: [
          {
            key: "edge",
            label: "Graph edge F1",
            colour: ORANGE,
            start: 0.33,
            end: 0.9,
            tau: 12000,
            noise: 0.01,
          },
        ],
      },
      {
        id: "registration",
        label: "Registration",
        log: true,
        curves: [
          {
            key: "rmse",
            label: "2D ↔ 3D RMSE (m)",
            colour: GREEN,
            start: 0.62,
            end: 0.07,
            tau: 15000,
            noise: 0.03,
          },
        ],
      },
    ],
    run: {
      totalSteps: 100_000,
      openingStep: 68_240,
      // Planning estimate at the default configuration: 8.9 samples/s at a batch of 256.
      stepsPerSecond: 8.89 / 256,
      checkpointEvery: 2000,
      checkpointSize: "64 GB",
      learningRate: 1e-5,
      warmupSteps: 2000,
    },
    outputsTitle: "Expected stage output (artifacts emitted)",
    outputs: [
      {
        id: "representations",
        title: "Aligned multimodal representations",
        subtitle: "Joint embedding space for P&ID, images, 3D, graph",
        detail: "Embedding heads",
        icon: "cube",
        readyAt: 0.5,
      },
      {
        id: "vocabulary",
        title: "Industrial token vocabulary extension",
        subtitle: "Domain entities, tags, symbols",
        detail: "Tokenizer extension",
        icon: "book",
        readyAt: 0.2,
      },
      {
        id: "grounding",
        title: "Initialized grounding heads",
        subtitle: "Detection, OCR and cross-modal alignment modules",
        detail: "Grounding heads",
        icon: "target",
        readyAt: 0.6,
      },
      {
        id: "priors",
        title: "Graph-aware spatial priors",
        subtitle: "Topology embeddings and geometric constraints",
        detail: "Topology priors",
        icon: "graph",
        readyAt: 0.7,
      },
      {
        id: "checkpoint",
        title: "Stage 1 checkpoint",
        subtitle: "experiment",
        detail: "Checkpoint",
        icon: "box",
        readyAt: 1,
        download: "weights",
      },
    ],
    experimentId: "exp-2025-09-16-001",
    sampleNodes: ["valve43", "valve38", "instrumentation14", "tank70", "instrumentation31"],
  },
  {
    id: "sft",
    number: "02",
    title: "Grounded Multimodal SFT",
    required: true,
    tagline: "Instruction tuning with plant context",
    subtitle: "Stage 2 / required — instruction tuning with grounded industrial context",
    recipeTitle: "SFT recipe",
    recipe: [
      { key: "Base checkpoint", value: "Stage-1 aligned multimodal foundation model" },
      { key: "Backbone VLM", value: "Qwen3-VL-32B" },
      { key: "3D bridge", value: "Point Transformer V3 + Uni3D" },
      { key: "Graph encoder", value: "Graph Transformer (GT-XL)" },
      {
        key: "Trainable modules",
        value: "projector, LoRA adapters, grounding heads, tool router",
      },
      {
        key: "Supervision",
        value: "expert traces, synthetic instruction data, verified parser outputs",
      },
      {
        key: "Objectives",
        value: [
          "grounded dialogue tuning",
          "structured extraction",
          "tool calling",
          "cross-modal reasoning",
          "spatial disambiguation",
        ],
      },
    ],
    contractTitle: "Instruction data contract",
    contractColumns: ["Data source", "Format", "Samples", "Volume", "Notes"],
    contract: [
      {
        id: "packages",
        name: "Linked investigation packages",
        colour: BLUE,
        format: "MM (img+doc)",
        target: 52418,
        targetLabel: "52,418",
        volume: "280 GB",
        notes: "Multi-evidence, root cause traces",
      },
      {
        id: "alignment",
        name: "Field-to-P&ID alignment tasks",
        colour: RED,
        format: "Image + P&ID",
        target: 38206,
        targetLabel: "38,206",
        volume: "190 GB",
        notes: "Equipment ↔ symbol pairs",
      },
      {
        id: "procedural",
        name: "Procedural QA pairs",
        colour: GREEN,
        format: "Text / MM",
        target: 120531,
        targetLabel: "120,531",
        volume: "96 GB",
        notes: "SOPs, work instructions, manuals",
      },
      {
        id: "topology",
        name: "Topology explanation traces",
        colour: PURPLE,
        format: "Graph + text",
        target: 28904,
        targetLabel: "28,904",
        volume: "48 GB",
        notes: "GraphML reasoning, paths, deps",
      },
      {
        id: "anomaly",
        name: "Anomaly review dialogues",
        colour: ORANGE,
        format: "Dialogue (MM)",
        target: 41772,
        targetLabel: "41,772",
        volume: "72 GB",
        notes: "Operator-analyst conversations",
      },
      {
        id: "telemetry",
        name: "Telemetry-conditioned prompts",
        colour: CYAN,
        format: "TS + text",
        target: 60125,
        targetLabel: "60,125",
        volume: "110 GB",
        notes: "Time-series → reasoning / action",
      },
    ],
    runtimeTitle: "Model stack / runtime",
    runtime: [
      { key: "Vision-language model", value: "Qwen3-VL-32B" },
      { key: "Generative reasoner", value: "Qwen3.5-style long-context assistant" },
      { key: "3D spatial encoder", value: "Point Transformer V3 + Uni3D bridge" },
      { key: "Graph / topology encoder", value: "Graph Transformer (GT-XL)" },
      { key: "Context length", value: "128K" },
      { key: "Precision", value: "BF16" },
      { key: "Training framework", value: "PyTorch + DeepSpeed" },
      { key: "Serving target", value: "vLLM" },
      { key: "Cluster status", value: "cluster" },
    ],
    sampleTitle: "Supervised sample (linked investigation package)",
    progressTitle: "SFT progress",
    metricsTitle: "SFT validation metrics",
    metricColumns: ["Metric", "Target", "Current", "Trend"],
    metrics: [
      {
        label: "Grounding mAP@[.50:.95]",
        direction: "up",
        target: 0.6,
        start: 0.52,
        final: 0.66,
        digits: 2,
      },
      {
        label: "Grounding Acc@0.5",
        direction: "up",
        target: 0.85,
        start: 0.74,
        final: 0.89,
        digits: 2,
      },
      {
        label: "Region-text retrieval R@1",
        direction: "up",
        target: 0.75,
        start: 0.61,
        final: 0.79,
        digits: 2,
      },
      {
        label: "Tag transcription F1",
        direction: "up",
        target: 0.9,
        start: 0.8,
        final: 0.93,
        digits: 2,
      },
      {
        label: "Topology node F1",
        direction: "up",
        target: 0.85,
        start: 0.7,
        final: 0.88,
        digits: 2,
      },
      {
        label: "Topology edge F1",
        direction: "up",
        target: 0.8,
        start: 0.66,
        final: 0.84,
        digits: 2,
      },
      {
        label: "Structured extraction exact match",
        direction: "up",
        target: 0.7,
        start: 0.48,
        final: 0.75,
        digits: 2,
      },
      {
        label: "Evidence citation precision",
        direction: "up",
        target: 0.85,
        start: 0.52,
        final: 0.88,
        digits: 2,
      },
      {
        label: "Calibration ECE (↓)",
        direction: "down",
        target: 0.05,
        start: 0.11,
        final: 0.038,
        digits: 3,
      },
      {
        label: "Unsupported assertion rate (↓)",
        direction: "down",
        target: 0.03,
        start: 0.09,
        final: 0.022,
        digits: 3,
      },
    ],
    curves: [
      {
        id: "loss",
        label: "Loss",
        log: true,
        curves: [
          {
            key: "total",
            label: "Total loss",
            colour: "#1d4ed8",
            start: 9,
            end: 0.022,
            tau: 120,
            noise: 0.05,
          },
          {
            key: "language",
            label: "Language loss",
            colour: PURPLE,
            start: 5,
            end: 0.013,
            tau: 107,
            noise: 0.06,
          },
          {
            key: "grounding",
            label: "Grounding loss",
            colour: "#ec4899",
            start: 3.5,
            end: 0.009,
            tau: 147,
            noise: 0.07,
          },
          {
            key: "tool",
            label: "Tool-use loss",
            colour: GREEN,
            start: 2.2,
            end: 0.0055,
            tau: 160,
            noise: 0.08,
          },
          {
            key: "extraction",
            label: "Extraction loss",
            colour: "#ea580c",
            start: 2.8,
            end: 0.007,
            tau: 133,
            noise: 0.07,
          },
        ],
      },
      {
        id: "grounding",
        label: "Grounding",
        log: false,
        curves: [
          {
            key: "map",
            label: "Grounding mAP",
            colour: "#1d4ed8",
            start: 0.52,
            end: 0.66,
            tau: 2000,
            noise: 0.006,
          },
        ],
      },
      {
        id: "reasoning",
        label: "Reasoning",
        log: false,
        curves: [
          {
            key: "cite",
            label: "Citation precision",
            colour: PURPLE,
            start: 0.52,
            end: 0.88,
            tau: 1733,
            noise: 0.008,
          },
        ],
      },
      {
        id: "tool-use",
        label: "Tool-use",
        log: false,
        curves: [
          {
            key: "extract",
            label: "Extraction exact match",
            colour: GREEN,
            start: 0.48,
            end: 0.75,
            tau: 1867,
            noise: 0.008,
          },
        ],
      },
      {
        id: "calibration",
        label: "Calibration",
        log: false,
        curves: [
          {
            key: "ece",
            label: "Calibration ECE",
            colour: ORANGE,
            start: 0.11,
            end: 0.038,
            tau: 2133,
            noise: 0.003,
          },
        ],
      },
    ],
    run: {
      // Three passes over the 341,956-sample contract at a global batch of 128.
      totalSteps: 8_000,
      openingStep: 1_216,
      stepsPerSecond: 6_784 / (20 * 3600 + 21 * 60),
      checkpointEvery: 500,
      checkpointSize: "66 GB",
      epochs: 3,
      learningRate: 2e-5,
      warmupSteps: 100,
    },
    outputsTitle: "Expected stage output",
    outputs: [
      {
        id: "assistant",
        title: "Grounded assistant checkpoint",
        subtitle: "SFT model with industrial context",
        detail: "Qwen3-VL-32B + adapters",
        icon: "cube",
        readyAt: 1,
        download: "weights",
      },
      {
        id: "toolcall",
        title: "Tool-call formatting policy",
        subtitle: "Function schemas & routing",
        detail: "Plant tools (PI, EAM, historian)",
        icon: "code",
        readyAt: 0.4,
        download: "manifest",
      },
      {
        id: "extraction",
        title: "Structured extraction heads",
        subtitle: "Tag, equipment, event, parameter",
        detail: "Extraction modules + vocab",
        icon: "table",
        readyAt: 0.6,
      },
      {
        id: "citation",
        title: "Citation / evidence behavior",
        subtitle: "Source linking and attribution",
        detail: "Images, P&IDs, manuals, trends",
        icon: "db",
        readyAt: 0.7,
      },
      {
        id: "ready",
        title: "Ready for RL policy initialization",
        subtitle: "SFT model + tool interface",
        detail: "Stage 3 input artifact",
        icon: "flag",
        readyAt: 1,
      },
    ],
    experimentId: "exp-2025-09-17-sft-002",
    sampleNodes: ["valve38", "valve43", "instrumentation22", "instrumentation42", "tank70"],
  },
  {
    id: "rl",
    number: "03",
    title: "Verifier-Guided RL",
    required: true,
    tagline: "Tool use, verification and process reasoning",
    subtitle:
      "Stage 3 / required — policy optimization with structured rewards and simulator feedback",
    recipeTitle: "RL recipe",
    recipe: [
      { key: "Policy init", value: "Stage-2 grounded SFT checkpoint" },
      { key: "Policy model", value: "Qwen3-VL-32B" },
      {
        key: "Verifier stack",
        value: "grounded parser + topology validator + citation checker + simulator critic",
      },
      { key: "Reward strategy", value: "GRPO / PPO-style policy optimization" },
      {
        key: "Trainable modules",
        value: "policy head, selected adapters, tool router, abstention head",
      },
      {
        key: "Rollout sources",
        value:
          "linked investigation tasks, asset troubleshooting, topology QA, simulation review",
      },
      {
        key: "Objectives",
        value:
          "reduce hallucinations, improve verifier pass rate, raise grounded decision quality",
      },
    ],
    contractTitle: "Reward model / verifier contract",
    contractColumns: ["Reward signal", "Weight", "Signal source", "Notes", ""],
    contract: [],
    rewards: [
      {
        name: "Grounding consistency reward",
        colour: BLUE,
        weight: 0.2,
        source: "Grounded parser",
        notes: "Entity, tag, spatial, attribute match",
      },
      {
        name: "Topology validity reward",
        colour: PURPLE,
        weight: 0.15,
        source: "Topology validator",
        notes: "Graph constraints, connectivity",
      },
      {
        name: "2D ↔ 3D registration agreement",
        colour: GREEN,
        weight: 0.1,
        source: "Vision-geometry matcher",
        notes: "P&ID ↔ 3D alignment (IoU)",
      },
      {
        name: "Citation faithfulness reward",
        colour: ORANGE,
        weight: 0.15,
        source: "Citation checker",
        notes: "Claims supported by retrieved docs",
      },
      {
        name: "Simulator outcome reward",
        colour: BLUE,
        weight: 0.2,
        source: "Process simulator",
        notes: "Matches expected process behavior",
      },
      {
        name: "Abstention correctness reward",
        colour: GREEN,
        weight: 0.1,
        source: "Verifier + GT labels",
        notes: "Correctly abstains on unknowns",
      },
      {
        name: "Hallucination penalty",
        colour: RED,
        weight: -0.2,
        source: "Verifier ensemble",
        notes: "Unsupported or fabricated content",
      },
    ],
    runtimeTitle: "Policy / runtime",
    runtime: [
      { key: "Policy model", value: "Qwen3-VL-32B" },
      { key: "Verifier model", value: "Multi-head verifier (7B)" },
      { key: "Reward evaluator", value: "Rule-based + LLM + simulator" },
      { key: "Context length", value: "128K (multimodal)" },
      { key: "Precision", value: "BF16 (mixed)" },
      { key: "Serving target", value: "vLLM (tensor parallel)" },
      { key: "Online rollout workers", value: "32 × A100 80GB" },
      { key: "Experience buffer", value: "1.2M trajectories" },
      { key: "Status", value: "status" },
      { key: "Checkpoint cadence", value: "Every 5,000 steps" },
      { key: "Experiment ID", value: "exp-0325-rl-001" },
    ],
    sampleTitle: "Verifier-constrained rollout sample",
    progressTitle: "RL progress",
    metricsTitle: "Policy evaluation metrics",
    metricColumns: ["Metric", "SFT baseline", "Current policy", "Trend"],
    metrics: [
      {
        label: "Verifier pass@1",
        direction: "up",
        reference: 0.62,
        start: 0.62,
        final: 0.9,
        digits: 2,
      },
      {
        label: "Policy win-rate vs SFT baseline",
        direction: "up",
        reference: "-",
        start: 0.5,
        final: 0.76,
        digits: 2,
      },
      {
        label: "Grounded answer faithfulness",
        direction: "up",
        reference: 0.68,
        start: 0.68,
        final: 0.91,
        digits: 2,
      },
      {
        label: "Unsupported assertion rate ↓",
        direction: "down",
        reference: 0.18,
        start: 0.18,
        final: 0.04,
        digits: 2,
      },
      {
        label: "Calibrated abstention AUC",
        direction: "up",
        reference: 0.71,
        start: 0.71,
        final: 0.9,
        digits: 2,
      },
      {
        label: "Topology constraint satisfaction",
        direction: "up",
        reference: 0.76,
        start: 0.76,
        final: 0.95,
        digits: 2,
      },
      {
        label: "Tool-use success@1",
        direction: "up",
        reference: 0.64,
        start: 0.64,
        final: 0.87,
        digits: 2,
      },
      {
        label: "Simulation consistency score",
        direction: "up",
        reference: 0.69,
        start: 0.69,
        final: 0.9,
        digits: 2,
      },
      {
        label: "Hallucination rate ↓",
        direction: "down",
        reference: 0.15,
        start: 0.15,
        final: 0.035,
        digits: 2,
      },
      {
        label: "Risk-coverage AUC",
        direction: "up",
        reference: 0.62,
        start: 0.62,
        final: 0.88,
        digits: 2,
      },
    ],
    curves: [
      {
        id: "reward",
        label: "Reward",
        log: true,
        curves: [
          {
            key: "reward",
            label: "Mean reward (↑)",
            colour: "#1d4ed8",
            start: 0.18,
            end: 0.71,
            tau: 9000,
            noise: 0.02,
          },
          {
            key: "pass",
            label: "Verifier pass rate (↑)",
            colour: GREEN,
            start: 0.62,
            end: 0.9,
            tau: 20000,
            noise: 0.008,
          },
          {
            key: "halluc",
            label: "Hallucination rate (↓)",
            colour: RED,
            start: 0.15,
            end: 0.035,
            tau: 22000,
            noise: 0.004,
          },
          {
            key: "kl",
            label: "KL vs init",
            colour: PURPLE,
            start: 0.0005,
            end: 0.024,
            tau: 25000,
            noise: 0.0006,
          },
        ],
      },
      {
        id: "pass",
        label: "Verifier pass rate",
        log: false,
        curves: [
          {
            key: "pass",
            label: "Verifier pass rate",
            colour: GREEN,
            start: 0.62,
            end: 0.9,
            tau: 20000,
            noise: 0.008,
          },
        ],
      },
      {
        id: "halluc",
        label: "Hallucination penalty",
        log: false,
        curves: [
          {
            key: "halluc",
            label: "Hallucination rate",
            colour: RED,
            start: 0.15,
            end: 0.035,
            tau: 22000,
            noise: 0.004,
          },
        ],
      },
      {
        id: "kl",
        label: "KL divergence",
        log: false,
        curves: [
          {
            key: "kl",
            label: "KL (policy vs init)",
            colour: PURPLE,
            start: 0.0005,
            end: 0.024,
            tau: 25000,
            noise: 0.0006,
          },
          {
            key: "klt",
            label: "KL target",
            colour: "#64748b",
            start: 0.02,
            end: 0.02,
            tau: 1,
            noise: 0,
            dashed: true,
          },
        ],
      },
    ],
    run: {
      totalSteps: 100_000,
      openingStep: 53_556,
      stepsPerSecond: 46_444 / (16 * 3600 + 28 * 60),
      checkpointEvery: 5000,
      checkpointSize: "4.2 GB",
      rolloutsPerStep: 9,
      rolloutsTotal: 900_000,
      learningRate: 5e-7,
      warmupSteps: 500,
    },
    outputsTitle: "Stage outputs & artifacts (after RL training)",
    outputs: [
      {
        id: "policy",
        title: "RL policy checkpoint",
        subtitle: "rl-policy-step-100k",
        detail: "4.2 GB • Safetensors",
        icon: "cube",
        readyAt: 1,
        download: "weights",
      },
      {
        id: "behavior",
        title: "Verifier-aligned behavior profile",
        subtitle: "behavior-profile-v1.0",
        detail: "JSON • 1.1 MB",
        icon: "file",
        readyAt: 0.5,
        download: "behavior-profile",
      },
      {
        id: "abstention",
        title: "Calibrated abstention policy",
        subtitle: "abstention-head-v1.0",
        detail: "Safetensors • 320 MB",
        icon: "shield",
        readyAt: 0.8,
        download: "weights",
      },
      {
        id: "hallucination",
        title: "Reduced hallucination rate",
        subtitle: "hallucination",
        detail: "relative reduction",
        icon: "chart",
        readyAt: 0,
      },
      {
        id: "candidate",
        title: "Deployment candidate",
        subtitle: "Full-capacity industrial assistant",
        detail: "Ready for Stage 4",
        icon: "rocket",
        readyAt: 1,
        download: "weights",
      },
    ],
    experimentId: "exp-0325-rl-001",
    sampleNodes: [
      "valve43",
      "instrumentation14",
      "valve38",
      "instrumentation25",
      "instrumentation61",
    ],
  },
  {
    id: "distillation",
    number: "04",
    title: "Teacher → Student Distillation",
    required: false,
    tagline: "Edge deployment and model compression",
    subtitle: "Stage 4 / optional — compression, transfer, and edge deployment readiness",
    recipeTitle: "Distillation recipe",
    recipe: [
      { key: "Teacher source", value: "Stage-3 verifier-aligned multimodal teacher" },
      { key: "Teacher model", value: "Qwen3-VL-32B + industrial reasoning adapters" },
      { key: "Student model", value: "Qwen3-VL-8B (or equivalent compact multimodal)" },
      {
        key: "Transfer targets",
        value: "Logits, hidden states, attention maps, grounding heads, tool policies",
      },
      {
        key: "Distillation losses",
        value:
          "KL divergence, feature regression, attention transfer, grounding loss, reward-trace imitation",
      },
      { key: "Trainable modules", value: "Full student + compact adapters" },
      {
        key: "Objectives",
        value:
          "Preserve grounded reasoning, tool use and safety under tighter latency / memory budgets",
      },
    ],
    contractTitle: "Distillation data contract",
    contractColumns: ["Data source", "Format", "Objects / samples", "Volume", "Notes"],
    contract: [
      {
        id: "traces",
        name: "Teacher reasoning traces",
        colour: BLUE,
        format: "JSONL",
        target: 520418,
        targetLabel: "520,418",
        volume: "1.8 TB",
        notes: "Step-by-step chains w/ tool calls",
      },
      {
        id: "rollouts",
        name: "Verified rollouts (Stage 3)",
        colour: RED,
        format: "Trajectories",
        target: 248903,
        targetLabel: "248,903",
        volume: "920 GB",
        notes: "High-quality, verified episodes",
      },
      {
        id: "correspondences",
        name: "Field → P&ID correspondences",
        colour: GREEN,
        format: "Image + JSON",
        target: 312665,
        targetLabel: "312,665",
        volume: "640 GB",
        notes: "Vision-grounding pairs",
      },
      {
        id: "simulation",
        name: "Simulation summaries",
        colour: PURPLE,
        format: "Text / tables",
        target: 184327,
        targetLabel: "184,327",
        volume: "420 GB",
        notes: "Process dynamics & scenarios",
      },
      {
        id: "extraction",
        name: "Structured extraction outputs",
        colour: ORANGE,
        format: "JSONL",
        target: 1_024_115,
        targetLabel: "1,024,115",
        volume: "310 GB",
        notes: "Tag, alarm, procedure extractions",
      },
      {
        id: "dialogues",
        name: "Long-context industrial dialogues",
        colour: CYAN,
        format: "Conversation",
        target: 356901,
        targetLabel: "356,901",
        volume: "710 GB",
        notes: "Multi-turn plant troubleshooting",
      },
    ],
    runtimeTitle: "Teacher vs student runtime",
    runtime: [],
    teacherStudent: [
      ["Parameters", "32B", "8B"],
      ["Context length", "128K", "32K"],
      ["Precision (train)", "BF16", "BF16"],
      ["Precision (deploy)", "FP16 / INT8", "INT8 / FP8"],
      ["VRAM footprint", "~ 64 GB", "~ 16 GB"],
      ["Throughput (tokens/s)", "12.4", "52.7"],
      ["Latency (per sample)", "4.8 s", "0.9 s"],
      ["Deployment target", "Datacenter (A100/H100)", "Edge GPU / plant server"],
    ],
    sampleTitle: "Knowledge transfer sample (multimodal distillation)",
    progressTitle: "Distillation progress",
    metricsTitle: "Compression / deployment metrics",
    metricColumns: ["Metric", "Teacher", "Student", "Δ / target"],
    metrics: [
      {
        label: "Teacher retention score ↑",
        direction: "up",
        reference: 1,
        start: 0.62,
        final: 0.93,
        digits: 3,
        format: "absolute-delta",
      },
      {
        label: "Grounding delta vs teacher ↑",
        direction: "up",
        reference: 1,
        start: 0.58,
        final: 0.92,
        digits: 3,
        format: "absolute-delta",
      },
      {
        label: "Topology F1 delta ↑",
        direction: "up",
        reference: 0.962,
        start: 0.55,
        final: 0.905,
        digits: 3,
        format: "absolute-delta",
      },
      {
        label: "Citation precision delta ↑",
        direction: "up",
        reference: 0.978,
        start: 0.57,
        final: 0.918,
        digits: 3,
        format: "absolute-delta",
      },
      {
        label: "Latency per sample (s) ↓",
        direction: "down",
        reference: 4.8,
        start: 1.4,
        final: 0.9,
        digits: 2,
        format: "percent-delta",
      },
      {
        label: "Throughput (tokens/s) ↑",
        direction: "up",
        reference: 12.4,
        start: 38,
        final: 52.7,
        digits: 1,
        format: "percent-delta",
      },
      {
        label: "Peak VRAM (GB) ↓",
        direction: "down",
        reference: 64,
        start: 18,
        final: 16,
        digits: 0,
        format: "percent-delta",
      },
      {
        label: "Edge deployability score ↑",
        direction: "up",
        reference: 0.28,
        start: 0.61,
        final: 0.93,
        digits: 2,
        format: "absolute-delta",
      },
      {
        label: "Calibration drift ↓",
        direction: "down",
        target: 0.05,
        reference: "-",
        start: 0.09,
        final: 0.018,
        digits: 3,
      },
    ],
    curves: [
      {
        id: "kl",
        label: "Teacher-Student KL",
        log: true,
        curves: [
          {
            key: "kl",
            label: "Teacher-Student KL",
            colour: "#1d4ed8",
            start: 3.5,
            end: 0.21,
            tau: 1400,
            noise: 0.03,
          },
          {
            key: "retention-loss",
            label: "Feature regression loss",
            colour: GREEN,
            start: 0.35,
            end: 0.0105,
            tau: 2600,
            noise: 0.05,
          },
          {
            key: "grounding-loss",
            label: "Grounding loss",
            colour: ORANGE,
            start: 1.2,
            end: 0.045,
            tau: 2000,
            noise: 0.05,
          },
          {
            key: "attention-loss",
            label: "Attention transfer loss",
            colour: PURPLE,
            start: 2.4,
            end: 0.075,
            tau: 1800,
            noise: 0.04,
          },
        ],
      },
      {
        id: "retention",
        label: "Retention score",
        log: false,
        curves: [
          {
            key: "retention",
            label: "Teacher retention",
            colour: GREEN,
            start: 0.62,
            end: 0.93,
            tau: 16000,
            noise: 0.006,
          },
        ],
      },
      {
        id: "grounding",
        label: "Grounding retention",
        log: false,
        curves: [
          {
            key: "grounding",
            label: "Grounding vs teacher",
            colour: ORANGE,
            start: 0.58,
            end: 0.92,
            tau: 17000,
            noise: 0.006,
          },
        ],
      },
      {
        id: "latency",
        label: "Latency target",
        log: false,
        curves: [
          {
            key: "latency",
            label: "Latency per sample (s)",
            colour: PURPLE,
            start: 1.4,
            end: 0.9,
            tau: 12000,
            noise: 0.01,
          },
          {
            key: "target",
            label: "Target < 1 s",
            colour: "#334155",
            start: 1,
            end: 1,
            tau: 1,
            noise: 0,
            dashed: true,
          },
        ],
      },
    ],
    run: {
      // Three passes over the 2.65M-sample distillation contract at a global batch of 128.
      totalSteps: 62_000,
      openingStep: 12_000,
      stepsPerSecond: 50_000 / (82 * 3600),
      checkpointEvery: 1000,
      checkpointSize: "2.4 GB",
      epochs: 3,
      learningRate: 3e-5,
      warmupSteps: 800,
    },
    outputsTitle: "Distillation artifacts / outputs",
    outputs: [
      {
        id: "student",
        title: "Distilled student checkpoint",
        subtitle: "Qwen3-VL-8B-distill",
        detail: "2.4 GB • safetensors",
        icon: "cube",
        readyAt: 1,
        download: "weights",
      },
      {
        id: "manifest",
        title: "Deployment manifest",
        subtitle: "inference-manifest.yaml",
        detail: "YAML",
        icon: "file",
        readyAt: 0.1,
        download: "manifest",
      },
      {
        id: "serving",
        title: "Edge serving config",
        subtitle: "tensorrt-llm-config.json",
        detail: "JSON",
        icon: "gear",
        readyAt: 0.1,
        download: "serving-config",
      },
      {
        id: "quant",
        title: "Quantization-ready package",
        subtitle: "student-int8-package.tar.gz",
        detail: "1.1 GB • TAR.GZ",
        icon: "box",
        readyAt: 0.9,
        download: "weights",
      },
      {
        id: "profile",
        title: "Approved plant inference profile",
        subtitle: "plant-profile-v1.0.json",
        detail: "JSON",
        icon: "shield",
        readyAt: 0.1,
        download: "profile",
      },
    ],
    experimentId: "exp-2025-09-19-kd-004",
    sampleNodes: [
      "valve43",
      "instrumentation31",
      "valve38",
      "instrumentation42",
      "instrumentation60",
    ],
  },
];

export function stageById(id: string): Stage | undefined {
  return STAGES.find((stage) => stage.id === id);
}
