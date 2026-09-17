import type { CanvasDrawing, DrawingNode } from "@/lib/canvas/model";
import { isEquipment, objectClass } from "@/lib/canvas/taxonomy";

export type InvestigationPage = "evidence" | "investigation" | "brief";

export interface InvestigationSource {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly provenance: "corpus" | "generated" | "simulation";
}

export interface FusionAnnotationBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FusionAsset {
  readonly drawingIdentity?: {
    readonly status: string;
    readonly tag: string;
    readonly description: string;
    readonly referenceComparison: string;
    readonly sourceImageSha256: string;
    readonly reviewMethod: string;
  };
  readonly evidence?: {
    readonly image: {
      readonly sha256: string;
      readonly width: number;
      readonly height: number;
      readonly bytes: number;
      readonly assetRevision: string;
    };
    readonly registration: string;
    readonly graphClass: string;
    readonly equipmentSubtype: string;
    readonly plantIdentity: string;
    readonly imageBox: string;
    readonly captureTimestamp: string;
    readonly reviewer: string;
    readonly detector: string;
  };
  readonly annotationId: string;
  readonly node: DrawingNode;
  readonly expectedKind: string;
  readonly title: string;
  readonly fieldClass: string;
  readonly generatedImagePath: string;
  readonly annotationBox: FusionAnnotationBox;
  readonly neighbours: readonly string[];
  readonly incidentEdges: number;
  readonly provenance: "generated";
  readonly mappingStatus: "verified-node-and-class";
}

export interface FusionManifest {
  readonly validatedAt?: string;
  readonly graphDigest?: string;
  readonly mappingVersion: string;
  readonly source: string;
  readonly records: readonly FusionAsset[];
  readonly validation: {
    readonly status: "verified";
    readonly recordCount: number;
    readonly uniqueAnnotations: number;
    readonly uniqueNodes: number;
    readonly coordinateSource: "graphml";
    readonly identityPolicy: "registered-node-and-exact-class";
  };
}

export interface InvestigationModel {
  readonly title: string;
  readonly asset: DrawingNode;
  readonly assetName: string;
  readonly assetDescription: string;
  readonly drawing: CanvasDrawing;
  readonly sources: readonly InvestigationSource[];
  readonly neighbours: readonly string[];
  readonly incidentEdges: number;
  readonly classCount: number;
  readonly generatedImagePath: string;
  readonly trend: readonly number[];
  readonly fusionAssets: readonly FusionAsset[];
  readonly fusionMappingVersion: string;
  readonly fusionValidationStatus: "verified" | "unavailable";
}

