"use client";

import { useMemo, useState, type ReactNode } from "react";

import type { CanvasDrawing } from "@/lib/canvas/model";
import { architectureSpec } from "@/lib/modellab/architecture";
import { LIFECYCLE, type ComputationBlock } from "@/lib/modellab/lifecycle";
import type { CorpusFacts, GroundedAnswer, LabSample } from "@/lib/modellab/samples";
import type { Stage } from "@/lib/modellab/stages";

import { ArchitectureFigure } from "./ArchitectureFigure";
import type { LiveCardProps } from "./live";
import { TrainingDynamics } from "./TrainingDynamics";
import { ConversionDiagram } from "./visual/ConversionDiagram";
import { ExecutionDiagrams } from "./visual/ExecutionDiagrams";
import css from "./LifecycleWorkbench.module.css";

type SectionGlyph = "data" | "input" | "model" | "execution" | "evaluation" | "handoff";

/**
 * The page's six sections in training order: id (anchor), short title, glyph, and the
 * sentence a screen reader hears in place of the removed section description.
 */
const SECTIONS: readonly (readonly [string, string, SectionGlyph, string])[] = [
  [
    "sources",
    "Data contract",
    "data",
    "Source availability, modality joins and the evidence this stage requires.",
  ],
  [
    "conversion",
    "Input conversion",
    "input",
    "One selected example followed from source geometry to the model-side input contract.",
  ],
  [
    "computation",
    "Model computation",
    "model",
    "Forward path, supervision and parameter update in execution order.",
  ],
  [
    "execution",
    "Execution",
    "execution",
    "The live run, runtime configuration, memory plan, hardware and run log.",
  ],
  [
    "evaluation",
    "Evaluation",
    "evaluation",
    "Held-out metrics, objective curves and checkpoint evidence before promotion.",
  ],
  [
    "artifacts",
    "Handoff",
    "handoff",
    "Generated configuration files and the checkpoint handed to the next stage.",
  ],
];

/** One small drawn mark per section, in the figure grammar's ink. */
function Glyph({ kind }: { readonly kind: SectionGlyph }) {
  const paths: Record<SectionGlyph, ReactNode> = {
    // stacked records
    data: (
      <>
        <rect x="3" y="3" width="14" height="4" rx="1" />
        <rect x="3" y="8" width="14" height="4" rx="1" />
        <rect x="3" y="13" width="14" height="4" rx="1" />
      </>
    ),
    // record → token grid
    input: (
      <>
        <rect x="2" y="6" width="5" height="8" rx="1" />
        <path d="M8 10h3m-1.5-1.5L11 10l-1.5 1.5" />
        <path d="M12 5h6v10h-6zM12 8.3h6M12 11.6h6M15 5v10" />
      </>
    ),
    // layer stack
    model: (
      <>
        <path d="M10 3 17 6.5 10 10 3 6.5Z" />
        <path d="M3 10 10 13.5 17 10" />
        <path d="M3 13.5 10 17 17 13.5" />
      </>
    ),
    // device grid
    execution: (
      <>
        <rect x="3" y="3" width="6" height="6" rx="1" />
        <rect x="11" y="3" width="6" height="6" rx="1" />
        <rect x="3" y="11" width="6" height="6" rx="1" />
        <rect x="11" y="11" width="6" height="6" rx="1" />
      </>
    ),
    // descending objective
    evaluation: <path d="M3 3v14h14M5 6c3 0 4 7 7 7 2 0 3-2 5-2" />,
    // checkpoint diamond → arrow
    handoff: (
      <>
        <path d="M7 5 11 10 7 15 3 10Z" />
        <path d="M12 10h5m-2-2 2 2-2 2" />
      </>
    ),
  };
  return (
    <svg
      className={css.glyph}
      viewBox="0 0 20 20"
      width="20"
      height="20"
      aria-hidden="true"
      focusable="false"
    >
      {paths[kind]}
    </svg>
  );
}

/**
 * The stage's section map drawn as a flow: data → input → model → execution → evaluation →
 * handoff, one node per section. The stage's purpose and its inputs and outputs are read to
 * assistive technology; on screen the flow carries them.
 */
