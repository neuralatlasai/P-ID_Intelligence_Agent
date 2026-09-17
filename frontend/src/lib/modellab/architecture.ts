/**
 * The architecture figure of a stage: what enters, what computes, what supervises and how
 * the update leaves. A pure description built from the stage plan, the applied
 * configuration and today's corpus availability — the component only lays it out.
 *
 * Every box is either configured (solid) or not connected / disabled (dashed). Nothing here
 * claims execution: it is the specification the simulated run is measured against.
 */

import type { RunConfig, RunProfile } from "./config";
import { objectiveShares } from "./ingestion";
import { availability, type CorpusFacts } from "./samples";
import type { Stage } from "./stages";

export type Symbol =
  | "sheet"
  | "graph"
  | "camera"
  | "cube"
  | "wave"
  | "document"
  | "chat"
  | "encoder"
  | "project"
  | "layers"
  | "head"
  | "sigma"
  | "gradient"
  | "optimizer"
  | "checkpoint"
  | "verifier"
  | "sampler"
  | "teacher"
  | "student"
  | "export";

export interface ArchBox {
  readonly id: string;
  readonly title: string;
  /** Monospace second line: format, shape, count or weight. */
  readonly detail: string;
  readonly symbol: Symbol;
  /** Dashed and muted: not connected, empty or disabled in the applied configuration. */
  readonly absent?: boolean;
  /** Frozen weights (teacher, reference policy): drawn with a double left rule. */
  readonly frozen?: boolean;
}

export interface ArchitectureSpec {
  readonly figure: string;
  readonly heading: string;
  readonly description: string;
  readonly sourcesTitle: string;
  readonly sources: readonly ArchBox[];
  readonly modelTitle: string;
  readonly modelDetail: string;
  /** Rows inside the model container, top to bottom, in execution order. */
  readonly model: readonly (readonly ArchBox[])[];
  readonly headsTitle: string;
  readonly heads: readonly ArchBox[];
  /** The aggregate the heads feed, then the sequential update chain after it. */
  readonly aggregate: ArchBox;
  readonly chain: readonly ArchBox[];
  /** Box ids the reference path passes through, in order. */
  readonly trace: readonly string[];
}

const fmt = (value: number) => value.toLocaleString("en-US");
const short = (text: string, max = 30) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

function sourcesFromContract(stage: Stage, facts: CorpusFacts): ArchBox[] {
  const available = availability(stage.id, facts);
  const symbolFor: Record<string, Symbol> = {
    pid: "sheet",
    graph: "graph",
    images: "camera",
    "3d": "cube",
    ts: "wave",
    docs: "document",
    packages: "document",
    alignment: "camera",
    procedural: "chat",
    topology: "graph",
    anomaly: "chat",
    telemetry: "wave",
    traces: "chat",
    rollouts: "verifier",
    correspondences: "camera",
    simulation: "wave",
    extraction: "document",
    dialogues: "chat",
  };
  return stage.contract.map((row) => {
    const count = available.get(row.id)?.count ?? 0;
    return {
      id: `src-${row.id}`,
      title: short(row.name, 28),
      detail: `${row.format} · ${fmt(count)} / ${row.targetLabel}`,
      symbol: symbolFor[row.id] ?? "document",
      absent: count === 0,
    };
  });
}

