/**
 * The input-conversion model behind the "evidence → tensors → packed sequence" diagram.
 *
 * Everything here is a pure function of the selected sample, the stage and the applied
 * configuration. Nothing is tokenised or encoded: token counts are estimates from the rules
 * stated by the constants and rules below, each of which the diagram's legend prints, so a reader can redo the
 * arithmetic. Where a count depends on something the page cannot know until an image has
 * loaded (its pixel size), the count is `undefined` until it can be computed, never guessed.
 */

import type { Backbone, RunConfig, RunProfile } from "@/lib/modellab/config";
import { GROUP_SIZE } from "@/lib/modellab/config";
import type { GroundedAnswer, LabSample } from "@/lib/modellab/samples";
import type { StageId } from "@/lib/modellab/stages";

import type { IconName } from "../icons";

// ── modalities ─────────────────────────────────────────────────────────────────────────────

export type ModalityId =
  | "vision"
  | "drawing"
  | "topology"
  | "spatial"
  | "text"
  | "telemetry"
  | "documents"
  | "target";

/** Lane order, and the fixed categorical colour each modality takes everywhere on the page. */
export const MODALITIES: readonly ModalityId[] = [
  "vision",
  "drawing",
  "topology",
  "spatial",
  "text",
  "telemetry",
  "documents",
  "target",
];

export const MODALITY_COLOUR: Record<ModalityId, string> = {
  vision: "var(--series-1)",
  drawing: "var(--series-2)",
  topology: "var(--series-3)",
  spatial: "var(--series-4)",
  text: "var(--series-5)",
  telemetry: "var(--series-6)",
  documents: "var(--series-7)",
  target: "var(--series-8)",
};

// ── stated estimation rules ────────────────────────────────────────────────────────────────

/** Characters per BPE token for English engineering text: the usual rule of thumb. */
export const CHARS_PER_TOKEN = 4;
/** Role markers a chat template adds per turn (`<|im_start|>role\n … <|im_end|>\n`). */
export const TURN_OVERHEAD = 5;
/** Sequences are padded to a multiple of this many positions. */
export const PAD_MULTIPLE = 64;
/** Telemetry window: one hour at one-minute cadence, patched into 12-sample slots. */
export const TELEMETRY_WINDOW = 60;
export const TELEMETRY_PATCH = 12;
/** The proposed system turn for the instruction stages. */
export const SYSTEM_POLICY =
  "Answer only from the supplied plant evidence. Cite every source; abstain when evidence is missing.";

export const textTokens = (text: string) =>
  text.length === 0 ? 0 : Math.ceil(text.length / CHARS_PER_TOKEN);

// ── vision ─────────────────────────────────────────────────────────────────────────────────

export interface VisionEstimate {
  /** Sequence positions the image occupies, boundary tokens included. */
  readonly positions: number;
  /** Visual tokens after any merge — the cells the glyph draws. */
  readonly cols: number;
  readonly rows: number;
  /** Tiles, for tiling processors; 1 otherwise. */
  readonly tilesX: number;
  readonly tilesY: number;
  /** True when the image reaches the backbone by cross-attention, not as sequence tokens. */
  readonly crossAttention: boolean;
  readonly shape: string;
}

export interface VisionRule {
  readonly family: string;
  /** The rule as the legend prints it. */
  readonly rule: string;
  estimate(width: number, height: number): VisionEstimate;
}

/** Qwen-VL `smart_resize`: snap each side to the merge grid, then clamp the pixel count. */
export function smartResize(
  height: number,
  width: number,
  factor: number,
  minPixels: number,
  maxPixels: number,
): readonly [number, number] {
  let h = Math.max(factor, Math.round(height / factor) * factor);
  let w = Math.max(factor, Math.round(width / factor) * factor);
  if (h * w > maxPixels) {
    const beta = Math.sqrt((height * width) / maxPixels);
    h = Math.max(factor, Math.floor(height / beta / factor) * factor);
    w = Math.max(factor, Math.floor(width / beta / factor) * factor);
  } else if (h * w < minPixels) {
    const beta = Math.sqrt(minPixels / (height * width));
    h = Math.ceil((height * beta) / factor) * factor;
    w = Math.ceil((width * beta) / factor) * factor;
  }
  return [h, w];
}

