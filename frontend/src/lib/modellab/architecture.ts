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

/**
 * What a box's parameters do in the update. `trained`: its weights take gradient and an
 * optimizer step. `adapters`: its base weights are frozen, gradient passes through them to
 * the modules upstream, and only its LoRA adapters are updated. `frozen`: no parameter of it
 * changes. A box without `params` holds no parameters (a template, a sampler, a verifier, a
 * loss term).
 */
export type ParamRole = "trained" | "adapters" | "frozen";

export interface ArchBox {
  readonly id: string;
  readonly title: string;
  /** Monospace second line: format, shape, count or weight. */
  readonly detail: string;
  readonly symbol: Symbol;
  /** Dashed and muted: not connected, empty or disabled in the applied configuration. */
  readonly absent?: boolean;
  /** Frozen weights (teacher, reference policy). */
  readonly frozen?: boolean;
  readonly params?: ParamRole;
  /** Sources only: the id of the first-row model box this modality is encoded by. */
  readonly feeds?: string;
  /**
   * Heads only: the key of the live term this head contributes to the aggregate — an
   * objective key, a loss-curve key, or a reward name. Absent when the head is not a term
   * of the weighted total.
   */
  readonly lossKey?: string;
  /** Longer description for the tooltip, where the box line is kept short. */
  readonly note?: string;
  /** Sources only: share of the contract's target available today, 0..1 (drawn as a bar). */
  readonly share?: number;
}

export interface ArchitectureSpec {
  readonly figure: string;
  /** One to four words: the figure's visible title. */
  readonly heading: string;
  /** What the figure shows, in words. Never drawn: it is the figure's accessible description. */
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

/** A catalogue name without its parenthetical: `Qwen3-VL-30B-A3B (MoE)` → `Qwen3-VL-30B-A3B`. */
const compact = (name: string) => name.replace(/\s*\(.*\)\s*$/, "");

/**
 * Identifiers for encoders as a box prints them: short name and size. A box line is a
 * value, not a description, so it never needs truncating.
 */
const ENCODER_TAG: Record<string, string> = {
  "gt-xl": "GPS · 480M",
  "graphgps-l": "GraphGPS · 64M",
  "gat-v2": "GATv2 · 12M",
  "ptv3-uni3d": "PTv3+Uni3D · 146M",
  ptv3: "PTv3 · 46M",
  "uni3d-g": "Uni3D-g · 1.0B",
};

/** Box titles for contract rows whose name is longer than a box line. */
const SOURCE_TITLE: Record<string, string> = {
  packages: "Investigation packages",
  alignment: "Field ↔ P&ID alignment",
  telemetry: "Telemetry prompts",
  procedural: "Procedural QA",
  topology: "Topology traces",
  anomaly: "Anomaly dialogues",
  images: "Field images",
  "3d": "CAD / point clouds",
  ts: "Telemetry series",
  docs: "Manuals / work orders",
  traces: "Teacher traces",
  rollouts: "Verified rollouts",
  correspondences: "Field → P&ID pairs",
  simulation: "Simulation summaries",
  extraction: "Extraction outputs",
  dialogues: "Long-context dialogues",
};

/**
 * The short name of a live term — an objective key, a loss-curve key or a reward name — as
 * the figures label it. Figures 03 and 04 and the recipe use this one table, so a term is
 * called the same thing wherever it is drawn.
 */
const TERM_LABEL: Record<string, string> = {
  mlm: "Next-token",
  contrastive: "Contrastive",
  grounding: "Grounding",
  topology: "Topology",
  registration: "2D↔3D registration",
  language: "Dialogue",
  tool: "Tool calls",
  extraction: "Extraction",
  "kd-kl": "Logit KL",
  "kd-ce": "Trace CE",
  hidden: "Hidden MSE",
  "2D ↔ 3D registration agreement": "2D↔3D agreement",
};

export function termLabel(key: string, fallback = key): string {
  return (
    TERM_LABEL[key] ??
    fallback.replace(/ reward$| penalty$/, "").replace(/\s*\(.*\)\s*$/, "")
  );
}

function sourcesFromContract(
  stage: Stage,
  facts: CorpusFacts,
  feeds: (symbol: Symbol) => string | undefined,
): ArchBox[] {
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
    const symbol = symbolFor[row.id] ?? "document";
    return {
      id: `src-${row.id}`,
      title: SOURCE_TITLE[row.id] ?? row.name,
      detail: `${row.format} · ${fmt(count)}`,
      symbol,
      absent: count === 0,
      feeds: feeds(symbol),
      note: `${row.name} · ${fmt(count)} of ${row.targetLabel} available`,
      share: row.target > 0 ? Math.min(1, count / row.target) : 0,
    };
  });
}

