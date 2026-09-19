"use client";

/**
 * Input conversion as a diagram: one lane per modality (source → ordered operations → tensor
 * shape), ending in the packed sequence the backbone receives — modality spans in model input
 * order, sized by their estimated positions, with the segment row and the stage's loss mask
 * beneath. This is the page's canonical packed-sequence picture.
 */

import { useEffect, useMemo, useState, type CSSProperties } from "react";

import type { CanvasDrawing } from "@/lib/canvas/model";
import type { RunConfig, RunProfile } from "@/lib/modellab/config";
import type { GroundedAnswer, LabSample } from "@/lib/modellab/samples";
import type { StageId } from "@/lib/modellab/stages";

import { Icon, type IconName } from "../icons";
import {
  CHARS_PER_TOKEN,
  LOSS_KEY,
  LOSS_LABEL,
  MODALITY_COLOUR,
  PACKING,
  PAD_MULTIPLE,
  TELEMETRY_PATCH,
  TELEMETRY_WINDOW,
  TURN_OVERHEAD,
  buildLanes,
  packSequence,
  pidCropWindow,
  visionRuleFor,
  type Lane,
  type LossKind,
  type PackedSequence,
} from "./conversion";
import { SampleWalkthrough } from "./SampleWalkthrough";
import { TensorGlyph } from "./TensorGlyph";
import css from "./ConversionDiagram.module.css";

const SOURCE_ICON: Record<Lane["id"], IconName> = {
  vision: "canvas",
  drawing: "canvas",
  topology: "graph",
  spatial: "cube",
  text: "recipe",
  telemetry: "pulse",
  documents: "book",
  target: "target",
};

const STAGE_NAME: Record<StageId, string> = {
  pretraining: "pretraining",
  sft: "supervised fine-tuning",
  rl: "reinforcement learning",
  distillation: "distillation",
};

interface Size {
  readonly src: string;
  readonly width: number;
  readonly height: number;
}

/** The field image's natural size, measured once it loads; undefined until then. */
function useNaturalSize(src: string): Size | undefined {
  const [size, setSize] = useState<Size | undefined>(undefined);
  useEffect(() => {
    const image = new Image();
    image.onload = () =>
      setSize({ src, width: image.naturalWidth, height: image.naturalHeight });
    image.src = src;
    return () => {
      image.onload = null;
    };
  }, [src]);
  return size?.src === src ? size : undefined;
}

export function ConversionDiagram({
  stage,
  config,
  profile,
  sample,
  drawing,
  answer,
  imageUrl,
}: {
  readonly stage: StageId;
  readonly config: RunConfig;
  readonly profile: RunProfile;
  readonly sample: LabSample;
  readonly drawing: CanvasDrawing;
  readonly answer: GroundedAnswer | undefined;
  /** The sheet raster, when the host can resolve it; the sheet's vector geometry otherwise. */
  readonly imageUrl?: string;
}) {
  const natural = useNaturalSize(sample.image);
  const fieldSize = natural ? { width: natural.width, height: natural.height } : undefined;
  const input = { stage, config, profile, sample, answer, fieldSize };
  const lanes = buildLanes(input);
  const packed = packSequence(input, lanes);
  const rule = visionRuleFor(profile.backbone);
  const channels = sample.evidence.timeSeries;

  return (
    <figure
      className={`${css.diagram} engineeringField`}
      role="group"
      aria-label={describe(stage, sample.tag, lanes, packed, rule.rule, channels)}
    >
      <SampleWalkthrough
        sample={sample}
        drawing={drawing}
        imageUrl={imageUrl}
        config={config}
        profile={profile}
      />
      <ol className={css.lanes}>
        {lanes.map((lane, index) => (
          <li
            key={lane.id}
            className={css.lane}
            data-absent={lane.absent ? "true" : undefined}
            style={{ "--lane": MODALITY_COLOUR[lane.id] } as CSSProperties}
          >
            <span className={css.index}>{String(index + 1).padStart(2, "0")}</span>
            <div className={css.source}>
              {lane.id === "vision" ? (
                <FieldThumb sample={sample} size={natural} />
              ) : lane.id === "drawing" && !lane.absent ? (
                <PidThumb sample={sample} drawing={drawing} imageUrl={imageUrl} />
              ) : (
                <span className={css.sourceIcon}>
                  <Icon name={SOURCE_ICON[lane.id]} size={16} />
                </span>
              )}
            </div>
            <div className={css.name}>
              <strong>{lane.name}</strong>
              <code>{lane.source}</code>
            </div>
            <ol className={css.ops}>
              {lane.ops.map((op) => (
                <li key={op.word}>
                  <Icon name={op.icon} size={12} />
                  <span>{op.word}</span>
                </li>
              ))}
            </ol>
            <span className={css.arrow} />
            <div className={css.glyph} key={`${sample.nodeId}:${lane.id}`}>
              <TensorGlyph
                spec={lane.glyph}
                colour={MODALITY_COLOUR[lane.id]}
                absent={Boolean(lane.absent)}
              />
            </div>
            <div className={css.shape} key={`${sample.nodeId}:${lane.id}:shape`}>
              <code>{lane.shape}</code>
              {lane.absent ? (
                <span className={css.reason}>{lane.absent}</span>
              ) : lane.positions !== undefined ? (
                <span className={css.count}>
                  ≈ {lane.positions.toLocaleString("en-US")} pos
                </span>
              ) : lane.glyph.kind === "grid" ? (
                <span className={css.count}>measuring…</span>
              ) : lane.id === "topology" ? (
                <span className={css.count}>in text</span>
              ) : lane.id === "target" ? (
                <span className={css.count}>loss row</span>
              ) : undefined}
            </div>
          </li>
        ))}
      </ol>

      <PackedBar stage={stage} packed={packed} />
    </figure>
  );
}