function qwenRule(
  family: string,
  patch: number,
  minPixels: number,
  maxPixels: number,
): VisionRule {
  const factor = patch * 2;
  const dim = 3 * 2 * patch * patch;
  return {
    family,
    rule: `${patch}-px patch · 2×2 merge → 1 token / ${factor}² px`,
    estimate(width, height) {
      const [h, w] = smartResize(height, width, factor, minPixels, maxPixels);
      const cols = w / factor;
      const rows = h / factor;
      return {
        positions: cols * rows + 2,
        cols,
        rows,
        tilesX: 1,
        tilesY: 1,
        crossAttention: false,
        shape: `pixel_values [${cols * rows * 4}, ${dim}]`,
      };
    },
  };
}

/** The tile grid (i × j ≤ max) whose aspect ratio is closest to the image's. */
function tileGrid(width: number, height: number, max: number): readonly [number, number] {
  const aspect = width / Math.max(1, height);
  let best: [number, number] = [1, 1];
  let bestDiff = Infinity;
  for (let i = 1; i <= max; i += 1) {
    for (let j = 1; i * j <= max; j += 1) {
      const diff = Math.abs(aspect - i / j);
      if (diff < bestDiff - 1e-9) {
        bestDiff = diff;
        best = [i, j];
      }
    }
  }
  return best;
}

const INTERNVL: VisionRule = {
  family: "InternVL3",
  rule: "448-px tiles (≤ 12 + thumbnail) · 256 tokens / tile",
  estimate(width, height) {
    const [tx, ty] = tileGrid(width, height, 12);
    const tiles = tx * ty + (tx * ty > 1 ? 1 : 0);
    return {
      positions: tiles * 256 + 2,
      cols: tx * 16,
      rows: ty * 16,
      tilesX: tx,
      tilesY: ty,
      crossAttention: false,
      shape: `pixel_values [${tiles}, 3, 448, 448]`,
    };
  },
};

const LLAMA_VISION: VisionRule = {
  family: "Llama 3.2",
  rule: "560-px tiles (≤ 4) · cross-attention · 1 <|image|> position",
  estimate(width, height) {
    const [tx, ty] = tileGrid(width, height, 4);
    return {
      positions: 1,
      cols: tx * 40,
      rows: ty * 40,
      tilesX: tx,
      tilesY: ty,
      crossAttention: true,
      shape: "pixel_values [1, 1, 4, 3, 560, 560]",
    };
  },
};

const GEMMA: VisionRule = {
  family: "Gemma 3",
  rule: "896² resize · 4×4 pool → 256 tokens / image",
  estimate() {
    return {
      positions: 258,
      cols: 16,
      rows: 16,
      tilesX: 1,
      tilesY: 1,
      crossAttention: false,
      shape: "pixel_values [1, 3, 896, 896]",
    };
  },
};

/** The image-token rule of the applied backbone's processor. */
export function visionRuleFor(backbone: Backbone): VisionRule {
  switch (backbone.family) {
    case "Qwen2.5-VL":
      return qwenRule("Qwen2.5-VL", 14, 3136, 12845056);
    case "InternVL3":
      return INTERNVL;
    case "Llama 3.2":
      return LLAMA_VISION;
    case "Gemma 3":
      return GEMMA;
    default:
      return qwenRule("Qwen3-VL", 16, 65536, 16777216);
  }
}

/** The P&ID crop window around a node, in sheet pixels — the same window the sample strip shows. */
export function pidCropWindow(node: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}) {
  const span = Math.max(node.width, node.height, 40) * 4.2;
  const width = span * 1.35;
  return { x: node.x - width / 2, y: node.y - span / 2, width, height: span };
}

// ── lanes ──────────────────────────────────────────────────────────────────────────────────

export interface Operation {
  readonly icon: IconName;
  readonly word: string;
}

export type TensorGlyph =
  | { readonly kind: "grid"; readonly vision: VisionEstimate | undefined }
  | { readonly kind: "strip"; readonly cells: number; readonly masked?: number }
  | { readonly kind: "graph"; readonly hops: readonly number[] }
  | { readonly kind: "points" }
  | { readonly kind: "series"; readonly channels: number }
  | { readonly kind: "pages"; readonly count: number }
  | { readonly kind: "group"; readonly group: number }
  | { readonly kind: "vocab" };

export interface Lane {
  readonly id: ModalityId;
  readonly name: string;
  /** Short mono identity of the source. */
  readonly source: string;
  readonly ops: readonly Operation[];
  readonly glyph: TensorGlyph;
  /** Symbolic shape, mono. */
  readonly shape: string;
  /** Sequence positions this lane contributes, when it contributes any. */
  readonly positions?: number;
  /** One-word reason when the modality is absent for this sample and stage. */
  readonly absent?: string;
}

