"use client";

/**
 * The selected sample walked from sheet to tokens, in three figures that share one crop:
 * the P&ID window with its detections and wiring, the same window cut into the processor's
 * patch grid (merged tokens outlined, the symbol's tokens filled, then read out in raster
 * order), and the reachable subgraph projected around the symbol — bearing from the sheet,
 * radius from hop count — with the node-feature rows it becomes.
 */

import { useMemo, type CSSProperties } from "react";

import type { CanvasDrawing, DrawingNode } from "@/lib/canvas/model";
import type { RunConfig, RunProfile } from "@/lib/modellab/config";
import type { LabSample } from "@/lib/modellab/samples";

import {
  MODALITY_COLOUR,
  pidCropWindow,
  textTokens,
  topologyText,
  visionRuleFor,
} from "./conversion";
import css from "./ConversionDiagram.module.css";

type Window = ReturnType<typeof pidCropWindow>;

function inWindow(node: DrawingNode, window: Window): boolean {
  return (
    node.positioned !== false &&
    node.x + node.width / 2 > window.x &&
    node.x - node.width / 2 < window.x + window.width &&
    node.y + node.height / 2 > window.y &&
    node.y - node.height / 2 < window.y + window.height
  );
}

export function SampleWalkthrough({
  sample,
  drawing,
  imageUrl,
  config,
  profile,
}: {
  readonly sample: LabSample;
  readonly drawing: CanvasDrawing;
  readonly imageUrl?: string;
  readonly config: RunConfig;
  readonly profile: RunProfile;
}) {
  const node = sample.node;
  const positioned = node.positioned !== false;
  const window = useMemo(() => pidCropWindow(node), [node]);
  const nearby = useMemo(
    () => drawing.nodes.filter((other) => other.id !== node.id && inWindow(other, window)),
    [drawing, node, window],
  );
  if (!positioned) return null;
  return (
    <div className={css.walk}>
      <CropPanel
        sample={sample}
        drawing={drawing}
        imageUrl={imageUrl}
        window={window}
        nearby={nearby}
      />
      <PatchPanel
        sample={sample}
        drawing={drawing}
        imageUrl={imageUrl}
        window={window}
        nearby={nearby}
        profile={profile}
      />
      <GraphPanel sample={sample} drawing={drawing} graphOn={config.graph !== "none"} />
    </div>
  );
}

/** The sheet under the crop: the raster when the host resolves it, vector geometry otherwise. */
function Sheet({
  drawing,
  imageUrl,
  window,
  nearby,
}: {
  readonly drawing: CanvasDrawing;
  readonly imageUrl?: string;
  readonly window: Window;
  readonly nearby: readonly DrawingNode[];
}) {
  return (
    <>
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
            strokeWidth={window.height / 90}
          />
        ))
      )}
    </>
  );
}

function CropPanel({
  sample,
  drawing,
  imageUrl,
  window,
  nearby,
}: {
  readonly sample: LabSample;
  readonly drawing: CanvasDrawing;
  readonly imageUrl?: string;
  readonly window: Window;
  readonly nearby: readonly DrawingNode[];
}) {
  const node = sample.node;
  const related = new Set(sample.neighbours.map((n) => n.id));
  const byId = new Map([node, ...nearby].map((n) => [n.id, n]));
  const wires = drawing.edges.filter(
    (edge) => byId.has(edge.source) && byId.has(edge.target),
  );
  const stroke = window.height / 110;
  return (
    <figure className={css.walkPanel}>
      <svg
        viewBox={`${window.x} ${window.y} ${window.width} ${window.height}`}
        preserveAspectRatio="xMidYMid slice"
        role="img"
        aria-label={`P&ID crop around ${sample.tag}: ${nearby.length + 1} detected symbols, ${wires.length} connections in view`}
      >
        <Sheet drawing={drawing} imageUrl={imageUrl} window={window} nearby={nearby} />
        {wires.map((edge) => {
          const a = byId.get(edge.source)!;
          const b = byId.get(edge.target)!;
          return (
            <line
              key={`${edge.source}>${edge.target}`}
              className={css.wire}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              style={{ strokeWidth: stroke }}
            />
          );
        })}
        {nearby.map((other) => (
          <rect
            key={other.id}
            className={css.det}
            data-related={related.has(other.id) || undefined}
            x={other.x - other.width / 2}
            y={other.y - other.height / 2}
            width={other.width}
            height={other.height}
            style={{ strokeWidth: stroke }}
          />
        ))}
        <rect
          className={css.det}
          data-selected
          x={node.x - node.width / 2}
          y={node.y - node.height / 2}
          width={node.width}
          height={node.height}
          style={{ strokeWidth: stroke * 1.8 }}
        />
      </svg>
      <figcaption>
        <b>crop</b>
        <code>
          {nearby.length + 1} det · {wires.length} wire
        </code>
      </figcaption>
    </figure>
  );
}

