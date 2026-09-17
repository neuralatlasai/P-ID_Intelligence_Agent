"use client";

import { useMemo, useState, type ReactNode } from "react";

import type { CanvasDrawing } from "@/lib/canvas/model";
import { architectureSpec } from "@/lib/modellab/architecture";
import { LIFECYCLE } from "@/lib/modellab/lifecycle";
import type { CorpusFacts, GroundedAnswer, LabSample } from "@/lib/modellab/samples";
import type { Stage } from "@/lib/modellab/stages";

import { ArchitectureFigure } from "./ArchitectureFigure";
import type { LiveCardProps } from "./live";
import { TrainingDynamics } from "./TrainingDynamics";
import css from "./LifecycleWorkbench.module.css";

const SECTIONS = [
  ["sources", "Source contract", "Evidence & provenance"],
  ["conversion", "Input conversion", "Record → model batch"],
  ["computation", "Model computation", "Forward → loss → update"],
  ["execution", "Execution architecture", "Workers & memory"],
  ["evaluation", "Evaluation", "Metrics & release gates"],
  ["artifacts", "Output artifacts", "Checkpoint → next stage"],
] as const;

export function LifecycleOverview({ stage }: { readonly stage: Stage }) {
  const spec = LIFECYCLE[stage.id];
  return (
    <section className={css.overview} aria-label="Stage execution overview">
      <div className={css.overviewHeading}>
        <div>
          <span className={css.eyebrow}>MODEL LIFECYCLE / STAGE {stage.number}</span>
          <h2>{spec.purpose}</h2>
        </div>
        <span className={css.badge}>Architecture specification</span>
      </div>
      <dl className={css.summary}>
        <div>
          <dt>CONSUMES</dt>
          <dd>{spec.input}</dd>
        </div>
        <div>
          <dt>SUPERVISION</dt>
          <dd>{spec.supervision}</dd>
        </div>
        <div>
          <dt>PRODUCES</dt>
          <dd>{spec.output}</dd>
        </div>
      </dl>
      <nav aria-label="Stage analysis sections">
        <ol className={css.sequence}>
          {SECTIONS.map(([id, label, detail], index) => (
            <li key={id}>
              <a href={`#lifecycle-${id}`}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{label}</strong>
                <small>{detail}</small>
              </a>
            </li>
          ))}
        </ol>
      </nav>
    </section>
  );
}

export function LifecycleSection({
  index,
  description,
  children,
}: {
  readonly index: number;
  readonly description: string;
  readonly children: ReactNode;
}) {
  const section = SECTIONS[index];
  if (!section) return undefined;
  return (
    <section
      id={`lifecycle-${section[0]}`}
      className={css.section}
      aria-labelledby={`heading-${section[0]}`}
    >
      <header className={css.sectionHeading}>
        <span className={css.sectionNumber}>{String(index + 1).padStart(2, "0")}</span>
        <div>
          <h2 id={`heading-${section[0]}`}>{section[1]}</h2>
          <p>{description}</p>
        </div>
        <span className={css.sectionRule} aria-hidden="true" />
      </header>
      {children}
    </section>
  );
}

interface MappingRow {
  readonly field: string;
  readonly source: string;
  readonly transform: string;
  readonly tensor: string;
  readonly state: string;
}