function PackedBar({
  stage,
  packed,
}: {
  readonly stage: StageId;
  readonly packed: PackedSequence;
}) {
  const segments = useMemo(() => {
    const out: { segment: string; tokens: number }[] = [];
    for (const span of packed.spans) {
      const last = out.at(-1);
      if (last && last.segment === span.segment) last.tokens += span.tokens;
      else out.push({ segment: span.segment, tokens: span.tokens });
    }
    return out;
  }, [packed]);
  const supervised = packed.spans
    .filter((span) => span.loss !== "none")
    .reduce((sum, span) => sum + span.tokens, 0);
  const packing = PACKING[stage];
  const limit = packing.length;
  const over = limit !== undefined && packed.used > limit;
  return (
    <div className={css.packed}>
      <div className={css.packedHead}>
        <span className={css.packedTitle}>PACKED SEQUENCE</span>
        <code>
          L = {packed.total.toLocaleString("en-US")} · {packed.used.toLocaleString("en-US")}{" "}
          used · {supervised.toLocaleString("en-US")} supervised
          {packed.pending ? " · pending" : ""}
        </code>
      </div>
      <div className={css.rows}>
        {limit !== undefined && (
          <>
            <span className={css.rowLabel}>{packing.packed ? "pack" : "limit"}</span>
            <div className={css.track}>
              <span
                className={css.packUsed}
                data-over={over ? "true" : undefined}
                style={{ flexGrow: Math.min(packed.used, limit) }}
              >
                <b>sample{over ? ` > ${limit.toLocaleString("en-US")}` : ""}</b>
              </span>
              {!over && (
                <span
                  className={css.packRest}
                  data-packed={packing.packed ? "true" : undefined}
                  style={{ flexGrow: limit - packed.used }}
                >
                  <b>
                    {packing.packed ? "next · reset" : "unused"} ·{" "}
                    {limit.toLocaleString("en-US")}
                  </b>
                </span>
              )}
            </div>
          </>
        )}
        <span className={css.rowLabel}>input</span>
        <div className={css.track}>
          {packed.spans.map((span) => (
            <span
              key={span.id}
              className={css.span}
              data-pad={span.modality === "pad" ? "true" : undefined}
              style={
                {
                  flexGrow: span.tokens,
                  "--lane":
                    span.modality === "pad"
                      ? "var(--ink-muted)"
                      : MODALITY_COLOUR[span.modality],
                } as CSSProperties
              }
            >
              <b>{span.label}</b>
              <small>{span.tokens.toLocaleString("en-US")}</small>
            </span>
          ))}
        </div>
        <span className={css.rowLabel}>segment</span>
        <div className={css.track}>
          {segments.map((segment, index) => (
            <span
              key={`${segment.segment}-${index}`}
              className={css.segment}
              data-pad={segment.segment === "pad" ? "true" : undefined}
              style={{ flexGrow: segment.tokens }}
            >
              <b>{segment.segment === "pad" ? "mask 0" : segment.segment}</b>
            </span>
          ))}
        </div>
        <span className={css.rowLabel}>loss</span>
        <div className={css.track}>
          {packed.spans.map((span) => (
            <span
              key={span.id}
              className={css.loss}
              data-loss={span.loss}
              style={{ flexGrow: span.tokens }}
            />
          ))}
        </div>
      </div>
      <ul className={css.lossKey}>
        {(["none", ...LOSS_KEY[stage]] as LossKind[]).map((kind) => (
          <li key={kind}>
            <span className={css.lossSwatch} data-loss={kind} />
            {LOSS_LABEL[kind]}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FieldThumb({
  sample,
  size,
}: {
  readonly sample: LabSample;
  readonly size: Size | undefined;
}) {
  const { box } = sample;
  const aspect = size
    ? (box.width * size.width) / Math.max(1, box.height * size.height)
    : 1.4;
  return (
    <span
      className={css.thumb}
      style={{ aspectRatio: String(Math.min(2.4, Math.max(0.6, aspect))) }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={sample.image}
        alt=""
        loading="lazy"
        style={{
          width: `${(100 / box.width) * 100}%`,
          height: `${(100 / box.height) * 100}%`,
          left: `${(-box.x / box.width) * 100}%`,
          top: `${(-box.y / box.height) * 100}%`,
        }}
      />
    </span>
  );
}

function PidThumb({
  sample,
  drawing,
  imageUrl,
}: {
  readonly sample: LabSample;
  readonly drawing: CanvasDrawing;
  readonly imageUrl?: string;
}) {
  const node = sample.node;
  const window = pidCropWindow(node);
  // The sheet geometry inside the crop window: the same symbols the raster would show.
  const nearby = useMemo(
    () =>
      imageUrl
        ? []
        : drawing.nodes.filter(
            (other) =>
              other.positioned !== false &&
              other.id !== node.id &&
              Math.abs(other.x - node.x) < window.width / 2 &&
              Math.abs(other.y - node.y) < window.height / 2,
          ),
    [drawing, node, window.width, window.height, imageUrl],
  );
  const stroke = window.height / 60;
  return (
    <span className={css.thumb} style={{ aspectRatio: "1.35" }}>
      <svg
        viewBox={`${window.x} ${window.y} ${window.width} ${window.height}`}
        preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"
        focusable="false"
      >
        <rect
          x={window.x}
          y={window.y}
          width={window.width}
          height={window.height}
          fill="var(--bg-void)"
        />
        {imageUrl ? (
          <image
            className="engineeringRaster"
            href={imageUrl}
            width={drawing.width}
            height={drawing.height}
          />
        ) : (
          nearby.map((other) => (
            <rect
              key={other.id}
              x={other.x - other.width / 2}
              y={other.y - other.height / 2}
              width={other.width}
              height={other.height}
              fill="none"
              stroke="var(--ink-muted)"
              strokeWidth={stroke}
            />
          ))
        )}
        <rect
          x={node.x - node.width / 2}
          y={node.y - node.height / 2}
          width={node.width}
          height={node.height}
          fill="none"
          stroke="var(--overlay-selected)"
          strokeWidth={stroke * 1.6}
        />
      </svg>
    </span>
  );
}

/** The diagram's content in words, for its accessible name. */
function describe(
  stage: StageId,
  tag: string,
  lanes: readonly Lane[],
  packed: PackedSequence,
  visionRule: string,
  channels: number,
): string {
  const laneText = lanes
    .map((lane) =>
      lane.absent
        ? `${lane.name} absent (${lane.absent})`
        : `${lane.name} ${lane.shape}${lane.positions !== undefined ? `, about ${lane.positions} positions` : ""}`,
    )
    .join("; ");
  const spanText = packed.spans
    .map(
      (span) =>
        `${span.label} ${span.tokens}${span.loss !== "none" ? ` (${LOSS_LABEL[span.loss]})` : ""}`,
    )
    .join(", ");
  const rules = `Estimation rules: vision ${visionRule}; text about characters ÷ ${CHARS_PER_TOKEN} plus ${TURN_OVERHEAD} per turn; graph one position per node; telemetry window ${TELEMETRY_WINDOW} ÷ patch ${TELEMETRY_PATCH} = ${TELEMETRY_WINDOW / TELEMETRY_PATCH} positions per channel${channels > 0 ? ` × ${channels} channels` : ""}; padded to a multiple of ${PAD_MULTIPLE}. Dimensions: B batch, L length, N and E nodes and edges, F features, Np points, W window, C channels, V vocabulary. Counts are estimates; no processor, tokenizer or encoder runs here.`;
  return `Input conversion for ${tag}, ${STAGE_NAME[stage]}. Lanes: ${laneText}. Packed sequence of ${packed.total} positions, estimated: ${spanText}. ${rules}`;
}
