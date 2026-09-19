/**
 * A tensor drawn as its shape. Geometry follows rank and dimensions: a [1, L] sequence is a
 * strip of cells, an image is its token grid (tiles outlined where the processor tiles), a
 * graph is nodes and edges beside its feature matrix, a point cloud is a block of points.
 *
 * Glyphs are decorative companions to the mono shape printed beside them, so they are
 * aria-hidden; the diagram that holds them states their content in its accessible name.
 */

import { hashString } from "@/lib/canvas/engineering";

import type { TensorGlyph as Spec } from "./conversion";

const W = 96;
const H = 52;
/** Most cells drawn along one axis; beyond this, one drawn cell stands for several. */
const MAX_CELLS = 24;

export function TensorGlyph({
  spec,
  colour,
  absent,
}: {
  readonly spec: Spec;
  readonly colour: string;
  readonly absent: boolean;
}) {
  const ink = absent ? "var(--ink-muted)" : colour;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      aria-hidden="true"
      focusable="false"
      style={{ overflow: "visible" }}
    >
      <Body spec={spec} ink={ink} absent={absent} />
    </svg>
  );
}

function Body({
  spec,
  ink,
  absent,
}: {
  readonly spec: Spec;
  readonly ink: string;
  readonly absent: boolean;
}) {
  const dash = absent ? "3 2" : undefined;
  switch (spec.kind) {
    case "grid":
      return <Grid spec={spec} ink={ink} dash={dash} />;
    case "strip":
      return <Strip cells={spec.cells} masked={spec.masked} ink={ink} dash={dash} />;
    case "graph":
      return <Graph hops={spec.hops} ink={ink} dash={dash} />;
    case "points":
      return <Points ink={ink} dash={dash} />;
    case "series":
      return <Series channels={spec.channels} ink={ink} dash={dash} />;
    case "pages":
      return <Pages count={spec.count} ink={ink} dash={dash} />;
    case "group":
      return <Group size={spec.group} ink={ink} />;
    case "vocab":
      return <Vocab ink={ink} />;
  }
}

type Dash = string | undefined;

function Grid({
  spec,
  ink,
  dash,
}: {
  readonly spec: Extract<Spec, { kind: "grid" }>;
  readonly ink: string;
  readonly dash: Dash;
}) {
  const vision = spec.vision;
  if (!vision) {
    // Size not known yet (image loading) or the crop is unavailable: an empty frame.
    return (
      <rect
        x={20}
        y={4}
        width={56}
        height={44}
        fill="none"
        stroke={ink}
        strokeDasharray="3 2"
        vectorEffect="non-scaling-stroke"
      />
    );
  }
  const { cols, rows } = vision;
  const scale = Math.min((W - 8) / cols, (H - 8) / rows);
  const w = cols * scale;
  const h = rows * scale;
  const x0 = (W - w) / 2;
  const y0 = (H - h) / 2;
  const stepX = Math.max(1, Math.ceil(cols / MAX_CELLS));
  const stepY = Math.max(1, Math.ceil(rows / MAX_CELLS));
  const lines: string[] = [];
  for (let c = stepX; c < cols; c += stepX) {
    const x = x0 + c * scale;
    lines.push(`M${x} ${y0}V${y0 + h}`);
  }
  for (let r = stepY; r < rows; r += stepY) {
    const y = y0 + r * scale;
    lines.push(`M${x0} ${y}H${x0 + w}`);
  }
  const tiles: string[] = [];
  for (let t = 1; t < vision.tilesX; t += 1) {
    const x = x0 + (t * w) / vision.tilesX;
    tiles.push(`M${x} ${y0}V${y0 + h}`);
  }
  for (let t = 1; t < vision.tilesY; t += 1) {
    const y = y0 + (t * h) / vision.tilesY;
    tiles.push(`M${x0} ${y}H${x0 + w}`);
  }
  return (
    <g>
      <rect x={x0} y={y0} width={w} height={h} fill={ink} fillOpacity={0.14} />
      <path d={lines.join("")} stroke={ink} strokeOpacity={0.45} strokeWidth={0.5} />
      {tiles.length > 0 && <path d={tiles.join("")} stroke={ink} strokeWidth={1.2} />}
      <rect
        x={x0}
        y={y0}
        width={w}
        height={h}
        fill="none"
        stroke={ink}
        strokeDasharray={dash}
      />
    </g>
  );
}

function Strip({
  cells,
  masked,
  ink,
  dash,
}: {
  readonly cells: number;
  readonly masked?: number;
  readonly ink: string;
  readonly dash: Dash;
}) {
  const drawn = Math.max(1, Math.min(MAX_CELLS, cells));
  const cell = (W - 4) / MAX_CELLS;
  const lead = masked !== undefined && cells > 0 ? Math.round((masked / cells) * drawn) : 0;
  const y = H / 2 - cell / 2;
  return (
    <g>
      {Array.from({ length: drawn }, (_, i) => (
        <rect
          key={i}
          x={2 + i * cell}
          y={y}
          width={cell - 0.8}
          height={cell * 2}
          fill={i < lead ? "none" : ink}
          fillOpacity={0.3}
          stroke={ink}
          strokeOpacity={i < lead ? 0.5 : 0.9}
          strokeWidth={0.6}
          strokeDasharray={i < lead ? "1.5 1.5" : dash}
        />
      ))}
    </g>
  );
}