/** All record fields come from the selected sample; all tensors are explicitly proposed. */
export function InputConversion({
  stage,
  config,
  profile,
  sample,
  drawing,
  answer,
}: Pick<LiveCardProps, "stage" | "config" | "profile"> & {
  readonly sample: LabSample | undefined;
  readonly drawing: CanvasDrawing;
  readonly answer: GroundedAnswer | undefined;
}) {
  const [view, setView] = useState<"record" | "batch">("record");
  if (!sample)
    return (
      <div className={css.panel}>
        <p>
          No registered sample is available. Load a drawing with linked field references to
          inspect its input mapping.
        </p>
      </div>
    );

  const graphEnabled = config.graph !== "none";
  const spatialEnabled = config.spatial !== "none";
  const rows: readonly MappingRow[] = [
    {
      field: "01 / vision",
      source: `${sample.image} · ${sample.annotationId}`,
      transform:
        "Decode RGB → crop using the source box → model-specific resize / normalize / patchify",
      tensor: "pixel_values; image_grid metadata",
      state: "Image reference available; processor not run",
    },
    {
      field: "02 / drawing",
      source: `${drawing.imagePath} · node ${sample.nodeId}`,
      transform: "Center-based sheet box → crop → retain sheet-to-crop coordinate mapping",
      tensor: "pixel_values; source_bbox",
      state:
        sample.node.positioned === false
          ? "Unpositioned node; crop unavailable"
          : "Sheet geometry available",
    },
    {
      field: "03 / topology",
      source: `${sample.joinedCount} equipment neighbors; ${sample.neighbours.length} shown`,
      transform: graphEnabled
        ? "Extract bounded subgraph → remap local node indices → encode nodes and actual edges"
        : "Serialize verified topology as text; no graph encoder",
      tensor: graphEnabled
        ? "node_features [N, F]; edge_index [2, E]"
        : "topology text → input_ids",
      state: "Displayed neighbors are reachability results, not direct edges",
    },
    {
      field: "04 / spatial",
      source: "Procedural twin preview",
      transform: spatialEnabled
        ? "Measured CAD / point-cloud ingestion required → units and frame alignment → encoder"
        : "Omit spatial encoder and corresponding loss terms",
      tensor: spatialEnabled
        ? "points [B, Np, 3]; validity mask"
        : "Excluded by applied configuration",
      state: spatialEnabled ? "No measured point-cloud tensor attached" : "Disabled",
    },
    {
      field: "05 / text",
      source: `${sample.tag} · register identity + evidence-linked instruction`,
      transform:
        "Apply the selected processor's chat template → tokenize → preserve role and source boundaries",
      tensor: "input_ids [B, L]; attention_mask [B, L]",
      state: "Token IDs and token count are not measured",
    },
    {
      field: "06 / telemetry",
      source: `${sample.evidence.timeSeries} linked telemetry references`,
      transform:
        "Align timestamps and engineering units → select a bounded window → encode values with missing-data masks",
      tensor: "values [B, W, C]; observed_mask [B, W, C]",
      state: "Dashboard readings are simulated; no historian tensor attached",
    },
    {
      field: "07 / documents",
      source: `${sample.evidence.manuals} non-P&ID document references`,
      transform:
        "Retrieve versioned passages → preserve document and page IDs → tokenize cited spans",
      tensor: "passage input_ids; source_id per span",
      state: "Document references do not establish extracted passage availability",
    },
    {
      field: "08 / target",
      source: LIFECYCLE[stage.id].supervision,
      transform:
        stage.id === "rl"
          ? "Freeze evidence → score generated responses → normalize per-prompt rewards"
          : stage.id === "distillation"
            ? "Verify teacher response → align target tokens; soft targets require teacher logits"
            : stage.id === "sft"
              ? "Mask prompt / padding with −100 → supervise reviewed response positions"
              : "Construct paired, masked and graph targets only for available modalities",
      tensor:
        stage.id === "rl"
          ? "rewards [B, G]; response mask"
          : "labels / objective-specific target masks",
      state: "Illustrative target; no training batch materialized",
    },
  ];
  // buildSamples bounds the neighbor preview at five; serialization remains O(k) in the
  // selected record, independent of corpus size. No all-pairs graph or tokenizer work here.
  const record = {
    stage: stage.id,
    drawing: drawing.source,
    node_id: sample.nodeId,
    asset_tag: sample.tag,
    annotation_id: sample.annotationId,
    evidence_reference_counts: sample.evidence,
    field_image: { path: sample.image, bbox_percent_xywh: sample.box },
    pid: {
      path: drawing.imagePath,
      sheet_size_px: [drawing.width, drawing.height],
      bbox_center_xywh_px: [
        sample.node.x,
        sample.node.y,
        sample.node.width,
        sample.node.height,
      ],
      positioned: sample.node.positioned !== false,
    },
    reachable_neighbors_preview: sample.neighbours.map(({ id, tag, hops }) => ({
      id,
      tag,
      hops,
    })),
    instruction: answer?.question ?? "No instruction available",
    illustrative_target: answer?.text ?? "No target available",
    target_origin:
      "Deterministic register-based example; not a human-reviewed label or model inference",
  };
  const batch = {
    status: "Specification only; processor and training worker are not connected",
    backbone: profile.backbone.name,
    global_batch: config.globalBatch,
    local_micro_batch: "Unspecified; B below denotes a local batch, not the global batch",
    context_limit_tokens: profile.backbone.contextK * 1024,
    input_ids: "int64[B, L] — model tokenizer required",
    attention_mask: "bool[B, L] — valid token positions",
    pixel_values: "model-specific floating-point layout — image processor required",
    graph: graphEnabled
      ? `${profile.graph.name}; node_features[N, F], edge_index[2, E]`
      : "Topology serialized as text",
    spatial: spatialEnabled
      ? `${profile.spatial.name}; unavailable until measured geometry is attached`
      : "Disabled",
    supervision: LIFECYCLE[stage.id].supervision,
    precision_policy:
      config.precision === "fp8"
        ? "FP8 eligible operations with higher-precision state; backend validation required"
        : "BF16 mixed precision; integer token IDs preserved",
  };
  return (
    <div className={css.panel}>
      <header className={css.panelHeading}>
        <div>
          <span className={css.eyebrow}>SELECTED RECORD / {sample.tag}</span>
          <h3>From source evidence to model inputs</h3>
        </div>
        <span className={css.badge}>Symbolic tensor contract</span>
      </header>
      <p className={css.note}>
        The source columns follow the selected example. Conversion describes the proposed
        training interface; no tokenizer, encoder or tensor conversion executes in this
        dashboard.
      </p>
      <div className={css.inputOrder}>
        <span className={css.eyebrow}>
          PROPOSED INPUT ORDER / PROCESSOR RESOLVES TOKEN BOUNDARIES
        </span>
        <ol aria-label="Input packing order">
          {(stage.id === "pretraining"
            ? [
                ["Source identity", "drawing ID + asset ID + split"],
                ["Available modalities", "vision / graph / spatial / text"],
                ["Packed representations", "position + modality + validity masks"],
                ["Objective targets", "paired / masked / grounding targets"],
              ]
            : [
                ["System", "task policy · excluded from response loss"],
                ["User", "evidence + instruction · conditioning"],
                [
                  "Assistant",
                  stage.id === "rl"
                    ? "sampled response · reward-scored"
                    : stage.id === "distillation"
                      ? "verified teacher target · student supervision"
                      : "reviewed target · supervised response tokens",
                ],
                ["Padding", "attention mask = 0 · loss ignored"],
              ]
          ).map(([role, detail], index) => (
            <li key={role}>
              <code>{String(index + 1).padStart(2, "0")}</code>
              <strong>{role}</strong>
              <span>{detail}</span>
            </li>
          ))}
        </ol>
      </div>
      <div
        className={css.tableScroll}
        tabIndex={0}
        role="region"
        aria-label="Input conversion mapping"
      >
        <table className={css.mapping}>
          <thead>
            <tr>
              <th scope="col">Input / source</th>
              <th scope="col">Ordered conversion</th>
              <th scope="col">Model-side representation</th>
              <th scope="col">Evidence boundary</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.field}>
                <th scope="row">
                  <strong>{row.field}</strong>
                  <span>{row.source}</span>
                </th>
                <td>{row.transform}</td>
                <td>
                  <code>{row.tensor}</code>
                </td>
                <td>{row.state}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={css.inspector}>
        <div className={css.inspectorBar}>
          <div className={css.viewButtons} role="group" aria-label="Input inspector view">
            <button
              type="button"
              aria-pressed={view === "record"}
              onClick={() => setView("record")}
            >
              Source record
            </button>
            <button
              type="button"
              aria-pressed={view === "batch"}
              onClick={() => setView("batch")}
            >
              Batch specification
            </button>
          </div>
          <span>
            JSON / {view === "record" ? "selected example" : "applied configuration"}
          </span>
        </div>
        <pre
          tabIndex={0}
          aria-label={
            view === "record" ? "Selected source record" : "Model batch specification"
          }
        >
          <code>{JSON.stringify(view === "record" ? record : batch, undefined, 2)}</code>
        </pre>
      </div>
      <p className={css.notation}>
        <strong>Notation</strong> B = local batch size · L = sequence length · N / E = graph
        nodes / edges · F = node features · Np = point count · W = time window · C =
        channels. Processor-specific dimensions remain unresolved until execution.
      </p>
    </div>
  );
}