const FUSION_ASSET_SPECS = [
  {
    nodeId: "tank67",
    expectedKind: "tank",
    annotationId: "ANN-001",
    title: "Primary separation vessel",
    fieldClass: "Vertical process separator",
    generatedImagePath: "/demo/fusion/asset-tank67-separator.png",
    annotationBox: { x: 38, y: 5, width: 27, height: 88 },
  },
  {
    nodeId: "tank70",
    expectedKind: "tank",
    annotationId: "ANN-002",
    title: "Utility knock-out drum",
    fieldClass: "Vertical process drum",
    generatedImagePath: "/demo/fusion/asset-tank70-knockout-drum.png",
    annotationBox: { x: 38, y: 5, width: 28, height: 88 },
  },
  {
    nodeId: "valve43",
    expectedKind: "valve",
    annotationId: "ANN-003",
    title: "Actuated control valve",
    fieldClass: "Pneumatic globe control valve",
    generatedImagePath: "/demo/fusion/asset-valve43-control-valve.png",
    annotationBox: { x: 29, y: 3, width: 45, height: 93 },
  },
  {
    nodeId: "valve38",
    expectedKind: "valve",
    annotationId: "ANN-004",
    title: "Manual isolation valve",
    fieldClass: "Handwheel gate valve",
    generatedImagePath: "/demo/fusion/asset-valve38-isolation-valve.png",
    annotationBox: { x: 29, y: 2, width: 42, height: 95 },
  },
  {
    nodeId: "instrumentation14",
    expectedKind: "instrumentation",
    annotationId: "ANN-005",
    title: "Pressure transmitter",
    fieldClass: "Electronic pressure transmitter",
    generatedImagePath: "/demo/fusion/asset-instrumentation14-pressure-transmitter.png",
    annotationBox: { x: 35, y: 9, width: 38, height: 76 },
  },
  {
    nodeId: "instrumentation15",
    expectedKind: "instrumentation",
    annotationId: "ANN-006",
    title: "Local pressure indication",
    fieldClass: "Analog pressure gauge",
    generatedImagePath: "/demo/fusion/asset-instrumentation15-pressure-gauge.png",
    annotationBox: { x: 39, y: 5, width: 28, height: 51 },
  },
  {
    nodeId: "instrumentation22",
    expectedKind: "instrumentation",
    annotationId: "ANN-007",
    title: "Differential pressure measurement",
    fieldClass: "Differential-pressure transmitter and manifold",
    generatedImagePath:
      "/demo/fusion/asset-instrumentation22-differential-pressure-transmitter.png",
    annotationBox: { x: 29, y: 4, width: 41, height: 76 },
  },
  {
    nodeId: "instrumentation25",
    expectedKind: "instrumentation",
    annotationId: "ANN-008",
    title: "Temperature measurement",
    fieldClass: "Head-mounted temperature transmitter",
    generatedImagePath: "/demo/fusion/asset-instrumentation25-temperature-transmitter.png",
    annotationBox: { x: 38, y: 7, width: 27, height: 72 },
  },
  {
    nodeId: "instrumentation31",
    expectedKind: "instrumentation",
    annotationId: "ANN-009",
    title: "Inline flow measurement",
    fieldClass: "Electromagnetic flow meter",
    generatedImagePath: "/demo/fusion/asset-instrumentation31-magnetic-flowmeter.png",
    annotationBox: { x: 24, y: 6, width: 53, height: 78 },
  },
  {
    nodeId: "instrumentation42",
    expectedKind: "instrumentation",
    annotationId: "ANN-010",
    title: "Vessel level measurement",
    fieldClass: "Radar level transmitter",
    generatedImagePath: "/demo/fusion/asset-instrumentation42-radar-level-transmitter.png",
    annotationBox: { x: 31, y: 6, width: 35, height: 75 },
  },
  {
    nodeId: "instrumentation60",
    expectedKind: "instrumentation",
    annotationId: "ANN-011",
    title: "Rotating-equipment condition monitoring",
    fieldClass: "Bearing vibration transmitter",
    generatedImagePath: "/demo/fusion/asset-instrumentation60-vibration-transmitter.png",
    annotationBox: { x: 43, y: 7, width: 17, height: 61 },
  },
  {
    nodeId: "instrumentation61",
    expectedKind: "instrumentation",
    annotationId: "ANN-012",
    title: "Pressure trip monitoring",
    fieldClass: "Weatherproof pressure switch",
    generatedImagePath: "/demo/fusion/asset-instrumentation61-pressure-switch.png",
    annotationBox: { x: 36, y: 12, width: 30, height: 65 },
  },
] as const;

/** The one drawing the field references were registered against. */
export const FUSION_DRAWING = "PID2Graph OPEN100/0.graphml";

export interface FieldReference {
  readonly annotationId: string;
  readonly nodeId: string;
  readonly title: string;
  readonly fieldClass: string;
  readonly generatedImagePath: string;
  readonly annotationBox: FusionAnnotationBox;
}

/**
 * The field references that apply to a drawing: none on any sheet but the registered one,
 * and on that sheet only those whose node exists with the drawn class the reference expects.
 * Never throws — a sheet without evidence simply has none.
 */