export function LifecycleOverview({
  stage,
  running = false,
}: {
  readonly stage: Stage;
  readonly running?: boolean;
}) {
  const spec = LIFECYCLE[stage.id];
  return (
    <section className={css.overview} aria-label="Stage execution overview">
      <p className={css.srOnly}>
        {spec.purpose} Consumes: {spec.input}. Supervision: {spec.supervision}. Produces:{" "}
        {spec.output}.
      </p>
      <nav aria-label="Stage analysis sections">
        <ol className={css.sequence}>
          {SECTIONS.map(([id, label, glyph], index) => (
            <li key={id} data-live={(glyph === "execution" && running) || undefined}>
              <a href={`#lifecycle-${id}`}>
                <Glyph kind={glyph} />
                <span className={css.sequenceNumber}>
                  {String(index + 1).padStart(2, "0")}
                </span>
                <strong>{label}</strong>
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
  children,
}: {
  readonly index: number;
  readonly children: ReactNode;
}) {
  const section = SECTIONS[index];
  if (!section) return undefined;
  const [id, title, glyph, description] = section;
  return (
    <section
      id={`lifecycle-${id}`}
      className={css.section}
      aria-labelledby={`heading-${id}`}
      aria-describedby={`description-${id}`}
    >
      <header className={css.sectionHeading}>
        <span className={css.sectionNumber}>{String(index + 1).padStart(2, "0")}</span>
        <Glyph kind={glyph} />
        <h2 id={`heading-${id}`}>{title}</h2>
        <span className={css.sectionRule} aria-hidden="true" />
        <p id={`description-${id}`} className={css.srOnly}>
          {description}
        </p>
      </header>
      {children}
    </section>
  );
}

/** All record fields come from the selected sample; tensors and counts are stated estimates. */
export function InputConversion({
  stage,
  config,
  profile,
  sample,
  drawing,
  answer,
  imageUrl,
}: Pick<LiveCardProps, "stage" | "config" | "profile"> & {
  readonly sample: LabSample | undefined;
  readonly drawing: CanvasDrawing;
  readonly answer: GroundedAnswer | undefined;
  /** The sheet raster URL, when the host resolves it; the crop falls back to sheet geometry. */
  readonly imageUrl?: string;
}) {
  const [view, setView] = useState<"record" | "batch">("record");
  if (!sample)
    return (
      <div className={css.panel}>
        <p className={css.note}>
          <span aria-hidden="true">no sample</span>
          <span className="srOnly">
            No registered sample is available. Load a drawing with linked field references
            to inspect its input mapping.
          </span>
        </p>
      </div>
    );

  const graphEnabled = config.graph !== "none";
  const spatialEnabled = config.spatial !== "none";
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
    instruction: answer?.question ?? null,
    illustrative_target: answer?.text ?? null,
    target_origin: "register_composed · unreviewed",
  };
  const batch = {
    status: "spec_only · worker_not_connected",
    backbone: profile.backbone.name,
    global_batch: config.globalBatch,
    local_micro_batch: null,
    context_limit_tokens: profile.backbone.contextK * 1024,
    input_ids: "int64[B, L]",
    attention_mask: "bool[B, L]",
    pixel_values: "processor-specific",
    graph: graphEnabled
      ? `${profile.graph.name} · node_features[N, F] · edge_index[2, E]`
      : "serialised_text",
    spatial: spatialEnabled ? `${profile.spatial.name} · unmeasured` : "disabled",
    supervision: LIFECYCLE[stage.id].supervision,
    precision_policy: config.precision === "fp8" ? "fp8 · fp32_master" : "bf16_mixed",
  };
  return (
    <div className={css.panel}>
      <header className={css.panelHeading}>
        <div>
          <span className={css.eyebrow}>SELECTED RECORD / {sample.tag}</span>
          <h3>Evidence → tensors → packed sequence</h3>
        </div>
        <span className={css.badge}>Estimate</span>
      </header>
      <ConversionDiagram
        stage={stage.id}
        config={config}
        profile={profile}
        sample={sample}
        drawing={drawing}
        answer={answer}
        imageUrl={imageUrl}
      />
      <details className={css.raw}>
        <summary>Raw record</summary>
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
            <span>JSON</span>
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
      </details>
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
      <TensorRibbon
        blocks={spec.blocks}
        running={running}
        label={`Tensor-shape ribbon, ${stage.title}: ${spec.blocks
          .map(
            (block) =>
              `${block.title} (${block.symbol}) — ${block.detail} Output ${block.output}.`,
          )
          .join(
            " ",
          )} Symbolic shapes: B batch, L sequence length, d hidden width, V vocabulary, G group size, θ trainable parameters. Applied encoders: ${profile.spatial.name}; ${profile.graph.name}. A specification, not an installed training implementation.`}
      />
      <TrainingDynamics {...props} />
    </div>
  );
}

/**
 * The computation's module responsibilities as one ribbon of tensor glyphs: each module's
 * operator symbol above the tensor it hands on, joined by solid forward connectors in
 * execution order (the figure grammar's forward activations), with the update written back
 * along a dashed return (backward gradient). While the run is live the forward connectors
 * carry the flow mark.
 */
function TensorRibbon({
  blocks,
  running,
  label,
}: {
  readonly blocks: readonly ComputationBlock[];
  readonly running: boolean;
  readonly label: string;
}) {
  return (
    <figure
      className={`${css.ribbon} engineeringField`}
      role="img"
      aria-label={label}
      data-running={running || undefined}
    >
      <figcaption className={css.ribbonCaption} aria-hidden="true">
        FIGURE 03B · TENSOR CONTRACT
      </figcaption>
      <ol className={css.ribbonTrack} aria-hidden="true">
        {blocks.map((block, i) => (
          <li key={block.title} className={css.ribbonNode}>
            <span className={css.ribbonIndex}>{String(i + 1).padStart(2, "0")}</span>
            <code className={css.ribbonSymbol}>{block.symbol}</code>
            <span className={css.ribbonTitle}>{block.title}</span>
            <code className={css.ribbonTensor}>{block.output}</code>
            {i < blocks.length - 1 && <i className={css.ribbonPulse} />}
          </li>
        ))}
      </ol>
      <span className={css.ribbonReturn} aria-hidden="true">
        <i />
        <code>∇θ</code>
      </span>
    </figure>
  );
}

export function ExecutionArchitecture({
  config,
  profile,
  stage,
  step,
  running,
}: Pick<LiveCardProps, "config" | "profile" | "stage" | "step" | "running">) {
  // The acceptance gate is drawn against its targets in §05; here it stays only as the
  // figure's accessible description.
  const gate = LIFECYCLE[stage.id].gate;
  return (
    <div className={css.panel} role="group" aria-labelledby="execution-architecture-title">
      <header className={css.panelHeading}>
        <div>
          <span className={css.eyebrow}>FIGURE 04C–F</span>
          <h3 id="execution-architecture-title">Mesh · HBM · data · serving</h3>
        </div>
        <span className={css.badge}>Estimate</span>
      </header>
      <ExecutionDiagrams
        stage={stage}
        step={step}
        running={running}
        config={config}
        profile={profile}
      />
      <p className="srOnly">
        {stage.id === "distillation" ? "Deployment acceptance: " : "Checkpoint acceptance: "}
        {gate}
      </p>
    </div>
  );
}