export function ModelComputation(
  props: LiveCardProps & {
    readonly sample: LabSample | undefined;
    readonly facts: CorpusFacts;
  },
) {
  const { stage, profile, config, facts, sample, running } = props;
  const spec = LIFECYCLE[stage.id];
  const figure = useMemo(
    () => architectureSpec(stage, config, profile, facts),
    [stage, config, profile, facts],
  );
  return (
    <div className={css.computation}>
      <ArchitectureFigure
        spec={figure}
        running={running}
        sampleTag={sample?.tag}
        stepSeconds={1 / Math.max(1e-9, stage.run.stepsPerSecond)}
      />
      <TrainingDynamics {...props} />
      <details className={css.computationDetails}>
        <summary>Computation contract · module responsibilities</summary>
        <ol className={css.blocks} aria-label="Ordered model computation">
          {spec.blocks.map((block, i) => (
            <li key={block.title}>
              <div className={css.blockLabel}>
                <span>{String(i + 1).padStart(2, "0")}</span>
                <code>{block.symbol}</code>
              </div>
              <h4>{block.title}</h4>
              <p>{block.detail}</p>
              <code className={css.blockOutput}>{block.output}</code>
            </li>
          ))}
        </ol>
      </details>
      <details className={css.computationDetails}>
        <summary>Model code · annotated training specification</summary>
        <pre tabIndex={0}>
          <code>{spec.code}</code>
        </pre>
      </details>
      <p className={css.note}>
        Pseudocode expresses the intended computation, not an installed training
        implementation. d = hidden width; V = vocabulary size; θ = trainable parameters.
        Applied architecture: {profile.spatial.name}; {profile.graph.name}.
      </p>
    </div>
  );
}