export function fieldReferencesFor(drawing: CanvasDrawing): readonly FieldReference[] {
  if (drawing.source !== FUSION_DRAWING) return [];
  const kindOf = new Map(drawing.nodes.map((node) => [node.id, node.kind]));
  return FUSION_ASSET_SPECS.filter(
    (spec) => kindOf.get(spec.nodeId) === spec.expectedKind,
  ).map((spec) => ({
    annotationId: spec.annotationId,
    nodeId: spec.nodeId,
    title: spec.title,
    fieldClass: spec.fieldClass,
    generatedImagePath: spec.generatedImagePath,
    annotationBox: spec.annotationBox,
  }));
}

/** Node id → reference class for the exercise register; never verified plant identity. */
export function fieldClassesFor(drawing: CanvasDrawing): ReadonlyMap<string, string> {
  return new Map(fieldReferencesFor(drawing).map((ref) => [ref.nodeId, ref.fieldClass]));
}

/** Build the bundled offline demonstration through the same one-to-one invariants. */
export function createDemoFusionManifest(drawing: CanvasDrawing): FusionManifest {
  const nodeById = new Map(drawing.nodes.map((node) => [node.id, node]));
  const neighboursByNode = new Map<string, Set<string>>();
  const incidentEdgesByNode = new Map<string, number>();
  for (const edge of drawing.edges) {
    const source = neighboursByNode.get(edge.source) ?? new Set<string>();
    source.add(edge.target);
    neighboursByNode.set(edge.source, source);
    const target = neighboursByNode.get(edge.target) ?? new Set<string>();
    target.add(edge.source);
    neighboursByNode.set(edge.target, target);
    incidentEdgesByNode.set(edge.source, (incidentEdgesByNode.get(edge.source) ?? 0) + 1);
    incidentEdgesByNode.set(edge.target, (incidentEdgesByNode.get(edge.target) ?? 0) + 1);
  }
  const records = FUSION_ASSET_SPECS.map((spec) => {
    const node = nodeById.get(spec.nodeId);
    if (!node) throw new Error(`Demo fusion node is missing: ${spec.nodeId}`);
    if (node.kind !== spec.expectedKind) {
      throw new Error(`Demo fusion class mismatch: ${spec.nodeId}`);
    }
    return {
      ...spec,
      node,
      neighbours: [...(neighboursByNode.get(node.id) ?? [])].sort(),
      incidentEdges: incidentEdgesByNode.get(node.id) ?? 0,
      provenance: "generated" as const,
      mappingStatus: "verified-node-and-class" as const,
    };
  });
  return {
    mappingVersion: "fusion-v2-demo",
    source: drawing.source,
    records,
    validation: {
      status: "verified",
      recordCount: records.length,
      uniqueAnnotations: new Set(records.map((record) => record.annotationId)).size,
      uniqueNodes: new Set(records.map((record) => record.node.id)).size,
      coordinateSource: "graphml",
      identityPolicy: "registered-node-and-exact-class",
    },
  };
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Validate the backend manifest against the independently loaded drawing, fail-closed. */
export function parseFusionManifest(
  value: unknown,
  drawing: CanvasDrawing,
): FusionManifest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Record<string, unknown>;
  if (
    typeof data.mappingVersion !== "string" ||
    !data.mappingVersion ||
    data.source !== drawing.source ||
    !Array.isArray(data.records) ||
    data.records.length !== FUSION_ASSET_SPECS.length ||
    data.records.length > 100 ||
    !data.validation ||
    typeof data.validation !== "object"
  )
    return undefined;

  const validation = data.validation as Record<string, unknown>;
  if (
    validation.status !== "verified" ||
    validation.recordCount !== data.records.length ||
    validation.coordinateSource !== "graphml" ||
    validation.identityPolicy !== "registered-node-and-exact-class"
  )
    return undefined;

  const nodeById = new Map(drawing.nodes.map((node) => [node.id, node]));
  const neighboursByNode = new Map<string, Set<string>>();
  const incidentEdgesByNode = new Map<string, number>();
  for (const edge of drawing.edges) {
    const source = neighboursByNode.get(edge.source) ?? new Set<string>();
    source.add(edge.target);
    neighboursByNode.set(edge.source, source);
    const target = neighboursByNode.get(edge.target) ?? new Set<string>();
    target.add(edge.source);
    neighboursByNode.set(edge.target, target);
    incidentEdgesByNode.set(edge.source, (incidentEdgesByNode.get(edge.source) ?? 0) + 1);
    incidentEdgesByNode.set(edge.target, (incidentEdgesByNode.get(edge.target) ?? 0) + 1);
  }

  const annotations = new Set<string>();
  const nodes = new Set<string>();
  const registry = new Map<string, (typeof FUSION_ASSET_SPECS)[number]>(
    FUSION_ASSET_SPECS.map((spec) => [spec.annotationId, spec]),
  );
  for (const raw of data.records) {
    if (!raw || typeof raw !== "object") return undefined;
    const record = raw as Record<string, unknown>;
    const node = record.node as Record<string, unknown> | undefined;
    const box = record.annotationBox as Record<string, unknown> | undefined;
    if (
      typeof record.annotationId !== "string" ||
      !record.annotationId ||
      annotations.has(record.annotationId) ||
      !node ||
      typeof node.id !== "string" ||
      nodes.has(node.id) ||
      typeof record.expectedKind !== "string" ||
      record.expectedKind !== node.kind ||
      typeof record.title !== "string" ||
      typeof record.fieldClass !== "string" ||
      typeof record.generatedImagePath !== "string" ||
      !record.generatedImagePath.startsWith("/demo/fusion/") ||
      record.provenance !== "generated" ||
      record.mappingStatus !== "verified-node-and-class" ||
      !box ||
      ![box.x, box.y, box.width, box.height].every(finiteNumber) ||
      (box.x as number) < 0 ||
      (box.y as number) < 0 ||
      (box.width as number) <= 0 ||
      (box.height as number) <= 0 ||
      (box.x as number) + (box.width as number) > 100 ||
      (box.y as number) + (box.height as number) > 100 ||
      !Array.isArray(record.neighbours) ||
      !record.neighbours.every((id) => typeof id === "string") ||
      !Number.isSafeInteger(record.incidentEdges)
    )
      return undefined;

    const sourceNode = nodeById.get(node.id);
    const registered = registry.get(record.annotationId);
    if (
      !registered ||
      registered.nodeId !== node.id ||
      registered.generatedImagePath !== record.generatedImagePath ||
      registered.expectedKind !== record.expectedKind ||
      registered.annotationBox.x !== box.x ||
      registered.annotationBox.y !== box.y ||
      registered.annotationBox.width !== box.width ||
      registered.annotationBox.height !== box.height
    )
      return undefined;
    if (record.evidence !== undefined) {
      const evidence = record.evidence as FusionAsset["evidence"];
      if (
        !evidence ||
        !evidence.image ||
        !/^[a-f0-9]{64}$/.test(evidence.image.sha256) ||
        !Number.isSafeInteger(evidence.image.width) ||
        !Number.isSafeInteger(evidence.image.height) ||
        evidence.image.width <= 0 ||
        evidence.image.height <= 0 ||
        evidence.image.width * evidence.image.height > 24_000_000 ||
        evidence.plantIdentity !== "unverified" ||
        evidence.equipmentSubtype !== "unverified"
      )
        return undefined;
    }
    if (
      !sourceNode ||
      sourceNode.kind !== node.kind ||
      sourceNode.x !== node.x ||
      sourceNode.y !== node.y ||
      sourceNode.width !== node.width ||
      sourceNode.height !== node.height ||
      sourceNode.positioned !== node.positioned
    )
      return undefined;
    const expectedNeighbours = [...(neighboursByNode.get(node.id) ?? [])].sort();
    const receivedNeighbours = [...record.neighbours].sort();
    if (
      expectedNeighbours.length !== receivedNeighbours.length ||
      expectedNeighbours.some((id, index) => id !== receivedNeighbours[index]) ||
      record.incidentEdges !== (incidentEdgesByNode.get(node.id) ?? 0)
    )
      return undefined;
    annotations.add(record.annotationId);
    nodes.add(node.id);
  }
  if (
    validation.uniqueAnnotations !== annotations.size ||
    validation.uniqueNodes !== nodes.size ||
    annotations.size !== data.records.length ||
    nodes.size !== data.records.length
  )
    return undefined;
  return value as FusionManifest;
}