function PatchPanel({
  sample,
  drawing,
  imageUrl,
  window,
  nearby,
  profile,
}: {
  readonly sample: LabSample;
  readonly drawing: CanvasDrawing;
  readonly imageUrl?: string;
  readonly window: Window;
  readonly nearby: readonly DrawingNode[];
  readonly profile: RunProfile;
}) {
  const node = sample.node;
  const rule = visionRuleFor(profile.backbone);
  const est = rule.estimate(window.width, window.height);
  const { cols, rows } = est;
  const cw = window.width / cols;
  const ch = window.height / rows;
  // Merged-token cells the symbol's box overlaps, in raster order.
  const hit = new Set<number>();
  const c0 = Math.max(0, Math.floor((node.x - node.width / 2 - window.x) / cw));
  const c1 = Math.min(cols - 1, Math.floor((node.x + node.width / 2 - window.x) / cw));
  const r0 = Math.max(0, Math.floor((node.y - node.height / 2 - window.y) / ch));
  const r1 = Math.min(rows - 1, Math.floor((node.y + node.height / 2 - window.y) / ch));
  for (let r = r0; r <= r1; r += 1) for (let c = c0; c <= c1; c += 1) hit.add(r * cols + c);

  // Qwen-style processors see 2 × 2 raw patches per merged token; tiling ones see 16 × 16
  // (InternVL) or 40 × 40 (Llama) per tile. Raw patch lines are drawn only when legible.
  const sub = rule.family.startsWith("Qwen") ? 2 : 1;
  const lines: string[] = [];
  const fine: string[] = [];
  for (let c = 1; c < cols * sub; c += 1) {
    const x = window.x + (c * cw) / sub;
    (c % sub === 0 ? lines : fine).push(`M${x} ${window.y}V${window.y + window.height}`);
  }
  for (let r = 1; r < rows * sub; r += 1) {
    const y = window.y + (r * ch) / sub;
    (r % sub === 0 ? lines : fine).push(`M${window.x} ${y}H${window.x + window.width}`);
  }
  const tiles: string[] = [];
  for (let t = 1; t < est.tilesX; t += 1) {
    const x = window.x + (t * window.width) / est.tilesX;
    tiles.push(`M${x} ${window.y}V${window.y + window.height}`);
  }
  for (let t = 1; t < est.tilesY; t += 1) {
    const y = window.y + (t * window.height) / est.tilesY;
    tiles.push(`M${window.x} ${y}H${window.x + window.width}`);
  }
  const unit = window.height / 200;
  const tokens = cols * rows;
  // Raster-order readout, one cell per merged token (bucketed when long).
  const perCell = Math.max(1, Math.ceil(tokens / 96));
  const cells = Math.ceil(tokens / perCell);
  return (
    <figure className={css.walkPanel}>
      <svg
        viewBox={`${window.x} ${window.y} ${window.width} ${window.height}`}
        preserveAspectRatio="xMidYMid slice"
        role="img"
        aria-label={`${rule.family} patch grid over the crop: ${cols} by ${rows} = ${tokens} visual tokens (${rule.rule}); the symbol covers ${hit.size} of them${est.crossAttention ? "; the image reaches the backbone by cross-attention, one sequence position" : ""}`}
      >
        <g className={css.dimmed}>
          <Sheet drawing={drawing} imageUrl={imageUrl} window={window} nearby={nearby} />
        </g>
        {[...hit].map((index) => (
          <rect
            key={index}
            className={css.hitCell}
            x={window.x + (index % cols) * cw}
            y={window.y + Math.floor(index / cols) * ch}
            width={cw}
            height={ch}
          />
        ))}
        {fine.length > 0 && cols * sub <= 64 && (
          <path className={css.gridFine} d={fine.join("")} style={{ strokeWidth: unit }} />
        )}
        <path
          className={css.gridLine}
          d={lines.join("")}
          style={{ strokeWidth: unit * 1.4 }}
        />
        {tiles.length > 0 && (
          <path
            className={css.gridTile}
            d={tiles.join("")}
            style={{ strokeWidth: unit * 4 }}
          />
        )}
      </svg>
      <div className={css.readout} aria-hidden="true">
        {Array.from({ length: cells }, (_, i) => {
          let on = false;
          for (let k = i * perCell; k < Math.min(tokens, (i + 1) * perCell); k += 1)
            if (hit.has(k)) on = true;
          return <i key={i} data-hit={on || undefined} />;
        })}
      </div>
      <figcaption>
        <b>patchify</b>
        <code>
          {cols}×{rows} = {tokens} tok{est.crossAttention ? " · x-attn" : ""} · {hit.size}{" "}
          on symbol
        </code>
      </figcaption>
    </figure>
  );
}

