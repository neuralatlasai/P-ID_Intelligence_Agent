/**
 * The four stages of the industrial multimodal model's training lifecycle.
 *
 * Everything here is the *plan* of a stage: its recipe, its data contract, its runtime, the
 * metrics it is judged on and the artifacts it must emit. None of it claims a run happened.
 * What is live — how far the run has got, what the corpus can supply today, which samples
 * pass verification — is computed elsewhere and joined to this plan on the page.
 *
 * No row here carries a colour. Chart series are taken in order, so a row's series is its
 * position in its list and the component reads it from the index: the order below is the
 * visual order, and there is no second value anyone has to keep in step with it.
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
  readonly format: string;
  /** Samples the contract calls for. */
  readonly target: number;
  readonly targetLabel: string;
  readonly volume: string;
  readonly notes: string;
}

export interface RewardRow {
  readonly name: string;
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
  /**
   * Share of the run before which the metric does not move. For a quantity that changes
   * with a discrete event rather than with training — a serving measurement that improves
   * when the quantised export first exists — the change is a step at that point, not a
   * curve from the first evaluation.
   */
  readonly from?: number;
}

export interface CurveSpec {
  readonly key: string;
  readonly label: string;
  /** Value at step 0 and the level it settles to. */
  readonly start: number;
  readonly end: number;
  /** Steps over which most of the change happens. */
  readonly tau: number;
  /**
   * Relative noise. Training-time signals get per-step sampling noise plus a slow wander;
   * held-out signals, measured on a fixed set, get only the wander.
   */
  readonly noise: number;
  readonly dashed?: boolean;
  /**
   * How the signal reacts to the run's incidents (see incidents.ts). A training loss spikes
   * when the timeline has a loss spike; a held-out metric, measured after the run has
   * recovered, does not. Omitted: the signal is not a per-step training measurement.
   */
  readonly response?: "loss" | "reward" | "kl" | "entropy" | "length";
  /**
   * `epochs`: in training, the loss steps down at each epoch boundary — the memorisation
   * signature of multi-epoch fine-tuning. Measured on held-out data the same objective does
   * the opposite: it stops improving in the final epoch and turns up.
   */
  readonly shape?: "epochs";
  /**
   * Measured on a held-out split rather than the training batch: no per-step sampling noise,
   * no training incidents, the generalisation gap applied, and the held-out trajectory of an
   * `epochs` curve.
   */
  readonly evaluation?: boolean;
  /**
   * The curve is a weighted sum of other curves in the stage — a total objective. Computed,
   * not modelled, so `L = Σ λᵢ Lᵢ` holds exactly at every step, including during an incident.
   */
  readonly sumOf?: readonly { readonly key: string; readonly weight: number }[];
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
      { key: "Graph encoder", value: "Graph transformer (GPS layers, 480M)" },
      { key: "Context window", value: "256K" },
      { key: "Precision", value: "BF16" },
      {
        key: "Trainable modules",
        value: "Multimodal projector, LoRA adapters, alignment heads",
      },
      {
        key: "Objectives",
        value: [
          "Next-token prediction (interleaved image–text)",
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
        format: "PDF / PNG",
        target: 12430,
        targetLabel: "12,430",
        volume: "18 GB",
        notes: "Rasters + vector text",
      },
      {
        id: "graph",
        name: "GraphML topology",
        format: "GraphML",
        target: 12430,
        targetLabel: "12,430 graphs",
        volume: "220 MB",
        notes: "Connectivity + attributes",
      },
      {
        id: "images",
        name: "Field images (RGB)",
        format: "JPG / PNG",
        target: 1_200_000,
        targetLabel: "1.2M",
        volume: "640 GB",
        notes: "Inspections + operations",
      },
      {
        id: "3d",
        name: "3D CAD / point clouds",
        format: "STEP / E57",
        target: 8340,
        targetLabel: "8,340",
        volume: "1.1 TB",
        notes: "Equipment + structures",
      },
      {
        id: "ts",
        name: "Telemetry / time-series",
        format: "Parquet",
        target: 320,
        targetLabel: "320 tags",
        volume: "48 GB",
        notes: "1 Hz – 1 min (3 years)",
      },
      {
        id: "docs",
        name: "Manuals / work orders",
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
      { key: "Graph encoder", value: "Graph transformer (GPS layers, 480M)" },
      { key: "Tokenizer / context", value: "Qwen3-VL tokenizer · model context 256K" },
      {
        key: "Training framework",
        value: "PyTorch FSDP2 (full shard) · activation checkpointing",
      },
      { key: "Precision", value: "BF16 (mixed)" },
      { key: "Hardware", value: "8 × H100 80GB (per node)" },
      { key: "Cluster status", value: "cluster" },
      { key: "Global batch size", value: "256" },
      { key: "Sequence length", value: "4,096 (packed) · model context 256K" },
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
        label: "Grounding mAP@[.50:.95] (linear probe)",
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
        digits: 3,
      },
    ],
    curves: [
      {
        id: "losses",
        label: "Losses",
        log: true,
        curves: [
          {
            // Computed from its terms with the objective weights, so the figure's
            // L = Σ λᵢ Lᵢ holds at every step, spikes included.
            key: "total",
            label: "Total objective (Σ λᵢ Lᵢ)",
            start: 1.95,
            end: 0.87,
            tau: 1500,
            noise: 0,
            response: "loss",
            sumOf: [
              { key: "mlm", weight: 0.35 },
              { key: "contrastive", weight: 0.25 },
              { key: "grounding", weight: 0.2 },
              { key: "topology", weight: 0.15 },
              { key: "registration", weight: 0.05 },
            ],
          },
          {
            // Continued pretraining from a strong base: domain text and drawings start well
            // above the base model's general-domain loss and settle near 1.5 nats.
            key: "mlm",
            label: "Next-token loss",
            start: 2.28,
            end: 1.47,
            tau: 1500,
            noise: 0.012,
            response: "loss",
          },
          {
            // InfoNCE over the batch; chance level is ln(batch). Starts below it because the
            // projectors are warm-started.
            key: "contrastive",
            label: "Contrastive (InfoNCE)",
            start: 3.1,
            end: 0.92,
            tau: 1100,
            noise: 0.02,
            response: "loss",
          },
          {
            key: "grounding",
            label: "Grounding (L1 + GIoU)",
            start: 1.35,
            end: 0.52,
            tau: 2200,
            noise: 0.022,
            response: "loss",
          },
          {
            key: "topology",
            label: "Topology edge BCE",
            start: 0.61,
            end: 0.19,
            tau: 1800,
            noise: 0.02,
            response: "loss",
          },
          {
            key: "registration",
            label: "Registration (smooth L1)",
            start: 0.28,
            end: 0.061,
            tau: 2600,
            noise: 0.025,
            response: "loss",
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
            start: 0.08,
            end: 0.71,
            tau: 3400,
            noise: 0.012,
            evaluation: true,
          },
          {
            key: "r5",
            label: "Retrieval R@5",
            start: 0.21,
            end: 0.94,
            tau: 2600,
            noise: 0.01,
            evaluation: true,
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
            label: "Grounding mAP (probe)",
            start: 0.05,
            end: 0.6,
            tau: 3800,
            noise: 0.012,
            evaluation: true,
          },
          {
            key: "ocr",
            label: "Tag OCR F1",
            start: 0.41,
            end: 0.95,
            tau: 2200,
            noise: 0.008,
            evaluation: true,
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
            start: 0.33,
            end: 0.9,
            tau: 3000,
            noise: 0.01,
            evaluation: true,
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
            start: 0.62,
            end: 0.07,
            tau: 3600,
            noise: 0.03,
            evaluation: true,
          },
        ],
      },
    ],
    run: {
      // 24,000 steps × 256 sequences × 4,096 tokens ≈ 25B tokens: several passes over the
      // domain corpus with general-domain replay mixed in against forgetting.
      totalSteps: 24_000,
      openingStep: 16_420,
      // Superseded by the applied configuration's planning estimate (see session.ts).
      stepsPerSecond: 0.085,
      checkpointEvery: 1000,
      // LoRA adapters (0.50B) and both encoders (0.63B) train; each trainable parameter
      // carries BF16 weights, an FP32 master copy and two FP32 AdamW moments (14 bytes).
      checkpointSize: "15.7 GB",
      learningRate: 1e-4,
      warmupSteps: 500,
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
      { key: "Graph encoder", value: "Graph transformer (GPS layers, 480M)" },
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
        format: "MM (img+doc)",
        target: 52418,
        targetLabel: "52,418",
        volume: "280 GB",
        notes: "Multi-evidence, root cause traces",
      },
      {
        id: "alignment",
        name: "Field-to-P&ID alignment tasks",
        format: "Image + P&ID",
        target: 38206,
        targetLabel: "38,206",
        volume: "190 GB",
        notes: "Equipment ↔ symbol pairs",
      },
      {
        id: "procedural",
        name: "Procedural QA pairs",
        format: "Text / MM",
        target: 120531,
        targetLabel: "120,531",
        volume: "96 GB",
        notes: "SOPs, work instructions, manuals",
      },
      {
        id: "topology",
        name: "Topology explanation traces",
        format: "Graph + text",
        target: 28904,
        targetLabel: "28,904",
        volume: "48 GB",
        notes: "GraphML reasoning, paths, deps",
      },
      {
        id: "anomaly",
        name: "Anomaly review dialogues",
        format: "Dialogue (MM)",
        target: 41772,
        targetLabel: "41,772",
        volume: "72 GB",
        notes: "Operator-analyst conversations",
      },
      {
        id: "telemetry",
        name: "Telemetry-conditioned prompts",
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
      { key: "3D spatial encoder", value: "Point Transformer V3 + Uni3D bridge" },
      { key: "Graph / topology encoder", value: "Graph transformer (GPS layers, 480M)" },
      { key: "Sequence length", value: "3,072 (packed) · model context 256K" },
      { key: "Precision", value: "BF16" },
      {
        key: "Training framework",
        value: "PyTorch FSDP2 (full shard) · activation checkpointing",
      },
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
        label: "Grounding Acc@IoU≥0.5",
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
        label: "Calibration ECE",
        direction: "down",
        target: 0.05,
        start: 0.11,
        final: 0.038,
        digits: 3,
      },
      {
        label: "Unsupported claim rate",
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
        log: false,
        curves: [
          {
            key: "total",
            label: "Train loss (response tokens)",
            start: 1.24,
            end: 0.52,
            tau: 600,
            noise: 0,
            response: "loss",
            sumOf: [
              { key: "language", weight: 0.4 },
              { key: "grounding", weight: 0.25 },
              { key: "tool", weight: 0.2 },
              { key: "extraction", weight: 0.15 },
            ],
          },
          {
            // The same objective on the held-out split: it tracks training loss through two
            // epochs, then turns up in the third while training loss keeps stepping down.
            key: "eval-loss",
            label: "Eval loss (held-out)",
            start: 1.24,
            end: 0.52,
            tau: 600,
            noise: 0,
            dashed: true,
            evaluation: true,
            sumOf: [
              { key: "language", weight: 0.4 },
              { key: "grounding", weight: 0.25 },
              { key: "tool", weight: 0.2 },
              { key: "extraction", weight: 0.15 },
            ],
          },
          {
            key: "language",
            label: "Grounded dialogue",
            start: 1.28,
            end: 0.58,
            tau: 600,
            noise: 0.02,
            response: "loss",
            shape: "epochs",
          },
          {
            key: "grounding",
            label: "Spatial grounding",
            start: 1.46,
            end: 0.66,
            tau: 700,
            noise: 0.022,
            response: "loss",
            shape: "epochs",
          },
          // Tool calls are schema-constrained, so their token loss falls furthest.
          {
            key: "tool",
            label: "Tool-call formatting",
            start: 0.94,
            end: 0.21,
            tau: 450,
            noise: 0.025,
            response: "loss",
            shape: "epochs",
          },
          {
            key: "extraction",
            label: "Structured extraction",
            start: 1.12,
            end: 0.34,
            tau: 520,
            noise: 0.022,
            response: "loss",
            shape: "epochs",
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
            label: "Grounding mAP@[.50:.95]",
            start: 0.52,
            end: 0.66,
            tau: 900,
            noise: 0.008,
            evaluation: true,
          },
        ],
      },
      {
        id: "citation",
        label: "Citation",
        log: false,
        curves: [
          {
            key: "cite",
            label: "Evidence citation precision",
            start: 0.52,
            end: 0.88,
            tau: 700,
            noise: 0.008,
            evaluation: true,
          },
        ],
      },
      {
        id: "extraction",
        label: "Extraction",
        log: false,
        curves: [
          {
            key: "extract",
            label: "Structured extraction exact match",
            start: 0.48,
            end: 0.75,
            tau: 800,
            noise: 0.01,
            evaluation: true,
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
            start: 0.11,
            end: 0.038,
            tau: 900,
            noise: 0.02,
            evaluation: true,
          },
        ],
      },
    ],
    run: {
      // Three passes over the 341,956-sample contract at a global batch of 128.
      totalSteps: 8_000,
      // Opens a fifth of the way into the second epoch, so the first epoch-boundary drop
      // in training loss is already on the chart.
      openingStep: 3_140,
      stepsPerSecond: 0.114,
      checkpointEvery: 500,
      checkpointSize: "15.7 GB",
      epochs: 3,
      learningRate: 1e-4,
      warmupSteps: 80,
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
      {
        key: "Policy optimization",
        value:
          "GRPO · group size 8 · group-normalised advantages · no value model · KL to frozen reference (k3 estimator, β = 0.001)",
      },
      { key: "Training framework", value: "verl (FSDP2 actor · vLLM rollout)" },
      {
        key: "Trainable modules",
        value:
          "LoRA adapters (rank 64) on attention and MLP projections; vision tower and encoders frozen",
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
        weight: 0.2,
        source: "Grounded parser",
        notes: "Entity, tag, spatial, attribute match",
      },
      {
        name: "Topology validity reward",
        weight: 0.15,
        source: "Topology validator",
        notes: "Graph constraints, connectivity",
      },
      {
        name: "2D ↔ 3D registration agreement",
        weight: 0.1,
        source: "Vision-geometry matcher",
        notes: "P&ID ↔ 3D alignment (IoU)",
      },
      {
        name: "Citation faithfulness reward",
        weight: 0.15,
        source: "Citation checker",
        notes: "Claims supported by retrieved docs",
      },
      {
        name: "Simulator outcome reward",
        weight: 0.2,
        source: "Process simulator",
        notes: "Matches expected process behavior",
      },
      {
        name: "Abstention correctness reward",
        weight: 0.1,
        source: "Verifier + GT labels",
        notes: "Correctly abstains on unknowns",
      },
      {
        name: "Hallucination penalty",
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
      { key: "Sequence length", value: "prompt + response ≤ 9,216 · model context 256K" },
      { key: "Precision", value: "BF16 (mixed)" },
      { key: "Training framework", value: "verl (FSDP2 actor · vLLM rollout)" },
      { key: "Online rollout workers", value: "32 × A100 80GB" },
      {
        key: "Rollout batch",
        value: "64 prompts × 8 completions (on-policy; no replay buffer)",
      },
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
        label: "pass@1 (verifier-graded)",
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
        label: "Attributable claim rate (NLI-verified)",
        direction: "up",
        reference: 0.68,
        start: 0.68,
        final: 0.91,
        digits: 2,
      },
      {
        label: "Unsupported claim rate",
        direction: "down",
        reference: 0.15,
        start: 0.15,
        final: 0.035,
        digits: 3,
      },
      {
        label: "Abstention AUROC",
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
        label: "Tool-call exact match",
        direction: "up",
        reference: 0.64,
        start: 0.64,
        final: 0.87,
        digits: 2,
      },
      {
        label: "Simulator outcome agreement",
        direction: "up",
        reference: 0.69,
        start: 0.69,
        final: 0.9,
        digits: 2,
      },
      {
        label: "Tool-call schema validity",
        direction: "up",
        target: 0.97,
        reference: 0.86,
        start: 0.86,
        final: 0.98,
        digits: 2,
      },
      {
        label: "AURC (risk–coverage)",
        direction: "down",
        target: 0.15,
        reference: 0.31,
        start: 0.31,
        final: 0.12,
        digits: 2,
      },
    ],
    curves: [
      {
        id: "reward",
        label: "Reward",
        log: false,
        curves: [
          {
            // critic/score/mean: the verifier-weighted reward of the batch's completions.
            key: "reward",
            label: "Mean reward",
            start: 0.41,
            end: 0.74,
            tau: 140,
            noise: 0.03,
            response: "reward",
          },
          {
            key: "pass",
            label: "Verifier pass rate (held-out)",
            start: 0.62,
            end: 0.9,
            tau: 200,
            noise: 0.01,
            evaluation: true,
          },
          {
            key: "halluc",
            label: "Unsupported claim rate",
            start: 0.15,
            end: 0.035,
            tau: 220,
            noise: 0.02,
          },
        ],
      },
      {
        id: "kl",
        label: "KL to reference",
        log: false,
        curves: [
          // k3 estimator against the frozen SFT reference; rises from zero as the policy moves.
          {
            key: "kl",
            label: "KL to reference (k3)",
            start: 0,
            end: 0.024,
            tau: 260,
            noise: 0.05,
            response: "kl",
          },
          {
            key: "kl-alert",
            label: "Alert threshold",
            start: 0.035,
            end: 0.035,
            tau: 1,
            noise: 0,
            dashed: true,
          },
        ],
      },
      {
        id: "entropy",
        label: "Entropy",
        log: false,
        curves: [
          {
            key: "entropy",
            label: "Token entropy",
            start: 0.62,
            end: 0.33,
            tau: 380,
            noise: 0.02,
            response: "entropy",
          },
        ],
      },
      {
        id: "length",
        label: "Response length",
        log: false,
        curves: [
          // Verifiable-reward RL lengthens responses as the policy learns to show its checks.
          {
            key: "response-length",
            label: "Mean response length (tokens)",
            start: 640,
            end: 1180,
            tau: 300,
            noise: 0.03,
            response: "length",
          },
        ],
      },
    ],
    run: {
      // 1,200 GRPO steps × 64 prompts × 8 completions ≈ 614K rollouts.
      totalSteps: 1_200,
      openingStep: 612,
      // ~215 s per step: generation dominates, then two reference passes and the update.
      stepsPerSecond: 0.00465,
      checkpointEvery: 50,
      // LoRA rank 64 on every attention and MLP projection: 0.54B parameters plus AdamW state.
      checkpointSize: "7.5 GB",
      rolloutsPerStep: 8,
      rolloutsTotal: 614_400,
      learningRate: 1e-5,
      warmupSteps: 10,
    },
    outputsTitle: "Stage outputs & artifacts (after RL training)",
    outputs: [
      {
        id: "policy",
        title: "RL policy checkpoint",
        subtitle: "rl-policy-step-100k",
        detail: "LoRA adapter (rank 64) + optimizer state · 4.2 GB · safetensors",
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
        title: "Hallucination evaluation report",
        subtitle: "hallucination-eval-report.json",
        detail: "JSON · updated at each evaluation",
        icon: "chart",
        readyAt: 0,
      },
      {
        id: "candidate",
        title: "Deployment candidate",
        subtitle: "Stage 4 teacher candidate · merged BF16 export ≈ 66 GB",
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
      { key: "Student model", value: "Qwen3-VL-8B" },
      {
        key: "Transfer targets",
        value:
          "Logits (forward KL), selected hidden states, grounding heads, tool-call policy",
      },
      {
        key: "Distillation losses",
        value:
          "Forward KL on logits, hidden-state MSE via projection, grounding loss, CE on verified traces",
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
        format: "JSONL",
        target: 520418,
        targetLabel: "520,418",
        volume: "1.8 TB",
        notes: "Reasoning traces with tool calls",
      },
      {
        id: "rollouts",
        name: "Verified rollouts (Stage 3)",
        format: "Trajectories",
        target: 248903,
        targetLabel: "248,903",
        volume: "920 GB",
        notes: "Verifier-passed episodes",
      },
      {
        id: "correspondences",
        name: "Field → P&ID correspondences",
        format: "Image + JSON",
        target: 312665,
        targetLabel: "312,665",
        volume: "640 GB",
        notes: "Vision-grounding pairs",
      },
      {
        id: "simulation",
        name: "Simulation summaries",
        format: "Text / tables",
        target: 184327,
        targetLabel: "184,327",
        volume: "420 GB",
        notes: "Process dynamics & scenarios",
      },
      {
        id: "extraction",
        name: "Structured extraction outputs",
        format: "JSONL",
        target: 1_024_115,
        targetLabel: "1,024,115",
        volume: "310 GB",
        notes: "Tag, alarm, procedure extractions",
      },
      {
        id: "dialogues",
        name: "Long-context industrial dialogues",
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
      ["Parameters", "33B", "8.8B"],
      ["Context window", "256K", "256K"],
      ["Serving precision", "BF16", "INT8 weight-only (W8A16)"],
      ["Weights in memory", "66 GB", "9.4 GB"],
      ["Weights + KV cache @ 32K", "74.6 GB", "14.2 GB"],
      ["Decode throughput, batch 1 (H100)", "38 tok/s", "158 tok/s"],
      ["Time to first token p50, 4K prompt (H100)", "480 ms", "140 ms"],
      ["Time per output token p95 (H100)", "29 ms", "7.1 ms"],
      ["Deployment target", "H100 80GB (TP=1)", "L40S 48GB or L4 24GB"],
    ],
    sampleTitle: "Knowledge transfer sample (multimodal distillation)",
    progressTitle: "Distillation progress",
    metricsTitle: "Compression / deployment metrics",
    metricColumns: ["Metric", "Teacher", "Student", "Δ / target"],
    metrics: [
      {
        // Student macro-accuracy ÷ teacher macro-accuracy on the held-out task suite.
        label: "Task accuracy retained vs teacher",
        direction: "up",
        reference: 1,
        start: 0.62,
        final: 0.93,
        digits: 3,
        format: "ratio",
      },
      {
        label: "Grounding mAP retained",
        direction: "up",
        reference: 1,
        start: 0.58,
        final: 0.92,
        digits: 3,
        format: "ratio",
      },
      {
        // Student topology F1 ÷ teacher topology F1 (0.962).
        label: "Topology F1 retained",
        direction: "up",
        reference: 1,
        start: 0.572,
        final: 0.941,
        digits: 3,
        format: "ratio",
      },
      {
        // Student citation precision ÷ teacher citation precision (0.978).
        label: "Citation precision retained",
        direction: "up",
        reference: 1,
        start: 0.583,
        final: 0.939,
        digits: 3,
        format: "ratio",
      },
      // Serving measurements, all on one H100 80GB at batch 1 with a 4K-token prompt. Values
      // move from the BF16 student to the INT8 W8A16 student once quantisation-aware
      // fine-tuning lands.
      {
        label: "Time to first token p50, 4K prompt, H100 (ms)",
        // Quantisation-aware fine-tuning begins at 70 % of the run.
        from: 0.7,
        direction: "down",
        target: 200,
        reference: 480,
        start: 190,
        final: 140,
        digits: 0,
        format: "percent-delta",
      },
      {
        label: "Decode throughput, batch 1, H100 (tok/s)",
        // Quantisation-aware fine-tuning begins at 70 % of the run.
        from: 0.7,
        direction: "up",
        reference: 38,
        start: 118,
        final: 158,
        digits: 0,
        format: "percent-delta",
      },
      {
        // BF16 weights 17.6 + KV 4.8 → INT8 weights 9.4 + KV 4.8; teacher 66 + 8.6.
        label: "Serving memory, weights + KV @ 32K (GB)",
        // Quantisation-aware fine-tuning begins at 70 % of the run.
        from: 0.7,
        direction: "down",
        reference: 74.6,
        start: 22.4,
        final: 14.2,
        digits: 1,
        format: "percent-delta",
      },
      {
        label: "Time per output token p95, batch 1, H100 (ms)",
        // Quantisation-aware fine-tuning begins at 70 % of the run.
        from: 0.7,
        direction: "down",
        target: 10,
        reference: 29,
        start: 9.4,
        final: 7.1,
        digits: 1,
        format: "percent-delta",
      },
      {
        label: "ECE drift vs teacher",
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
        id: "distillation",
        label: "Distillation loss",
        log: true,
        curves: [
          {
            key: "total",
            label: "Total (0.7·KL + 0.2·CE + 0.1·hidden)",
            start: 1.9,
            end: 0.56,
            tau: 2500,
            noise: 0,
            response: "loss",
            sumOf: [
              { key: "kd-kl", weight: 0.7 },
              { key: "kd-ce", weight: 0.2 },
              { key: "hidden", weight: 0.1 },
            ],
          },
          {
            key: "kd-kl",
            label: "Forward KL (teacher ‖ student)",
            start: 1.9,
            end: 0.34,
            tau: 2500,
            noise: 0.015,
            response: "loss",
          },
          {
            key: "kd-ce",
            label: "CE on verified traces",
            start: 2.6,
            end: 1.55,
            tau: 2200,
            noise: 0.014,
            response: "loss",
          },
          {
            key: "hidden",
            label: "Hidden-state MSE (projected)",
            start: 0.42,
            end: 0.09,
            tau: 3000,
            noise: 0.02,
            response: "loss",
          },
        ],
      },
      {
        id: "agreement",
        label: "Agreement",
        log: false,
        curves: [
          {
            key: "top1",
            label: "Top-1 agreement with teacher",
            start: 0.52,
            end: 0.83,
            tau: 6000,
            noise: 0.006,
          },
        ],
      },
      {
        id: "retention",
        label: "Capability retained",
        log: false,
        curves: [
          {
            key: "retained",
            label: "Task accuracy retained",
            start: 0.62,
            end: 0.93,
            tau: 9000,
            noise: 0.006,
            evaluation: true,
          },
          {
            key: "grounding-retained",
            label: "Grounding mAP retained",
            start: 0.58,
            end: 0.92,
            tau: 9000,
            noise: 0.006,
            evaluation: true,
          },
          {
            key: "topology-retained",
            label: "Topology F1 retained",
            start: 0.57,
            end: 0.94,
            tau: 8000,
            noise: 0.006,
            evaluation: true,
          },
        ],
      },
    ],
    run: {
      totalSteps: 62_000,
      openingStep: 21_500,
      stepsPerSecond: 0.093,
      checkpointEvery: 2000,
      // Full fine-tune of the 8.9B student: BF16 weights, FP32 master and AdamW moments.
      checkpointSize: "125 GB",
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
        detail: "17.6 GB · BF16 safetensors",
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
        title: "INT8 W8A16 package",
        subtitle: "student-int8-package.tar.gz",
        detail: "INT8 W8A16 · 9.4 GB",
        icon: "box",
        readyAt: 0.9,
        download: "weights",
      },
      {
        id: "profile",
        title: "Plant inference profile (pending sign-off)",
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