export interface ConversionInput {
  readonly stage: StageId;
  readonly config: RunConfig;
  readonly profile: RunProfile;
  readonly sample: LabSample;
  readonly answer: GroundedAnswer | undefined;
  /** Natural size of the field image, once it has loaded. */
  readonly fieldSize: { readonly width: number; readonly height: number } | undefined;
}

const chat = (stage: StageId) => stage !== "pretraining";

/** Topology serialised as text, when no graph encoder is configured. */
export function topologyText(sample: LabSample): string {
  return sample.neighbours.map((n) => `${n.tag} (${n.hops} hop)`).join("; ");
}

/** Identity line every stage conditions on. */
export function identityText(sample: LabSample): string {
  return `${sample.tag} · ${sample.name}${sample.line ? ` · ${sample.line.number}` : ""}`;
}

export function fieldCropPixels(input: ConversionInput) {
  const { fieldSize, sample } = input;
  if (!fieldSize) return undefined;
  return {
    width: Math.max(1, (sample.box.width / 100) * fieldSize.width),
    height: Math.max(1, (sample.box.height / 100) * fieldSize.height),
  };
}

export function buildLanes(input: ConversionInput): readonly Lane[] {
  const { stage, config, profile, sample, answer } = input;
  const rule = visionRuleFor(profile.backbone);
  const crop = fieldCropPixels(input);
  const field = crop ? rule.estimate(crop.width, crop.height) : undefined;
  const positioned = sample.node.positioned !== false;
  const window = pidCropWindow(sample.node);
  const pid = positioned ? rule.estimate(window.width, window.height) : undefined;
  const graphOn = config.graph !== "none";
  const spatialOn = config.spatial !== "none";
  const channels = sample.evidence.timeSeries;
  const nodes = 1 + sample.joinedCount;

  const text = textPositions(input);
  const response = answer ? textTokens(answer.text) + (chat(stage) ? TURN_OVERHEAD : 0) : 0;

  const lanes: Lane[] = [
    {
      id: "vision",
      name: "vision",
      source: sample.annotationId,
      ops: [
        { icon: "file", word: "decode" },
        { icon: "target", word: "crop" },
        { icon: "zoomOut", word: "resize" },
        { icon: "table", word: "patchify" },
        { icon: "box", word: rule.estimate(1, 1).crossAttention ? "x-attn" : "merge" },
      ],
      glyph: { kind: "grid", vision: field },
      shape: field?.shape ?? "pixel_values [·]",
      positions: field?.positions,
    },
    {
      id: "drawing",
      name: "drawing",
      source: sample.nodeId,
      ops: [
        { icon: "search", word: "locate" },
        { icon: "canvas", word: "crop" },
        { icon: "zoomOut", word: "resize" },
        { icon: "table", word: "patchify" },
      ],
      glyph: { kind: "grid", vision: pid },
      shape: pid ? `${pid.shape} · bbox [4]` : "pixel_values [·]",
      positions: pid?.positions,
      absent: positioned ? undefined : "unpositioned",
    },
    graphOn
      ? {
          id: "topology",
          name: "topology",
          source: `${sample.joinedCount} reachable`,
          ops: [
            { icon: "graph", word: "subgraph" },
            { icon: "code", word: "reindex" },
            { icon: "model", word: "encode" },
            { icon: "arrow", word: "project" },
          ],
          glyph: { kind: "graph", hops: sample.neighbours.map((n) => n.hops) },
          shape: `x [${nodes}, F] · edge_index [2, E]`,
          positions: nodes,
          absent: sample.joinedCount === 0 ? "isolated" : undefined,
        }
      : {
          id: "topology",
          name: "topology",
          source: `${sample.neighbours.length} shown`,
          ops: [
            { icon: "code", word: "serialise" },
            { icon: "recipe", word: "tokenise" },
          ],
          glyph: { kind: "strip", cells: textTokens(topologyText(sample)) },
          shape: `input_ids [1, ${textTokens(topologyText(sample))}]`,
          positions: undefined,
        },
    {
      id: "spatial",
      name: "spatial",
      source: "twin preview",
      ops: [
        { icon: "cube", word: "sample" },
        { icon: "target", word: "align" },
        { icon: "model", word: "encode" },
      ],
      glyph: { kind: "points" },
      shape: "points [B, Np, 3] · valid [B, Np]",
      absent: spatialOn ? "unmeasured" : "disabled",
    },
    {
      id: "text",
      name: "text",
      source: sample.tag,
      ops: chat(stage)
        ? [
            { icon: "code", word: "template" },
            { icon: "recipe", word: "tokenise" },
            { icon: "flag", word: "roles" },
          ]
        : [
            { icon: "recipe", word: "tokenise" },
            { icon: "flag", word: "boundaries" },
          ],
      glyph: { kind: "strip", cells: text.prompt + response },
      shape: `input_ids [1, ${text.prompt + response}] · attention_mask [1, ${text.prompt + response}]`,
      positions: text.prompt + response,
    },
    {
      id: "telemetry",
      name: "telemetry",
      source: `${channels} ch`,
      ops: [
        { icon: "pulse", word: "align" },
        { icon: "chart", word: "window" },
        { icon: "shield", word: "mask" },
        { icon: "table", word: "patch" },
      ],
      glyph: { kind: "series", channels: Math.max(1, channels) },
      shape: `values [1, ${TELEMETRY_WINDOW}, ${channels}] · observed [1, ${TELEMETRY_WINDOW}, ${channels}]`,
      positions: channels > 0 ? channels * (TELEMETRY_WINDOW / TELEMETRY_PATCH) : undefined,
      absent: channels > 0 ? undefined : "none",
    },
    {
      id: "documents",
      name: "documents",
      source: `${sample.evidence.manuals} ref`,
      ops: [
        { icon: "search", word: "retrieve" },
        { icon: "book", word: "cite" },
        { icon: "recipe", word: "tokenise" },
      ],
      glyph: { kind: "pages", count: Math.max(1, sample.evidence.manuals) },
      shape: "passage_ids [P, Lp] · source_id [P]",
      absent: sample.evidence.manuals > 0 ? "unextracted" : "none",
    },
    targetLane(stage, response, text.prompt, profile),
  ];
  return lanes;
}