export function ExecutionArchitecture({
  config,
  profile,
  stage,
}: Pick<LiveCardProps, "config" | "profile" | "stage">) {
  return (
    <div className={css.panel}>
      <header className={css.panelHeading}>
        <div>
          <span className={css.eyebrow}>TRAINING / SERVING BOUNDARY</span>
          <h3>Execution topology & memory ownership</h3>
        </div>
        <span className={css.badge}>Planning model</span>
      </header>
      <div className={css.executionGrid}>
        <div>
          <h4>Data plane</h4>
          <code>source → loader → processor → workers</code>
          <p>
            Split by drawing before augmentation. Bound decoding, preserve evidence IDs and
            checkpoint sampler state for reproducible restarts.
          </p>
        </div>
        <div>
          <h4>Training workers</h4>
          <code>
            {config.nodes} nodes × {config.gpusPerNode} GPUs = {profile.gpus} ranks
          </code>
          <p>
            {profile.accelerator.name} · {config.precision.toUpperCase()} planned precision.
            The existing memory estimate assumes ZeRO-3 sharding; actual placement and
            collectives require a connected cluster.
          </p>
        </div>
        <div>
          <h4>Memory domains</h4>
          <code>weights / gradients / optimizer / activations</code>
          <p>
            ZeRO partitions training state. Activation memory and communication buffers
            still need a measured budget. The inference KV cache is a separate serving
            concern.
          </p>
        </div>
        <div>
          <h4>Serving qualification</h4>
          <code>processor → prefill → KV cache → decode</code>
          <p>
            Compare vLLM, SGLang or TensorRT-LLM only after validating the exported model
            and multimodal adapters. No inference engine is connected here.
          </p>
        </div>
      </div>
      <div className={css.gate}>
        <strong>
          {stage.id === "distillation" ? "Deployment acceptance" : "Checkpoint acceptance"}
        </strong>
        <p>{LIFECYCLE[stage.id].gate}</p>
      </div>
    </div>
  );
}