/**
 * Derive one linked investigation from source geometry in O(V + E).
 *
 * A vessel, tank, or pump is preferred because it maps naturally to field inspection
 * imagery. If none exists, the first extracted equipment item is used; the source node is
 * always retained so a visual card can be traced back to the GraphML.
 */
export function createInvestigationModel(
  drawing: CanvasDrawing,
  fusionManifest?: FusionManifest,
): InvestigationModel {
  const equipment = drawing.nodes.filter((node) => isEquipment(node.kind));
  const neighboursByNode = new Map<string, Set<string>>();
  const incidentEdgesByNode = new Map<string, number>();
  for (const edge of drawing.edges) {
    const source = neighboursByNode.get(edge.source) ?? new Set<string>();
    source.add(edge.target);
    neighboursByNode.set(edge.source, source);
    const target = neighboursByNode.get(edge.target) ?? new Set<string>();
    target.add(edge.source);
    neighboursByNode.set(edge.target, target);
    incidentEdgesByNode.set(edge.source, (incidentEdgesByNode.get(edge.source) ?? 0) + 1);
    incidentEdgesByNode.set(edge.target, (incidentEdgesByNode.get(edge.target) ?? 0) + 1);
  }

  const fusionAssets = [...(fusionManifest?.records ?? [])];

  const fallbackAsset =
    equipment.find((node) => node.kind === "tank") ??
    equipment.find((node) => node.kind === "pump") ??
    equipment[0] ??
    drawing.nodes[0]!;
  const asset = fusionAssets[0]?.node ?? fallbackAsset;
  const neighbours = neighboursByNode.get(asset.id) ?? new Set<string>();
  const incidentEdges = incidentEdgesByNode.get(asset.id) ?? 0;

  const classes = new Set(drawing.nodes.map((node) => node.kind));
  const type = objectClass(asset.kind);

  return {
    title: `Linked investigation / ${asset.id}`,
    asset,
    assetName: type.name,
    assetDescription: type.description,
    drawing,
    sources: [
      {
        id: "drawing",
        title: "P&ID drawing raster",
        path: drawing.imagePath,
        provenance: "corpus",
      },
      {
        id: "topology",
        title: "Extracted topology",
        path: drawing.source,
        provenance: "corpus",
      },
      {
        id: "field-visual",
        title: "Twelve-asset field-reference set",
        path: "/demo/fusion",
        provenance: "generated",
      },
      {
        id: "scenario",
        title: "Inspection scenario",
        path: "SIM-INSPECTION-001",
        provenance: "simulation",
      },
    ],
    neighbours: [...neighbours],
    incidentEdges,
    classCount: classes.size,
    generatedImagePath:
      fusionAssets[0]?.generatedImagePath ?? "/demo/heat-exchanger-inspection.png",
    trend: [62, 64, 63, 66, 61, 60, 62, 68, 72, 70, 73, 76],
    fusionAssets,
    fusionMappingVersion: fusionManifest?.mappingVersion ?? "unavailable",
    fusionValidationStatus: fusionManifest?.validation.status ?? "unavailable",
  };
}