const PW = 200;
const PH = 130;

function GraphPanel({
  sample,
  drawing,
  graphOn,
}: {
  readonly sample: LabSample;
  readonly drawing: CanvasDrawing;
  readonly graphOn: boolean;
}) {
  const node = sample.node;
  const byId = new Map(drawing.nodes.map((n) => [n.id, n]));
  const maxHop = Math.max(1, ...sample.neighbours.map((n) => n.hops));
  const cx = PW / 2;
  const cy = PH / 2;
  const radius = (hops: number) => 14 + (Math.min(hops, maxHop) / maxHop) * (PH / 2 - 18);
  const placed = sample.neighbours.map((neighbour, i) => {
    const at = byId.get(neighbour.id);
    // Bearing from the sheet where the neighbour is drawn; evenly spread otherwise.
    const angle =
      at && at.positioned !== false && (at.x !== node.x || at.y !== node.y)
        ? Math.atan2(at.y - node.y, at.x - node.x)
        : -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, sample.neighbours.length);
    const r = radius(neighbour.hops);
    return {
      neighbour,
      x: cx + r * Math.cos(angle) * 1.45,
      y: cy + r * Math.sin(angle),
    };
  });
  const ids = new Map(placed.map((p) => [p.neighbour.id, p]));
  const centre = { x: cx, y: cy };
  const wires = drawing.edges.filter(
    (edge) =>
      (edge.source === node.id || ids.has(edge.source)) &&
      (edge.target === node.id || ids.has(edge.target)),
  );
  const point = (id: string) => (id === node.id ? centre : ids.get(id));
  const n = 1 + sample.joinedCount;
  const colour = MODALITY_COLOUR.topology;
  const serialised = textTokens(topologyText(sample));
  return (
    <figure className={css.walkPanel} style={{ "--lane": colour } as CSSProperties}>
      <svg
        viewBox={`0 0 ${PW} ${PH}`}
        role="img"
        aria-label={`Subgraph of ${sample.tag}: ${sample.neighbours.length} neighbours shown of ${sample.joinedCount} reachable, placed by bearing on the sheet and hop count; ${
          graphOn
            ? `graph encoder input x [${n}, F] and edge_index [2, E], ${n} graph positions`
            : `serialised as about ${serialised} text tokens`
        }`}
      >
        {Array.from({ length: maxHop }, (_, h) => (
          <ellipse
            key={h}
            className={css.hopRing}
            cx={cx}
            cy={cy}
            rx={radius(h + 1) * 1.45}
            ry={radius(h + 1)}
          />
        ))}
        {(wires.length > 0
          ? wires.map((edge) => [point(edge.source), point(edge.target)] as const)
          : placed.map((p) => [centre, p] as const)
        ).map(([a, b], i) =>
          a && b ? (
            <line
              key={i}
              className={css.graphEdge}
              data-inferred={wires.length === 0 || undefined}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
            />
          ) : null,
        )}
        {placed.map((p) => (
          <g key={p.neighbour.id}>
            <circle className={css.graphNode} cx={p.x} cy={p.y} r={4} />
            <text className={css.graphLabel} x={p.x} y={p.y - 7} textAnchor="middle">
              {p.neighbour.tag}
            </text>
          </g>
        ))}
        <circle className={css.graphHub} cx={cx} cy={cy} r={5.5} />
        <text className={css.graphLabel} data-hub x={cx} y={cy + 16} textAnchor="middle">
          {sample.tag}
        </text>
      </svg>
      <div className={css.features} aria-hidden="true">
        {graphOn
          ? Array.from({ length: Math.min(12, n) }, (_, i) => (
              <i key={i} data-hub={i === 0 || undefined} />
            ))
          : Array.from({ length: Math.min(48, serialised) }, (_, i) => (
              <i key={i} data-token />
            ))}
      </div>
      <figcaption>
        <b>{graphOn ? "subgraph" : "serialise"}</b>
        <code>{graphOn ? `x [${n}, F] → ${n} pos` : `input_ids [1, ${serialised}]`}</code>
      </figcaption>
    </figure>
  );
}