export function architectureSpec(
  stage: Stage,
  config: RunConfig,
  profile: RunProfile,
  facts: CorpusFacts,
): ArchitectureSpec {
  const backbone = profile.backbone.name;
  const graphOn = config.graph !== "none";
  const spatialOn = config.spatial !== "none";
  const trainable =
    config.trainable === "full" ? "full parameters" : "LoRA + projector";
  const checkpoint: ArchBox = {
    id: "checkpoint",
    title: "Checkpoint",
    detail: `every ${fmt(stage.run.checkpointEvery)} steps · ${stage.run.checkpointSize}`,
    symbol: "checkpoint",
  };
  const backward: ArchBox = {
    id: "backward",
    title: "Backward pass",
    detail: `∇θ over ${trainable}`,
    symbol: "gradient",
  };
  const optimizer: ArchBox = {
    id: "optimizer",
    title: "Optimizer step",
    detail: `AdamW · lr ${stage.run.learningRate.toExponential(0)} · cosine`,
    symbol: "optimizer",
  };
  const encoders: ArchBox[] = [
    { id: "enc-vision", title: "Vision encoder", detail: "ViT patches · RGB + P&ID", symbol: "encoder" },
    {
      id: "enc-graph",
      title: "Graph encoder",
      detail: graphOn ? short(profile.graph.name, 26) : "disabled · topology as text",
      symbol: "graph",
      absent: !graphOn,
    },
    {
      id: "enc-spatial",
      title: "Point encoder",
      detail: spatialOn ? short(profile.spatial.name, 26) : "disabled",
      symbol: "cube",
      absent: !spatialOn,
    },
  ];

  if (stage.id === "rl") {
    const sources: ArchBox[] = [
      { id: "src-tasks", title: "Linked investigations", detail: "prompt · evidence bundle", symbol: "document" },
      { id: "src-trouble", title: "Asset troubleshooting", detail: "prompt · telemetry window", symbol: "wave" },
      { id: "src-topology", title: "Topology QA", detail: "prompt · GraphML subgraph", symbol: "graph" },
      { id: "src-sim", title: "Simulation review", detail: "prompt · scenario state", symbol: "cube" },
    ];
    return {
      figure: "FIGURE 03 · VERIFIER-GUIDED POLICY OPTIMISATION",
      heading: "Sample, verify, reward, update.",
      description:
        "Each prompt is answered several times by the policy. The verifier stack scores every response against the register, graph and simulator; group-relative advantages and a KL penalty to the reference policy drive the update.",
      sourcesTitle: "Prompt pool",
      sources,
      modelTitle: "Policy πθ",
      modelDetail: `${backbone} · init from stage-2 SFT`,
      model: [
        [
          { id: "tmpl", title: "Chat template", detail: "system · evidence · task", symbol: "chat" },
          { id: "enc-vision", title: "Evidence encoders", detail: "vision · graph · text", symbol: "encoder" },
        ],
        [{ id: "policy", title: "Policy backbone", detail: `${short(backbone, 22)} · ${trainable}`, symbol: "layers" }],
        [
          {
            id: "sampler",
            title: "Group sampler",
            detail: `${stage.run.rolloutsPerStep ?? 9} rollouts per step · temperature 1.0`,
            symbol: "sampler",
          },
        ],
      ],
      headsTitle: "Verifier stack",
      heads: (stage.rewards ?? []).map((reward) => ({
        id: `rw-${reward.name}`,
        title: short(reward.source, 26),
        detail: `${reward.weight > 0 ? "+" : "−"}${Math.abs(reward.weight).toFixed(2)} · ${short(reward.name.replace(/ reward$| penalty$/, ""), 20)}`,
        symbol: "verifier",
      })),
      aggregate: { id: "agg", title: "Group-relative advantage", detail: "Â = (r − mean r) / std r", symbol: "sigma" },
      chain: [
        { id: "kl", title: "KL penalty", detail: "β·KL(πθ ‖ πref) · πref frozen", symbol: "gradient", frozen: true },
        { id: "grpo", title: "Policy update", detail: "GRPO clipped objective", symbol: "optimizer" },
        checkpoint,
      ],
      trace: ["src-topology", "tmpl", "policy", "sampler", `rw-${stage.rewards?.[1]?.name ?? ""}`, "agg", "kl", "grpo", "checkpoint"],
    };
  }

  if (stage.id === "distillation") {
    return {
      figure: "FIGURE 03 · TEACHER → STUDENT TRANSFER",
      heading: "The teacher answers. The student learns to answer the same way.",
      description:
        "The frozen stage-3 teacher produces logits, hidden states and attention on verified evidence. The student is trained against all of them, then exported for edge serving.",
      sourcesTitle: "Distillation contract",
      sources: sourcesFromContract(stage, facts),
      modelTitle: "Teacher and student",
      modelDetail: "same evidence batch · teacher gradients off",
      model: [
        [
          { id: "tmpl", title: "Shared inputs", detail: "chat template · encoders", symbol: "chat" },
        ],
        [
          { id: "teacher", title: "Teacher πT", detail: "Qwen3-VL-32B · frozen", symbol: "teacher", frozen: true },
          { id: "student", title: "Student πS", detail: `${short(backbone, 18)} · trainable`, symbol: "student" },
        ],
        [
          { id: "targets", title: "Transfer targets", detail: "logits · hidden · attention", symbol: "project" },
        ],
      ],
      headsTitle: "Transfer losses",
      heads: [
        { id: "l-kl", title: "Logit KL", detail: "KL(pT ‖ pS) · τ = 2", symbol: "head" },
        { id: "l-feat", title: "Feature regression", detail: "‖W·hS − hT‖² per layer", symbol: "head" },
        { id: "l-attn", title: "Attention transfer", detail: "selected heads · MSE", symbol: "head" },
        { id: "l-ground", title: "Grounding loss", detail: "box + tag agreement", symbol: "head" },
        { id: "l-trace", title: "Reward-trace imitation", detail: "verified stage-3 rollouts", symbol: "head" },
      ],
      aggregate: { id: "agg", title: "Σ Distillation loss", detail: "weighted sum · student only", symbol: "sigma" },
      chain: [
        { ...backward, detail: "∇θS · teacher frozen" },
        optimizer,
        { id: "export", title: "Quantised export", detail: "INT8 / FP8 · TensorRT-LLM", symbol: "export" },
        checkpoint,
      ],
      trace: ["src-traces", "tmpl", "teacher", "targets", "l-kl", "agg", "backward", "optimizer", "export", "checkpoint"],
    };
  }

  const objectives = objectiveShares(stage, stage.run.openingStep);
  // Short engineering names for the boxes; the full objective name stays in the detail line.
  const HEAD_TITLE: Record<string, string> = {
    mlm: "Masked modelling",
    contrastive: "Contrastive alignment",
    grounding: "Tag grounding",
    topology: "Topology prediction",
    registration: "2D ↔ 3D registration",
    language: "Grounded dialogue",
    tool: "Tool calling",
    extraction: "Structured extraction",
  };
  const heads: ArchBox[] = objectives.slice(0, 6).map((objective) => ({
    id: `obj-${objective.key}`,
    title: HEAD_TITLE[objective.key] ?? short(objective.label, 24),
    detail: `λ = ${objective.weight.toFixed(2)} · ${objective.label.toLowerCase()}`,
    symbol: "head",
  }));

  if (stage.id === "sft") {
    return {
      figure: "FIGURE 03 · GROUNDED INSTRUCTION TUNING",
      heading: "Evidence-conditioned responses, supervised token by token.",
      description:
        "Investigation packages are rendered through the chat template with their evidence. Only reviewed response positions carry loss; prompt and padding positions are masked out before the update.",
      sourcesTitle: "Instruction contract",
      sources: sourcesFromContract(stage, facts),
      modelTitle: "Model · stage-1 checkpoint",
      modelDetail: `${backbone} · ${trainable}`,
      model: [
        [
          { id: "tmpl", title: "Chat template", detail: "system · user · assistant", symbol: "chat" },
          encoders[0]!,
          encoders[1]!,
        ],
        [{ id: "proj", title: "Projection Pₘ", detail: "encoders → hidden width d", symbol: "project" }],
        [{ id: "backbone", title: "Backbone fθ", detail: `${short(backbone, 24)} · ${config.precision.toUpperCase()}`, symbol: "layers" }],
      ],
      headsTitle: "Objective heads",
      heads,
      aggregate: { id: "agg", title: "Σ Masked loss", detail: "labels = −100 outside responses", symbol: "sigma" },
      chain: [backward, optimizer, checkpoint],
      trace: ["src-packages", "tmpl", "proj", "backbone", heads[0]?.id ?? "", "agg", "backward", "optimizer", "checkpoint"],
    };
  }

  return {
    figure: "FIGURE 03 · MULTIMODAL ALIGNMENT FORWARD PATH",
    heading: "Evidence in. Learning signals out.",
    description:
      "Each modality keeps its own encoder and source coordinates. Projections bring them to one width, the backbone fuses them, and five weighted objectives produce the loss that updates the adapters.",
    sourcesTitle: "Training contract",
    sources: sourcesFromContract(stage, facts),
    modelTitle: "Model",
    modelDetail: `${backbone} · ${trainable}`,
    model: [
      // One row: the encoders run in parallel, each on its own modality.
      [
        { ...encoders[0]!, detail: "ViT · RGB + P&ID crops" },
        {
          id: "enc-struct",
          title: "Graph encoder",
          detail:
            graphOn || spatialOn
              ? `${graphOn ? "graph" : "no graph"} · ${spatialOn ? "+ point cloud" : "no points"}`
              : "disabled · as text",
          symbol: "graph",
          absent: !graphOn && !spatialOn,
        },
        { id: "enc-seq", title: "Series + text", detail: "windows · tokens", symbol: "wave" },
      ],
      [{ id: "proj", title: "Projection Pₘ", detail: "per-modality → hidden width d · masks", symbol: "project" }],
      [{ id: "backbone", title: "Backbone fθ", detail: `${short(backbone, 24)} · ${config.precision.toUpperCase()}`, symbol: "layers" }],
    ],
    headsTitle: "Objective heads",
    heads,
    aggregate: { id: "agg", title: "Σ Weighted loss", detail: "L = Σ λᵢ Lᵢ", symbol: "sigma" },
    chain: [backward, optimizer, checkpoint],
    trace: ["src-pid", "enc-vision", "proj", "backbone", heads[0]?.id ?? "", "agg", "backward", "optimizer", "checkpoint"],
  };
}