function Graph({
  hops,
  ink,
  dash,
}: {
  readonly hops: readonly number[];
  readonly ink: string;
  readonly dash: Dash;
}) {
  const cx = 24;
  const cy = H / 2;
  const count = Math.max(1, hops.length);
  const nodes = hops.map((hop, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    const r = 9 + Math.min(4, hop) * 3.2;
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  });
  const rows = Math.min(8, hops.length + 1);
  return (
    <g>
      {nodes.map((node, i) => (
        <line
          key={`e${i}`}
          x1={cx}
          y1={cy}
          x2={node.x}
          y2={node.y}
          stroke={ink}
          strokeOpacity={0.7}
          strokeDasharray="2 1.5"
        />
      ))}
      {nodes.map((node, i) => (
        <circle
          key={`n${i}`}
          cx={node.x}
          cy={node.y}
          r={2.6}
          fill="var(--bg-void)"
          stroke={ink}
          strokeDasharray={dash}
        />
      ))}
      <circle cx={cx} cy={cy} r={3.6} fill={ink} />
      {/* Node features [N, F] beside the graph. */}
      <g transform="translate(58 6)">
        {Array.from({ length: rows }, (_, r) => (
          <rect
            key={r}
            x={0}
            y={r * 5}
            width={30}
            height={4}
            fill={ink}
            fillOpacity={r === 0 ? 0.6 : 0.25}
          />
        ))}
      </g>
    </g>
  );
}

function Points({ ink, dash }: { readonly ink: string; readonly dash: Dash }) {
  // A fixed, seeded cloud inside an isometric block — geometry, not data.
  const seed = hashString("points");
  const dots = Array.from({ length: 42 }, (_, i) => {
    const a = ((seed >>> (i % 24)) ^ (i * 2654435761)) >>> 0;
    const u = (a % 997) / 997;
    const v = ((a >>> 10) % 991) / 991;
    const w = ((a >>> 20) % 983) / 983;
    return { x: 30 + u * 34 + w * 12, y: 14 + v * 22 + w * -8 + 8 };
  });
  return (
    <g>
      <path
        d="M30 20 L64 20 L76 12 L42 12 Z M30 20 V44 H64 V20 M64 44 L76 36 V12"
        fill="none"
        stroke={ink}
        strokeOpacity={0.8}
        strokeDasharray={dash ?? "2 2"}
      />
      {dots.map((dot, i) => (
        <circle key={i} cx={dot.x} cy={dot.y} r={0.9} fill={ink} />
      ))}
    </g>
  );
}

function Series({
  channels,
  ink,
  dash,
}: {
  readonly channels: number;
  readonly ink: string;
  readonly dash: Dash;
}) {
  const rows = Math.min(5, channels);
  const rowH = Math.min(9, (H - 8) / rows);
  return (
    <g>
      {Array.from({ length: rows }, (_, r) =>
        Array.from({ length: 5 }, (_, c) => (
          <rect
            key={`${r}-${c}`}
            x={8 + c * 16}
            y={4 + r * rowH + (H - 8 - rows * rowH) / 2}
            width={15}
            height={rowH - 1.5}
            fill={ink}
            fillOpacity={0.12 + ((r + c) % 3) * 0.1}
            stroke={ink}
            strokeWidth={0.6}
            strokeDasharray={dash}
          />
        )),
      )}
    </g>
  );
}

function Pages({
  count,
  ink,
  dash,
}: {
  readonly count: number;
  readonly ink: string;
  readonly dash: Dash;
}) {
  const shown = Math.min(3, count);
  return (
    <g>
      {Array.from({ length: shown }, (_, i) => (
        <g key={i} transform={`translate(${30 + i * 7} ${6 + i * 4})`}>
          <path
            d="M0 0 H18 L24 6 V32 H0 Z"
            fill="var(--bg-void)"
            stroke={ink}
            strokeDasharray={dash}
          />
          <path d="M4 12 H18 M4 17 H20 M4 22 H14" stroke={ink} strokeOpacity={0.6} />
        </g>
      ))}
    </g>
  );
}

function Group({ size, ink }: { readonly size: number; readonly ink: string }) {
  const cell = Math.min(10, (W - 8) / size);
  const x0 = (W - cell * size) / 2;
  return (
    <g>
      {/* Schematic, not data: Â is zero-mean within a group, so completions sit either side
          of the group baseline. */}
      <line x1={x0 - 2} x2={x0 + cell * size + 2} y1={H / 2} y2={H / 2} stroke={ink} />
      {Array.from({ length: size }, (_, i) => {
        const up = i % 2 === 0;
        const h = 9;
        return (
          <rect
            key={i}
            x={x0 + i * cell + 1}
            y={up ? H / 2 - h : H / 2}
            width={cell - 2}
            height={h}
            fill={ink}
            fillOpacity={up ? 0.55 : 0.2}
            stroke={ink}
            strokeWidth={0.6}
          />
        );
      })}
    </g>
  );
}

function Vocab({ ink }: { readonly ink: string }) {
  // [L, V]: a deep block — every position carries a full distribution over the vocabulary.
  return (
    <g fill="none" stroke={ink}>
      <path d="M14 16 H62 V44 H14 Z" fill={ink} fillOpacity={0.14} />
      <path d="M14 16 L30 6 H78 L62 16 M78 6 V34 L62 44" strokeOpacity={0.8} />
      <path
        d="M22 44 V16 M30 44 V16 M38 44 V16 M46 44 V16 M54 44 V16"
        strokeOpacity={0.35}
      />
    </g>
  );
}