/** The weight of each term of the stage's total objective, from its `sumOf` definition. */
function totalWeights(stage: Stage): ReadonlyMap<string, number> {
  const total = stage.curves[0]?.curves[0];
  return new Map((total?.sumOf ?? []).map((term) => [term.key, term.weight]));
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
  const full = config.trainable === "full";
  const trainable = full ? "full parameters" : "LoRA + projector";
  // Under LoRA the backbone's own weights stay frozen and only its adapters train; the vision
  // tower and the text embeddings are part of that backbone. The graph and point encoders and
  // the projector are trained either way (see the run profile's trainable-parameter count).
  const backboneRole: ParamRole = full ? "trained" : "adapters";
  const insideBackbone: ParamRole = full ? "trained" : "frozen";
  const checkpoint: ArchBox = {
    id: "checkpoint",
    title: "Checkpoint",
    detail: `Δ${fmt(stage.run.checkpointEvery)} · ${stage.run.checkpointSize}`,
    symbol: "checkpoint",
    note: `Written every ${fmt(stage.run.checkpointEvery)} steps, ${stage.run.checkpointSize}`,
  };
  const backward: ArchBox = {
    id: "backward",
    title: "Backward pass",
    detail: `∇θ · ${full ? "full" : "LoRA + proj."}`,
    note: `Gradient over ${trainable}`,
    symbol: "gradient",
  };
  const optimizer: ArchBox = {
    id: "optimizer",
    title: "Optimizer step",
    detail: "AdamW · cosine",
    note: `AdamW, peak learning rate ${stage.run.learningRate.toExponential(0)}, cosine schedule`,
    symbol: "optimizer",
  };
  const encoders: ArchBox[] = [
    {
      id: "enc-vision",
      title: "Vision encoder",
      detail: "RGB + P&ID",
      symbol: "encoder",
      params: insideBackbone,
    },
    {
      id: "enc-graph",
      title: "Graph encoder",
      detail: graphOn ? (ENCODER_TAG[profile.graph.id] ?? profile.graph.name) : "disabled",
      note: graphOn ? profile.graph.name : "Disabled: topology enters as text",
      symbol: "graph",
      absent: !graphOn,
      params: "trained",
    },
    {
      id: "enc-spatial",
      title: "Point encoder",
      detail: spatialOn
        ? (ENCODER_TAG[profile.spatial.id] ?? profile.spatial.name)
        : "disabled",
      note: profile.spatial.name,
      symbol: "cube",
      absent: !spatialOn,
      params: "trained",
    },
  ];

  if (stage.id === "rl") {
    // Prompts are rendered by the chat template; their evidence goes through the encoders.
    const sources: ArchBox[] = [
      {
        id: "src-tasks",
        title: "Linked investigations",
        detail: "prompt · evidence bundle",
        symbol: "document",
        feeds: "tmpl",
      },
      {
        id: "src-trouble",
        title: "Asset troubleshooting",
        detail: "prompt · telemetry window",
        symbol: "wave",
        feeds: "enc-vision",
      },
      {
        id: "src-topology",
        title: "Topology QA",
        detail: "prompt · GraphML subgraph",
        symbol: "graph",
        feeds: "enc-vision",
      },
      {
        id: "src-sim",
        title: "Simulation review",
        detail: "prompt · scenario state",
        symbol: "cube",
        feeds: "enc-vision",
      },
    ];
    const group = stage.run.rolloutsPerStep ?? 8;
    return {
      figure: "FIGURE 03 · VERIFIER-GUIDED POLICY OPTIMISATION",
      heading: "Sample · verify · update",
      description:
        "Each prompt is answered several times by the policy. The verifier stack scores every response against the register, graph and simulator; group-relative advantages and a KL penalty to the reference policy drive the update.",
      sourcesTitle: "Prompt pool",
      sources,
      modelTitle: "Policy πθ",
      modelDetail: `${backbone} · init ← stage 2`,
      model: [
        [
          {
            id: "tmpl",
            title: "Chat template",
            detail: "system · evidence · task",
            symbol: "chat",
          },
          {
            id: "enc-vision",
            title: "Evidence encoders",
            detail: "vision · graph · text",
            symbol: "encoder",
            // The RL recipe trains adapters only: vision tower and encoders stay frozen.
            params: full ? "trained" : "frozen",
          },
        ],
        [
          {
            id: "policy",
            title: "Policy backbone",
            detail: `${compact(backbone)} · ${full ? "full" : "LoRA r64"}`,
            symbol: "layers",
            params: backboneRole,
          },
        ],
        [
          {
            id: "sampler",
            title: "Group sampler",
            detail: `G = ${group} · T = 1.0`,
            note: `${group} completions sampled per prompt at temperature 1.0`,
            symbol: "sampler",
          },
        ],
      ],
      headsTitle: "Verifier stack",
      heads: (stage.rewards ?? []).map((reward) => ({
        id: `rw-${reward.name}`,
        title: reward.source,
        detail: `λ ${reward.weight > 0 ? "+" : "−"}${Math.abs(reward.weight).toFixed(2)}`,
        symbol: "verifier",
        lossKey: reward.name,
        note: `${reward.name}: ${reward.notes}`,
      })),
      aggregate: {
        id: "agg",
        title: "Group advantages",
        detail: `group-relative · G = ${group}`,
        symbol: "sigma",
      },
      chain: [
        {
          id: "kl",
          title: "KL to reference",
          detail: "k3 · β 0.001",
          note: "KL to the frozen reference policy, k3 estimator, β = 0.001",
          symbol: "gradient",
          frozen: true,
          params: "frozen",
        },
        {
          id: "grpo",
          title: "Policy update",
          detail: "GRPO · clip",
          note: "GRPO clipped surrogate objective, one optimizer step per PPO mini-batch",
          symbol: "optimizer",
        },
        checkpoint,
      ],
      trace: [
        "src-topology",
        "tmpl",
        "policy",
        "sampler",
        `rw-${stage.rewards?.[1]?.name ?? ""}`,
        "agg",
        "kl",
        "grpo",
        "checkpoint",
      ],
    };
  }

  if (stage.id === "distillation") {
    const weights = totalWeights(stage);
    const head = (
      id: string,
      title: string,
      key: string | undefined,
      note: string,
    ): ArchBox => {
      const weight = key ? weights.get(key) : undefined;
      return {
        id,
        title,
        detail: weight === undefined ? "unweighted" : `λ ${weight.toFixed(2)}`,
        symbol: "head",
        absent: weight === undefined,
        lossKey: weight === undefined ? undefined : key,
        note,
      };
    };
    return {
      figure: "FIGURE 03 · TEACHER → STUDENT TRANSFER",
      heading: "Teacher → student",
      description:
        "The frozen stage-3 teacher produces logits and selected hidden states on verified evidence. The student is trained against both, through a learned projection for the hidden states, then quantised for edge serving.",
      sourcesTitle: "Distillation contract",
      sources: sourcesFromContract(stage, facts, () => "tmpl"),
      modelTitle: "Teacher and student",
      modelDetail: "shared batch · teacher no-grad",
      model: [
        [
          {
            id: "tmpl",
            title: "Shared inputs",
            detail: "template · encoders",
            symbol: "chat",
          },
        ],
        [
          {
            id: "teacher",
            title: "Teacher πT",
            detail: "Qwen3-VL-32B · frozen",
            symbol: "teacher",
            frozen: true,
            params: "frozen",
          },
          {
            id: "student",
            title: "Student πS",
            detail: `${compact(backbone)} · ${full ? "full" : "LoRA"}`,
            symbol: "student",
            params: backboneRole,
          },
        ],
        [
          {
            id: "targets",
            title: "Transfer targets",
            detail: "logits T=2 · W·h_S",
            note: "Teacher logits at temperature 2, and hidden states through a learned projection W",
            symbol: "project",
            // The hidden-state projection W is learned with the student.
            params: "trained",
          },
        ],
      ],
      headsTitle: "Transfer losses",
      heads: [
        head(
          "l-kl",
          "Logit KL (forward)",
          "kd-kl",
          "Forward KL from teacher to student token distributions, temperature 2",
        ),
        head(
          "l-hidden",
          "Hidden-state loss",
          "hidden",
          "Mean squared error between projected student and teacher hidden states",
        ),
        head(
          "l-ground",
          "Grounding loss",
          undefined,
          "Box and tag agreement with the teacher",
        ),
        head(
          "l-trace",
          "Verified-trace CE",
          "kd-ce",
          "Cross-entropy on verifier-passed stage-3 traces",
        ),
      ],
      aggregate: {
        id: "agg",
        title: "Σ Distillation loss",
        detail: "student only",
        symbol: "sigma",
      },
      chain: [
        {
          ...backward,
          detail: "∇θS only",
          note: "Gradient to the student; the teacher is frozen",
        },
        optimizer,
        {
          id: "export",
          title: "Quantised export",
          detail: "W8A16 · TRT-LLM",
          note: "INT8 weight-only quantisation (W8A16), TensorRT-LLM engine",
          symbol: "export",
        },
        checkpoint,
      ],
      trace: [
        "src-traces",
        "tmpl",
        "teacher",
        "targets",
        "l-kl",
        "agg",
        "backward",
        "optimizer",
        "export",
        "checkpoint",
      ],
    };
  }

  const objectives = objectiveShares(stage, stage.run.openingStep);
  // Short engineering names for the boxes; the full objective name stays in the tooltip.
  const HEAD_TITLE: Record<string, string> = {
    mlm: "Next-token prediction",
    contrastive: "Contrastive alignment",
    grounding: "Tag grounding",
    topology: "Topology prediction",
    registration: "2D ↔ 3D registration",
    language: "Grounded dialogue",
    tool: "Tool calling",
    extraction: "Structured extraction",
  };
  // Pretraining's alignment heads are new modules and always train; next-token prediction
  // reads the backbone's own LM head. Supervised fine-tuning's objectives are all token losses
  // on the LM head, so they hold no parameters of their own.
  const headParams = (key: string): ParamRole | undefined =>
    stage.id === "sft" ? undefined : key === "mlm" ? insideBackbone : "trained";
  const heads: ArchBox[] = objectives.slice(0, 6).map((objective) => ({
    id: `obj-${objective.key}`,
    title: HEAD_TITLE[objective.key] ?? termLabel(objective.key, objective.label),
    detail: `λ ${objective.weight.toFixed(2)}`,
    symbol: "head",
    params: headParams(objective.key),
    lossKey: objective.key,
    note: objective.label,
  }));

  if (stage.id === "sft") {
    const feeds = (symbol: Symbol): string | undefined => {
      if (symbol === "sheet" || symbol === "camera") return "enc-vision";
      if (symbol === "graph") return graphOn ? "enc-graph" : "tmpl";
      if (symbol === "cube") return undefined;
      return "tmpl";
    };
    return {
      figure: "FIGURE 03 · GROUNDED INSTRUCTION TUNING",
      heading: "Masked-loss tuning",
      description:
        "Investigation packages are rendered through the chat template with their evidence. Only reviewed response positions carry loss; prompt and padding positions are masked out before the update.",
      sourcesTitle: "Instruction contract",
      sources: sourcesFromContract(stage, facts, feeds),
      modelTitle: "Model · stage-1 checkpoint",
      modelDetail: `${backbone} · ${trainable}`,
      model: [
        [
          {
            id: "tmpl",
            title: "Chat template",
            detail: "chat roles",
            note: "System, user and assistant turns",
            symbol: "chat",
          },
          encoders[0]!,
          encoders[1]!,
        ],
        [
          {
            id: "proj",
            title: "Projection Pₘ",
            detail: "encoders → d",
            symbol: "project",
            params: "trained",
          },
        ],
        [
          {
            id: "backbone",
            title: "Backbone fθ",
            detail: `${compact(backbone)} · ${config.precision.toUpperCase()}`,
            symbol: "layers",
            params: backboneRole,
          },
        ],
      ],
      headsTitle: "Objective heads",
      heads,
      aggregate: {
        id: "agg",
        title: "Σ Masked loss",
        detail: "response tokens only",
        symbol: "sigma",
      },
      chain: [backward, optimizer, checkpoint],
      trace: [
        "src-packages",
        "tmpl",
        "proj",
        "backbone",
        heads[0]?.id ?? "",
        "agg",
        "backward",
        "optimizer",
        "checkpoint",
      ],
    };
  }

  const structOn = graphOn || spatialOn;
  const feeds = (symbol: Symbol): string | undefined => {
    if (symbol === "sheet" || symbol === "camera") return "enc-vision";
    if (symbol === "graph") return graphOn ? "enc-struct" : "enc-seq";
    // A point cloud has no text fallback: with the point encoder off it is not consumed.
    if (symbol === "cube") return spatialOn ? "enc-struct" : undefined;
    return "enc-seq";
  };
  return {
    figure: "FIGURE 03 · MULTIMODAL ALIGNMENT FORWARD PATH",
    heading: "Multimodal alignment",
    description:
      "Each modality keeps its own encoder and source coordinates. Projections bring them to one width, the backbone fuses them, and five weighted objectives produce the loss that updates the adapters.",
    sourcesTitle: "Training contract",
    sources: sourcesFromContract(stage, facts, feeds),
    modelTitle: "Model",
    modelDetail: `${backbone} · ${trainable}`,
    model: [
      // One row: the encoders run in parallel, each on its own modality.
      [
        { ...encoders[0]!, detail: "RGB + P&ID" },
        {
          id: "enc-struct",
          title: "Graph encoder",
          detail: structOn
            ? graphOn && spatialOn
              ? "graph + points"
              : graphOn
                ? "graph"
                : "points"
            : "disabled",
          symbol: "graph",
          absent: !structOn,
          params: "trained",
        },
        {
          id: "enc-seq",
          title: "Series + text",
          detail: "series · text",
          symbol: "wave",
          params: insideBackbone,
        },
      ],
      [
        {
          id: "proj",
          title: "Projection Pₘ",
          detail: "per-modality → d",
          symbol: "project",
          params: "trained",
        },
      ],
      [
        {
          id: "backbone",
          title: "Backbone fθ",
          detail: `${compact(backbone)} · ${config.precision.toUpperCase()}`,
          symbol: "layers",
          params: backboneRole,
        },
      ],
    ],
    headsTitle: "Objective heads",
    heads,
    aggregate: {
      id: "agg",
      title: "Σ Weighted loss",
      detail: `${heads.length} weighted objectives`,
      symbol: "sigma",
    },
    chain: [backward, optimizer, checkpoint],
    trace: [
      "src-pid",
      "enc-vision",
      "proj",
      "backbone",
      heads[0]?.id ?? "",
      "agg",
      "backward",
      "optimizer",
      "checkpoint",
    ],
  };
}