function targetLane(
  stage: StageId,
  response: number,
  prompt: number,
  profile: RunProfile,
): Lane {
  switch (stage) {
    case "pretraining":
      return {
        id: "target",
        name: "target",
        source: "paired evidence",
        ops: [
          { icon: "arrow", word: "shift" },
          { icon: "assets", word: "pair" },
          { icon: "shield", word: "mask" },
        ],
        glyph: { kind: "strip", cells: prompt + response },
        shape: "labels [1, L] · pairs [1, M]",
      };
    case "sft":
      return {
        id: "target",
        name: "target",
        source: "reviewed response",
        ops: [
          { icon: "arrow", word: "shift" },
          { icon: "shield", word: "−100" },
        ],
        glyph: { kind: "strip", cells: prompt + response, masked: prompt },
        shape: "labels [1, L] · ignore −100",
      };
    case "rl":
      return {
        id: "target",
        name: "target",
        source: "verifier",
        ops: [
          { icon: "play", word: `sample ×${GROUP_SIZE}` },
          { icon: "check", word: "verify" },
          { icon: "chart", word: "normalise" },
        ],
        glyph: { kind: "group", group: GROUP_SIZE },
        shape: `rewards [1, ${GROUP_SIZE}] · Â [1, ${GROUP_SIZE}]`,
      };
    case "distillation":
      return {
        id: "target",
        name: "target",
        source: "frozen teacher",
        ops: [
          { icon: "model", word: "teacher" },
          { icon: "chart", word: "softmax / T" },
          { icon: "arrow", word: "KL" },
        ],
        glyph: { kind: "vocab" },
        shape: `p_T [1, L, V] · ${profile.backbone.family} vocab`,
      };
  }
}

/** Text positions for the prompt side, and the stage's supervised response. */
export function textPositions(input: ConversionInput) {
  const { stage, config, sample, answer } = input;
  const topology = config.graph === "none" ? textTokens(topologyText(sample)) : 0;
  const identity = textTokens(identityText(sample));
  if (!chat(stage)) return { system: 0, prompt: identity + topology };
  const system = textTokens(SYSTEM_POLICY) + TURN_OVERHEAD;
  const instruction =
    textTokens(answer?.question ?? "") + identity + topology + TURN_OVERHEAD;
  return { system, instruction, prompt: system + instruction };
}

// ── packed sequence ────────────────────────────────────────────────────────────────────────

export type LossKind = "none" | "ntp" | "align" | "response" | "advantage" | "kd" | "kd+ce";
export type Segment = "sample" | "system" | "user" | "assistant" | "pad";

export interface Span {
  readonly id: string;
  readonly modality: ModalityId | "pad";
  readonly label: string;
  readonly tokens: number;
  readonly segment: Segment;
  readonly loss: LossKind;
}

/**
 * How each stage lays sequences out, from its runtime specification: pretraining and SFT pack
 * several samples into one fixed-length row (attention and position ids reset at each sample
 * boundary); RL and distillation run one sample per row, padded.
 */
export const PACKING: Record<
  StageId,
  { readonly packed: boolean; readonly length: number | undefined }
> = {
  pretraining: { packed: true, length: 4096 },
  sft: { packed: true, length: 3072 },
  rl: { packed: false, length: 9216 },
  distillation: { packed: false, length: undefined },
};

export interface PackedSequence {
  readonly spans: readonly Span[];
  /** Positions this sample's row occupies: used positions, plus padding when unpacked. */
  readonly total: number;
  /** Positions before padding. */
  readonly used: number;
  /** True while a span's count still depends on an image that has not loaded. */
  readonly pending: boolean;
}

/** Model input order for the selected sample, with each span's supervision for the stage. */
export function packSequence(
  input: ConversionInput,
  lanes: readonly Lane[],
): PackedSequence {
  const { stage, answer } = input;
  const lane = (id: ModalityId) => lanes.find((item) => item.id === id);
  const evidence: Span[] = [];
  const add = (id: ModalityId, label: string) => {
    const item = lane(id);
    if (!item || item.absent || item.positions === undefined || item.positions <= 0) return;
    evidence.push({
      id,
      modality: id,
      label,
      tokens: item.positions,
      segment: chat(stage) ? "user" : "sample",
      loss: "none",
    });
  };
  add("vision", "image");
  add("drawing", "p&id");
  add("topology", "graph");
  add("telemetry", "series");

  const text = textPositions(input);
  const response = answer ? textTokens(answer.text) + (chat(stage) ? TURN_OVERHEAD : 0) : 0;
  const spans: Span[] = [];

  if (!chat(stage)) {
    spans.push(...evidence.map((span) => ({ ...span, loss: "align" as const })));
    spans.push({
      id: "text",
      modality: "text",
      label: "text",
      tokens: text.prompt + response,
      segment: "sample",
      loss: "ntp",
    });
  } else {
    const promptLoss: LossKind = stage === "distillation" ? "kd" : "none";
    spans.push({
      id: "system",
      modality: "text",
      label: "system",
      tokens: text.system,
      segment: "system",
      loss: promptLoss,
    });
    spans.push(...evidence.map((span) => ({ ...span, loss: promptLoss })));
    spans.push({
      id: "instruction",
      modality: "text",
      label: "user",
      tokens: text.instruction ?? 0,
      segment: "user",
      loss: promptLoss,
    });
    spans.push({
      id: "response",
      modality: "target",
      label: stage === "rl" ? `completion ×${GROUP_SIZE}` : "assistant",
      tokens: response,
      segment: "assistant",
      loss: stage === "rl" ? "advantage" : stage === "distillation" ? "kd+ce" : "response",
    });
  }
  const used = spans.reduce((sum, span) => sum + span.tokens, 0);
  // A packed row is filled by the next samples, not by padding.
  const total = PACKING[stage].packed
    ? used
    : Math.max(PAD_MULTIPLE, Math.ceil(used / PAD_MULTIPLE) * PAD_MULTIPLE);
  if (total > used) {
    spans.push({
      id: "pad",
      modality: "pad",
      label: "pad",
      tokens: total - used,
      segment: "pad",
      loss: "none",
    });
  }
  const pending = lanes.some(
    (item) => item.glyph.kind === "grid" && !item.absent && item.positions === undefined,
  );
  return { spans: spans.filter((span) => span.tokens > 0), total, used, pending };
}

/** What carries supervision in each stage, as the loss-row legend states it. */
export const LOSS_KEY: Record<StageId, readonly LossKind[]> = {
  pretraining: ["ntp", "align"],
  sft: ["response"],
  rl: ["advantage"],
  distillation: ["kd", "kd+ce"],
};

export const LOSS_LABEL: Record<LossKind, string> = {
  none: "no loss",
  ntp: "next-token",
  align: "align / ground",
  response: "response CE",
  advantage: "Â · log π",
  kd: "KL(p_T ∥ p_S)",
  "kd+ce": "KL + CE",
};
