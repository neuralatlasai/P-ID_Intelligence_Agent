"use client";

import Link from "next/link";
import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  FollowUpComposer,
  type ComposerHandle,
} from "@/components/conversation/FollowUpComposer";
import { ConversationViewport } from "@/components/conversation/ConversationViewport";
import {
  CheckIcon,
  ChevronRightIcon,
  CubeIcon,
  DocumentIcon,
  GraphIcon,
  ImageIcon,
  PanelRightIcon,
  ProductMark,
  RefreshIcon,
  SearchIcon,
  SessionIcon,
  SettingsIcon,
} from "@/components/ui/icons";
import { useAgentStream } from "@/hooks/useAgentStream";
import { useSessionHistory, useBackendHealth, type HealthStatus } from "@/hooks/useSession";
import {
  buildAdjacency,
  equipmentNeighbours,
  traceConnections,
  type CanvasDrawing,
  type DrawingNode,
} from "@/lib/canvas/model";
import {
  buildCanvasAssistantContext,
  withWorkspaceContext,
  type CanvasAssistantContext,
} from "@/lib/canvas/assistant-context";
import { displayName, isEquipment, lineStyle, objectClass } from "@/lib/canvas/taxonomy";
import {
  assignTags,
  parseTagSweep,
  regionAround,
  tagRegionContext,
  tagSweepQuestion,
  type TagAssignment,
} from "@/lib/canvas/tags";
import { buildPlantRegister, type AssetDocument } from "@/lib/canvas/engineering";
import { DocumentViewer } from "@/components/canvas/DocumentViewer";
import { ConnectedResponse } from "@/components/canvas/ConnectedResponse";
import { TelemetryPanel } from "@/components/canvas/TelemetryPanel";
import { HEAT_EXCHANGER_SCENE, resolveAnchor } from "@/lib/twin/scene";
import { groupCounts, groupOf, GROUPS } from "@/lib/canvas/groups";
import { fieldClassesFor } from "@/lib/investigation/model";
import { DigitalTwinView } from "@/components/twin/DigitalTwinView";
import {
  AssetPopover,
  FailureModes,
  FilesPanel,
  HierarchyPanel,
  SimulatedBadge,
  StatusChip,
  SummaryPanel,
  WorkOrdersPanel,
} from "./AssetPanels";
import { DrawingSurface } from "./DrawingSurface";
import { describeConnections } from "./SelectionCard";
import styles from "./IndustrialWorkspace.module.css";

/** Drawing classes named by what they are on a P&ID, for the marker legend. */
const LEGEND_NAMES: Record<string, string> = {
  instrumentation: "Instruments (ISA-5.1)",
  valve: "Valves",
  "inlet/outlet": "Off-page connectors",
  tank: "Vessels & exchangers",
  pump: "Pumps",
};

type WorkspaceView = "Canvas" | "Assets" | "Files" | "Simulation" | "Twin";

/** The same three states as a row marker inside the data-connection list. */
function connectionDotClass(status: HealthStatus): string | undefined {
  switch (status) {
    case "ready":
      return styles.live;
    case "degraded":
      return styles.warnState;
    case "down":
      return styles.badState;
    default:
      return undefined;
  }
}

/**
 * The drawing workbench.
 *
 * Geometry, connectivity and object classes come from the corpus GraphML and its matching
 * raster; every number on this screen is one of those, counted. The two things the source
 * does not contain — plant tags and live plant data — are named as missing rather than
 * filled in, and the tag question is handed to the agent, which can read the drawing.
 */
export function IndustrialWorkspace({
  sessionId,
  drawing,
  sourceMode,
  catalogControl,
  onReconnect,
  initialNode,
  initialView,
}: {
  readonly sessionId: string;
  readonly drawing: CanvasDrawing;
  readonly sourceMode: "backend" | "demo";
  readonly catalogControl: ReactNode;
  readonly onReconnect: () => void;
  /** A component to open on, from a deep link; ignored when the sheet does not have it. */
  readonly initialNode?: string | undefined;
  readonly initialView?: string | undefined;
}) {
  const equipment = useMemo(
    () => drawing.nodes.filter((node) => isEquipment(node.kind)),
    [drawing],
  );
  const nodeById = useMemo(
    () => new Map(drawing.nodes.map((node) => [node.id, node])),
    [drawing],
  );
  const adjacency = useMemo(
    () => buildAdjacency(drawing.nodes, drawing.edges, drawing.directed),
    [drawing],
  );
  /**
   * The plant register: an ISA-5.1 tag, name, loop, line and history for every symbol.
   * Deterministic per sheet, and simulated beyond the topology it is built on.
   */
  const twinAnchor = useMemo(
    () => resolveAnchor(HEAT_EXCHANGER_SCENE, drawing, adjacency),
    [drawing, adjacency],
  );
  /** The anchor is evidence only when the scene names it; a best guess stays a vessel. */
  const twinConfirmed =
    twinAnchor !== undefined && HEAT_EXCHANGER_SCENE.preferredAnchors.includes(twinAnchor);
  const plant = useMemo(
    () =>
      buildPlantRegister(
        drawing,
        adjacency,
        undefined,
        twinConfirmed && twinAnchor ? new Set([twinAnchor]) : new Set(),
        fieldClassesFor(drawing),
      ),
    [drawing, adjacency, twinAnchor, twinConfirmed],
  );

  /** How many objects of each class the sheet carries, most numerous first. */
  const classCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of drawing.nodes) {
      counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([label, count]) => ({ type: objectClass(label), count }))
      .sort((a, b) => b.count - a.count);
  }, [drawing]);

  const health = useBackendHealth();
  const imageUrl =
    sourceMode === "backend"
      ? `/api/canvas/image/${encodeURIComponent(drawing.imagePath)}`
      : "/demo/main-steam.png";
  const graphUrl =
    sourceMode === "backend"
      ? `/api/canvas/graph/${encodeURIComponent(drawing.source)}`
      : "/demo/main-steam.graphml";
  const sheet = drawing.imagePath.split("/").at(-1) ?? drawing.imagePath;
  const folder = drawing.source.split("/").slice(0, -1).join("/") || "Corpus root";

  const [view, setView] = useState<WorkspaceView>(
    () =>
      (["Canvas", "Assets", "Files", "Simulation", "Twin"] as const).find(
        (name) => name === initialView,
      ) ?? "Canvas",
  );
  const [selected, setSelected] = useState(() =>
    initialNode && nodeById.has(initialNode)
      ? initialNode
      : (equipment[0]?.id ?? drawing.nodes[0]!.id),
  );
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(100);
  const [tags, setTags] = useState(true);
  const [connections, setConnections] = useState(false);
  const [showCard, setShowCard] = useState(true);
  const [running, setRunning] = useState(false);
  const [step, setStep] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [agentTab, setAgentTab] = useState<"Overview" | "Assistant">("Overview");
  const [tagsByNode, setTagsByNode] = useState<ReadonlyMap<string, TagAssignment>>(
    new Map(),
  );
  /** Restrict the object list to one class, or show all equipment when null. */
  const [classFilter, setClassFilter] = useState<string | null>(null);
  /** Functional groups on this sheet, for the browser filter. */
  const functionCounts = useMemo(() => groupCounts(drawing.nodes, plant), [drawing, plant]);
  /** Classes switched off in the legend; their markers are not drawn. */
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  /** The document open in the viewer, for the selected asset. */
  const [openDocument, setOpenDocument] = useState<AssetDocument>();
  const composer = useRef<ComposerHandle>(null);
  const ask = useRef<(text: string, extra?: readonly string[]) => void>(null);

  /**
   * What to call an object.
   *
   * The printed tag once the agent has read one, the class and ordinal until then. There is
   * no third state: an object is either named by the drawing or described by its class.
   */
  const label = (node: DrawingNode): string =>
    tagsByNode.get(node.id)?.tag ??
    plant.assets.get(node.id)?.tag ??
    // Pipework is named by the line it belongs to, which is what an engineer calls it.
    plant.lines.get(plant.linesByNode.get(node.id)?.[0] ?? "")?.number ??
    displayName(node.id, node.kind);

  /** What the component is, in engineering terms. */
  const nameOf = (node: DrawingNode): string =>
    plant.assets.get(node.id)?.name ??
    (plant.linesByNode.has(node.id)
      ? `Pipe run · ${objectClass(node.kind).name}`
      : objectClass(node.kind).name);

  /** Take the tags out of an answer and attach them to the objects they sit on. */
  const absorbTags = (answer: string): number => {
    const read = parseTagSweep(answer, drawing.width, drawing.height);
    if (!read.length) return 0;
    const placed = assignTags(drawing.nodes, read);
    setTagsByNode(placed);
    return placed.size;
  };

  const connected = useMemo(
    () => traceConnections(adjacency, selected),
    [adjacency, selected],
  );
  const maxStep = useMemo(() => Math.max(0, ...connected.values()), [connected]);
  const selectedNode = nodeById.get(selected)!;
  const selectedType = objectClass(selectedNode.kind);
  const neighbors = adjacency.get(selected) ?? [];
  /**
   * The equipment the selection actually joins to.
   *
   * Raw adjacency answers "Line connector 216", because that is what the draughtsman drew
   * between two valves. This answers the question an engineer asked.
   */
  const joined = useMemo(
    () =>
      equipmentNeighbours(
        adjacency,
        (id) => isEquipment(nodeById.get(id)?.kind ?? ""),
        selected,
      ),
    [adjacency, nodeById, selected],
  );

  /** Line styles on the selected object's own edges, counted from the source. */
  const breakdown = useMemo(() => {
    let solid = 0;
    let dashed = 0;
    let unstyled = 0;
    for (const edge of drawing.edges) {
      if (edge.source !== selected && edge.target !== selected) continue;
      if (edge.style === "solid") solid += 1;
      else if (edge.style === "non-solid") dashed += 1;
      else unstyled += 1;
    }
    return { total: solid + dashed + unstyled, solid, dashed, unstyled };
  }, [drawing, selected]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) {
      return classFilter
        ? drawing.nodes.filter((node) => groupOf(node, plant).id === classFilter)
        : equipment;
    }
    // Search covers the identifier and the class under both its source label and its
    // engineering name, so "instrument", "instrumentation" and "INST" find the same rows.
    return drawing.nodes.filter((node) => {
      const type = objectClass(node.kind);
      const asset = plant.assets.get(node.id);
      const tag = `${tagsByNode.get(node.id)?.tag ?? ""} ${asset?.tag ?? ""} ${asset?.name ?? ""}`;
      return `${tag} ${node.id} ${node.kind} ${type.name} ${type.abbreviation}`
        .toLowerCase()
        .includes(term);
    });
  }, [query, drawing, equipment, tagsByNode, classFilter, plant]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      setStep((value) => Math.min(maxStep, value + 1));
    }, 1000 / speed);
    return () => window.clearInterval(timer);
  }, [running, speed, maxStep]);

  const select = (id: string) => {
    setSelected(id);
    setOpenDocument(undefined);
    setStep(0);
    setShowCard(true);
  };

  /** Put a question in the composer. The engineer presses send, not the app. */
  const draft = (text: string) => {
    setAgentTab("Assistant");
    // The panel is hidden until the tab switches, so the draft waits for the next frame.
    requestAnimationFrame(() => composer.current?.setDraft(text));
  };

  /**
   * Send a request the workspace composed on the reader's behalf.
   *
   * The engineer clicked a button whose label already said what it does, so the request
   * goes straight out rather than sitting in the composer waiting for a second click. It
   * is one readable sentence, and it is exactly what the backend persists, so the
   * transcript afterwards says the same thing it said while the run was live.
   */
  const send = (text: string, extra: readonly string[] = []) => {
    setAgentTab("Assistant");
    requestAnimationFrame(() => ask.current?.(text, extra));
  };

  /**
   * Ask about a component by what it is, not where it is drawn.
   *
   * The question an engineer means is "what does FCV-1012 do, what is it tied to, how could
   * it fail" — so that is the question sent. Positions stay in the hidden context, where
   * the tools can use them and the answer is not tempted to repeat them.
   */
  const askAbout = (node: DrawingNode) => {
    const asset = plant.assets.get(node.id);
    const lineId = plant.linesByNode.get(node.id)?.[0];
    const line = lineId ? plant.lines.get(lineId) : undefined;
    if (!asset && line) {
      draft(
        `Describe line ${line.number}: the ${line.service.name.toLowerCase()} service it carries, the ${line.assets.length} components on it, how they are arranged, and what failure on this line would affect.`,
      );
      return;
    }
    const subject = `${label(node)} (${nameOf(node)})`;
    draft(
      `Explain ${subject}${line ? ` on line ${line.number}` : ""}: what it does in this system, every component it is connected to, the ways it is most likely to fail and what each would affect, and what its operating trend should look like.`,
    );
  };

  const namedCount = tagsByNode.size;
  const selectedAsset = plant.assets.get(selected);
  const selectedLine = plant.lines.get(plant.linesByNode.get(selected)?.[0] ?? "");
  /** The instrument whose trend stands in for a component that has no measurement of its own. */
  const measuringAsset = useMemo(() => {
    if (selectedAsset?.telemetry) return selectedAsset;
    if (selectedAsset?.loop) {
      const partner = [...plant.assets.values()].find(
        (a) => a.loop === selectedAsset.loop && a.telemetry,
      );
      if (partner) return partner;
    }
    for (const { id } of joined) {
      const candidate = plant.assets.get(id);
      if (candidate?.category === "instrument") return candidate;
    }
    return undefined;
  }, [selectedAsset, plant, joined]);
  const semanticContext = useMemo(
    () => ({
      hierarchy: `${plant.site} > ${plant.area} > ${plant.unit} > ${plant.system} > ${sheet}`,
      ...(selectedAsset
        ? {
            asset: {
              tag: tagsByNode.get(selected)?.tag ?? selectedAsset.tag,
              name: selectedAsset.name,
              description: selectedAsset.description,
              status: selectedAsset.status,
              ...(selectedAsset.loop ? { loop: selectedAsset.loop } : {}),
              ...(() => {
                const partner = selectedAsset.loop
                  ? [...plant.assets.values()].find(
                      (a) => a.loop === selectedAsset.loop && a.tag !== selectedAsset.tag,
                    )
                  : undefined;
                return partner ? { loopPartner: `${partner.tag} ${partner.name}` } : {};
              })(),
              lines: selectedAsset.lines.map((id) => plant.lines.get(id)?.number ?? id),
              joined: joined.map(({ id, hops }) => ({
                tag: plant.assets.get(id)?.tag ?? id,
                name:
                  plant.assets.get(id)?.name ??
                  objectClass(nodeById.get(id)?.kind ?? "").name,
                hops,
              })),
              failureModes: selectedAsset.failureModes.map((f) => `${f.code} ${f.name}`),
            },
          }
        : {}),
      ...(!selectedAsset && selectedLine
        ? {
            line: {
              number: selectedLine.number,
              assets: selectedLine.assets.map((id) => plant.assets.get(id)?.tag ?? id),
            },
          }
        : {}),
    }),
    [plant, sheet, selectedAsset, selectedLine, selected, tagsByNode, joined, nodeById],
  );
  const assistantContext = useMemo(
    () =>
      buildCanvasAssistantContext(
        drawing,
        selectedNode,
        tagsByNode.get(selectedNode.id)?.tag,
        semanticContext,
      ),
    [drawing, selectedNode, tagsByNode, semanticContext],
  );

  /** Read the tags around whatever is selected, and fold them into the workspace. */
  const readTags = () => {
    const region = regionAround(
      selectedNode.x,
      selectedNode.y,
      drawing.width,
      drawing.height,
    );
    send(
      tagSweepQuestion(label(selectedNode), sheet),
      tagRegionContext(drawing.imagePath, drawing.source, region),
    );
  };

  const trace = () => {
    setConnections(true);
    setRunning(false);
    setStep(maxStep);
  };

  /** The floating palette and zoom pill that sit over the stage. */
  const stageTools = (
    <>
      <div className={styles.palette} role="group" aria-label="Drawing layers">
        <button
          aria-pressed={tags}
          onClick={() => setTags((value) => !value)}
          title="Show equipment and instrument markers"
        >
          <ImageIcon size={18} />
          <span>Equipment</span>
        </button>
        <button
          aria-pressed={connections}
          onClick={() => setConnections((value) => !value)}
          title="Show connections from the topology graph"
        >
          <GraphIcon size={18} />
          <span>Lines</span>
        </button>
        <button
          aria-pressed={showCard}
          onClick={() => setShowCard((value) => !value)}
          title="Show the detail card for the selected object"
        >
          <PanelRightIcon size={18} />
          <span>Detail</span>
        </button>
        <hr />
        <button onClick={readTags} title="Read the printed tags off this drawing">
          <SearchIcon size={18} />
          <span>Tags</span>
        </button>
        <button onClick={() => askAbout(selectedNode)} title="Ask the agent">
          <ProductMark size={18} />
          <span>Ask</span>
        </button>
      </div>

      <div className={styles.zoomPill} role="group" aria-label="Zoom">
        <button
          aria-label="Zoom out"
          disabled={zoom <= 50}
          onClick={() => setZoom((value) => Math.max(50, value - 25))}
        >
          −
        </button>
        <output aria-label="Zoom level">{zoom}%</output>
        <button
          aria-label="Zoom in"
          disabled={zoom >= 300}
          onClick={() => setZoom((value) => Math.min(300, value + 25))}
        >
          +
        </button>
        <button onClick={() => setZoom(100)} title="Fit the sheet to the stage width">
          Fit
        </button>
      </div>
    </>
  );

  return (
    <div className={styles.workspace}>
      <a className="skipLink" href="#canvas-main">
        Skip to drawing workspace
      </a>

      <aside className={styles.navigation} aria-label="Workspace navigation">
        <ProductMark size={30} />
        {(
          [
            ["Canvas", ImageIcon],
            ["Assets", GraphIcon],
            ["Files", DocumentIcon],
            ["Simulation", SettingsIcon],
            ["Twin", CubeIcon],
          ] as const
        ).map(([name, Icon]) => (
          <button
            key={name}
            onClick={() => setView(name)}
            aria-current={view === name ? "page" : undefined}
          >
            <Icon size={21} />
            <span>{name}</span>
          </button>
        ))}
        <Link href="/model-lab/pretraining">
          <CubeIcon size={21} />
          <span>Model Lab</span>
        </Link>
        <Link href={`/investigation?session=${sessionId}`}>
          <GraphIcon size={21} />
          <span>Evidence</span>
        </Link>
        <Link href="/">
          <SessionIcon size={21} />
          <span>Sessions</span>
        </Link>
        <div className={styles.navFooter}>
          P&ID
          <br />
          Workspace
        </div>
      </aside>

      <header className={styles.topbar}>
        <div className={styles.brand}>
          Industrial Canvas <span>P&ID Intelligence</span>
        </div>
        <label className={styles.search}>
          <SearchIcon />
          <span className="srOnly">Search objects</span>
          <input
            value={query}
            maxLength={120}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by class, name or source id…"
          />
        </label>
        <span className={styles.badge}>
          {sourceMode === "backend" ? "Backend corpus" : "Offline demonstration"}
        </span>
      </header>

      <main id="canvas-main" className={styles.main} data-view={view}>
        <aside className={styles.inputs}>
          <div className={styles.sectionHeading}>
            <h2>Agent inputs</h2>
            <span>2 sources</span>
          </div>
          <div className={styles.sources}>
            <button onClick={() => setView("Canvas")} title="Open the drawing">
              <DocumentIcon size={15} />
              <span>
                <strong>{sheet}</strong>
                <small>
                  Raster · {drawing.width} × {drawing.height} px
                </small>
              </span>
              <CheckIcon size={12} />
            </button>
            <button onClick={() => setView("Assets")} title="Browse the topology">
              <GraphIcon size={15} />
              <span>
                <strong>GraphML topology</strong>
                <small>
                  {drawing.nodes.length} nodes · {drawing.edges.length} edges ·{" "}
                  {drawing.directed ? "directed" : "undirected"}
                </small>
              </span>
              <CheckIcon size={12} />
            </button>
          </div>

          <div className={styles.sectionHeading}>
            <h2>Filter by function</h2>
            <span>ISA-5.1</span>
          </div>
          {/* Each chip filters the list below it. A count nobody can act on is decoration. */}
          <div className={styles.classList} role="group" aria-label="Filter by function">
            {functionCounts.map(({ group, count }) => (
              <button
                key={group.id}
                aria-pressed={classFilter === group.id}
                title={`${count} ${group.name.toLowerCase()} — click to ${classFilter === group.id ? "clear the filter" : "filter"}`}
                onClick={() =>
                  setClassFilter((current) => (current === group.id ? null : group.id))
                }
              >
                <i style={{ background: group.colour }} aria-hidden="true" />
                <span>{group.short}</span>
                <b>{count}</b>
              </button>
            ))}
          </div>

          <div className={styles.sectionHeading}>
            <h2>
              {query
                ? "Search results"
                : classFilter
                  ? (GROUPS.find((group) => group.id === classFilter)?.name ?? "Filtered")
                  : "Equipment & instruments"}
            </h2>
            {classFilter && !query ? (
              <button className={styles.clearFilter} onClick={() => setClassFilter(null)}>
                {filtered.length} · clear
              </button>
            ) : (
              <span>{filtered.length}</span>
            )}
          </div>
          <div className={styles.objectList} aria-label="Drawing objects">
            {filtered.map((node) => {
              const group = groupOf(node, plant);
              const asset = plant.assets.get(node.id);
              const isSelected = node.id === selected;
              const line = plant.lines.get(plant.linesByNode.get(node.id)?.[0] ?? "");
              return (
                <div key={node.id} className={styles.objectRow}>
                  <button
                    aria-pressed={isSelected}
                    onClick={() => select(node.id)}
                    title={`${label(node)} · source node ${node.id}`}
                  >
                    <i style={{ background: group.colour }} aria-hidden="true" />
                    <span>
                      <strong>{label(node)}</strong>
                      <small>{nameOf(node)}</small>
                    </span>
                    <em>{group.code}</em>
                  </button>
                  {isSelected && (
                    <div className={styles.objectDetail}>
                      {asset && <StatusChip value={asset.status} />}
                      <dl>
                        {line && (
                          <div>
                            <dt>Line</dt>
                            <dd>{line.number}</dd>
                          </div>
                        )}
                        {asset?.loop && (
                          <div>
                            <dt>Loop</dt>
                            <dd>{asset.loop}</dd>
                          </div>
                        )}
                        <div>
                          <dt>Connected</dt>
                          <dd>
                            {joined.length}{" "}
                            {joined.length === 1 ? "component" : "components"}
                          </dd>
                        </div>
                      </dl>
                      <div className={styles.objectActions}>
                        <button
                          onClick={() => {
                            setShowCard(true);
                            setView("Canvas");
                          }}
                        >
                          Show
                        </button>
                        <button onClick={() => askAbout(node)}>Ask agent</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {!filtered.length && (
              <div className={styles.empty}>
                <strong>No matching objects</strong>
                <p>Try a tag such as “PIT”, or a function such as “control valve”.</p>
              </div>
            )}
          </div>
        </aside>

        <section className={styles.center} aria-label={`${view} workspace`}>
          <div className={styles.documentBar}>
            <DocumentIcon />
            <div>
              <h1>{sheet}</h1>
              <p>{folder}</p>
            </div>
            <span className={`${styles.badge} ${styles.indexed}`}>
              Indexed · {equipment.length} equipment
            </span>
            <button onClick={onReconnect}>Refresh source</button>
          </div>

          <div className={styles.ready} hidden={view === "Twin"}>
            <CheckIcon size={22} />
            <div>
              <strong>
                {sourceMode === "backend"
                  ? "Drawing parsed and indexed"
                  : "Offline source fixture"}
              </strong>
              <p>
                {drawing.nodes.length} objects · {drawing.edges.length} connections.{" "}
                {namedCount > 0
                  ? `Objects classified, connectivity reconstructed, and ${namedCount} plant tags read from the drawing.`
                  : "Objects classified and connectivity reconstructed. Read the printed tags to name them."}
              </p>
            </div>
            {namedCount === 0 && (
              <button className={styles.primary} onClick={readTags}>
                Read tags from drawing
              </button>
            )}
            <dl className={styles.readyStats}>
              <div>
                <dt>Objects</dt>
                <dd>{drawing.nodes.length}</dd>
              </div>
              <div>
                <dt>Equipment</dt>
                <dd>{equipment.length}</dd>
              </div>
              <div>
                <dt>Connections</dt>
                <dd>{drawing.edges.length}</dd>
              </div>
            </dl>
          </div>

          {view === "Canvas" && (
            <>
              {/* A key you can switch: each entry hides or shows that class on the sheet. */}
              <div className={styles.legend} role="group" aria-label="Marker classes">
                {classCounts
                  .filter(({ type }) => type.equipment)
                  .map(({ type, count }) => (
                    <button
                      key={type.label}
                      aria-pressed={!hidden.has(type.label)}
                      title={`${count} on this drawing — click to ${hidden.has(type.label) ? "show" : "hide"}`}
                      onClick={() =>
                        setHidden((current) => {
                          const next = new Set(current);
                          if (!next.delete(type.label)) next.add(type.label);
                          return next;
                        })
                      }
                    >
                      <i
                        style={{ "--swatch": type.colour } as CSSProperties}
                        aria-hidden="true"
                      />
                      {LEGEND_NAMES[type.label] ?? type.name}
                    </button>
                  ))}
                <span className={styles.legendSelected}>
                  <i
                    style={{ "--swatch": "#b8320c" } as CSSProperties}
                    aria-hidden="true"
                  />
                  Selected
                </span>
              </div>

              <DrawingSurface
                drawing={drawing}
                imageUrl={imageUrl}
                selected={selected}
                connected={connected}
                showConnections={connections}
                showTags={tags}
                hiddenClasses={hidden}
                zoom={zoom}
                step={step}
                onSelect={select}
                labelFor={label}
                tools={stageTools}
                detail={
                  showCard ? (
                    <AssetPopover
                      node={selectedNode}
                      asset={selectedAsset}
                      line={selectedLine}
                      printedTag={tagsByNode.get(selected)?.tag}
                      className={selectedType.name}
                      imageUrl={imageUrl}
                      sheet={{ width: drawing.width, height: drawing.height }}
                      joined={joined}
                      register={plant}
                      onSelectNode={select}
                      onViewAsset={() => setAgentTab("Overview")}
                      onShowRelated={() => setView("Assets")}
                      onReadTag={readTags}
                      onAsk={() => askAbout(selectedNode)}
                      onDismiss={() => setShowCard(false)}
                    />
                  ) : null
                }
              />

              <div className={styles.selectionBar}>
                <span>
                  <strong>{label(selectedNode)}</strong>
                  {nameOf(selectedNode)}
                  {selectedLine ? ` · ${selectedLine.number}` : ""} · {joined.length}{" "}
                  connected {joined.length === 1 ? "component" : "components"} ·{" "}
                  {describeConnections(breakdown)}
                </span>
                <button onClick={readTags}>Read tags</button>
                <button className={styles.primary} onClick={() => askAbout(selectedNode)}>
                  Ask the agent
                </button>
              </div>
            </>
          )}

          {view === "Assets" && (
            <div className={styles.contentArea}>
              <h2>Connected equipment</h2>
              <p>
                Traced through {drawing.source}, hopping over the connectors and crossings
                the drawing uses to join symbols, so this lists plant items rather than
                drafting marks.{" "}
                {drawing.directed
                  ? "Source-to-target direction is preserved; by itself it does not prove process flow."
                  : "The graph is undirected, so it establishes connection but not flow direction."}
              </p>
              <div className={styles.assetFocus}>
                <i style={{ background: selectedType.colour }} aria-hidden="true" />
                <div>
                  <h3>{label(selectedNode)}</h3>
                  <span>
                    {selectedType.name} · {selected}
                  </span>
                </div>
                <dl>
                  <div>
                    <dt>Joined equipment</dt>
                    <dd>{joined.length}</dd>
                  </div>
                  <div>
                    <dt>Graph neighbours</dt>
                    <dd>{neighbors.length}</dd>
                  </div>
                  <div>
                    <dt>Reachable</dt>
                    <dd>{connected.size}</dd>
                  </div>
                </dl>
              </div>
              <div className={styles.assetGrid}>
                {joined.map(({ id, hops }) => {
                  const neighbour = nodeById.get(id);
                  const type = objectClass(neighbour?.kind ?? "");
                  return (
                    <button key={id} onClick={() => select(id)}>
                      <i style={{ background: type.colour }} aria-hidden="true" />
                      <span>
                        <strong>{neighbour ? label(neighbour) : id}</strong>
                        <small>{type.name}</small>
                      </span>
                      <em>
                        {hops} hop{hops === 1 ? "" : "s"}
                      </em>
                    </button>
                  );
                })}
              </div>
              {!joined.length && (
                <p className={styles.muted}>
                  No equipment is reachable from this object through the drawing. It joins
                  only to connectors, crossings or nothing at all.
                </p>
              )}
              <h3>Line styles on this object</h3>
              <dl className={styles.connections}>
                {(["solid", "non-solid"] as const).map((style) => (
                  <div key={style}>
                    <dt>{lineStyle(style).name}</dt>
                    <dd className={styles.plain}>
                      {style === "solid" ? breakdown.solid : breakdown.dashed}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className={styles.muted}>
                {lineStyle("solid").note} {lineStyle("non-solid").note}
              </p>
              <h3>Connected component</h3>
              <p>{connected.size} objects are reachable from this selection.</p>
              <button
                onClick={() => {
                  trace();
                  setView("Canvas");
                }}
              >
                Highlight on drawing
              </button>
            </div>
          )}

          {view === "Twin" && (
            <DigitalTwinView
              scene={HEAT_EXCHANGER_SCENE}
              anchorId={twinAnchor}
              anchorConfirmed={twinConfirmed}
              drawing={drawing}
              register={plant}
              adjacency={adjacency}
              imageUrl={imageUrl}
              sheet={sheet}
              hierarchy={`${plant.site} › ${plant.unit} › ${plant.system}`}
              tagOf={(id) => tagsByNode.get(id)?.tag ?? plant.assets.get(id)?.tag}
              onShowOnDrawing={(id) => {
                select(id);
                setView("Canvas");
              }}
              onAsk={draft}
            />
          )}

          {view === "Files" && (
            <div className={styles.contentArea}>
              <h2>Source library</h2>
              <p>
                Drawing and topology supplied by{" "}
                {sourceMode === "backend" ? "the backend corpus" : "the offline fixture"}.
              </p>
              {catalogControl}
              <SourceFiles
                imageUrl={imageUrl}
                graphUrl={graphUrl}
                drawing={drawing}
                sourceMode={sourceMode}
              />
              <p className={styles.notice}>
                Datasheets, historian records and work orders have not been connected. The
                agent can still search the corpus documents for a tag it reads here.
              </p>
            </div>
          )}

          {view === "Simulation" && (
            <div className={styles.contentArea}>
              <h2>Connection playback</h2>
              <p>
                Walk outward from the selected object, one graph edge at a time, to see how
                far a change could reach.
              </p>
              <p className={styles.notice}>
                Graph traversal only. This is not a hydraulic, thermodynamic or control-loop
                solver, and no process calculation is performed.
              </p>
              <div className={styles.stats}>
                <div>
                  <strong>{step}</strong>
                  <small>Traversal depth</small>
                </div>
                <div>
                  <strong>
                    {Array.from(connected.values()).filter((depth) => depth <= step).length}
                  </strong>
                  <small>Objects reached</small>
                </div>
                <div>
                  <strong>{connected.size}</strong>
                  <small>Reachable objects</small>
                </div>
              </div>
              <button
                onClick={() => {
                  setConnections(true);
                  setView("Canvas");
                }}
              >
                View connections on drawing
              </button>
              <ConnectedResponse
                selected={selected}
                joined={joined}
                reached={new Map([...connected].filter(([, depth]) => depth <= step))}
                register={plant}
                labelOf={(id) => {
                  const node = nodeById.get(id);
                  return node ? label(node) : id;
                }}
                onSelect={select}
              />
            </div>
          )}

          {(view === "Canvas" || view === "Simulation") && (
            <div className={styles.playback}>
              <div>
                <strong>Connection playback</strong>
                <small>
                  {running ? "Running" : "Paused"} · depth {step} of {maxStep}
                </small>
              </div>
              <button
                className={styles.primary}
                onClick={() => {
                  setConnections(true);
                  setRunning((value) => !value);
                }}
              >
                {running ? "Pause" : "Run traversal"}
              </button>
              <button
                aria-label="Reset traversal"
                onClick={() => {
                  setRunning(false);
                  setStep(0);
                }}
              >
                <RefreshIcon />
              </button>
              <label>
                <span className="srOnly">Playback speed</span>
                <select
                  aria-label="Playback speed"
                  value={speed}
                  onChange={(event) => setSpeed(Number(event.target.value))}
                >
                  <option value={1}>1×</option>
                  <option value={2}>2×</option>
                  <option value={4}>4×</option>
                </select>
              </label>
            </div>
          )}
        </section>

        <aside className={styles.agent} aria-label="P&ID Intelligence Agent">
          <div className={styles.panelHeader}>
            <ProductMark />
            <h2>P&ID Intelligence Agent</h2>
          </div>
          <div className={styles.tabs} role="group" aria-label="Agent panel">
            {(["Overview", "Assistant"] as const).map((tab) => (
              <button
                key={tab}
                aria-pressed={agentTab === tab}
                onClick={() => setAgentTab(tab)}
              >
                {tab}
              </button>
            ))}
          </div>

          <div hidden={agentTab !== "Overview"} className={styles.overview}>
            <h3>Inputs received</h3>
            <div className={styles.stats}>
              <button onClick={() => setView("Files")} title="Open the source library">
                <DocumentIcon />
                <strong>1</strong>
                <small>Drawing</small>
              </button>
              <button
                title="List the equipment and instruments"
                onClick={() => {
                  setClassFilter(null);
                  setQuery("");
                  setView("Canvas");
                }}
              >
                <GraphIcon />
                <strong>{equipment.length}</strong>
                <small>Equipment</small>
              </button>
              <button
                aria-pressed={connections}
                title="Show the connections on the drawing"
                onClick={() => {
                  setConnections((value) => !value);
                  setView("Canvas");
                }}
              >
                <GraphIcon />
                <strong>{drawing.edges.length}</strong>
                <small>Connections</small>
              </button>
            </div>

            <h3>Contextualisation</h3>
            <ol className={styles.steps}>
              <Step done n={1} title="Load drawing raster">
                {drawing.width} × {drawing.height} px from{" "}
                {sourceMode === "backend" ? "the corpus" : "the bundled fixture"}
              </Step>
              <Step done n={2} title="Reconstruct topology">
                {drawing.nodes.length} objects · {drawing.edges.length} connections ·{" "}
                {drawing.directed ? "directed" : "undirected"}
              </Step>
              <Step done n={3} title="Classify symbols">
                {equipment.length} equipment and instruments across {classCounts.length}{" "}
                classes
              </Step>
              <Step
                n={4}
                done={namedCount > 0}
                title="Read plant tags"
                {...(namedCount === 0 ? { action: readTags } : {})}
              >
                {namedCount > 0
                  ? `${namedCount} tags read from the drawing and matched to objects.`
                  : "Tags are printed on the drawing rather than recorded in the topology. The agent can read them."}
              </Step>
            </ol>

            <h3>Source properties</h3>
            <dl className={styles.connections}>
              <div>
                <dt>Origin</dt>
                <dd className={styles.plain}>
                  {sourceMode === "backend" ? "Backend corpus" : "Offline fixture"}
                </dd>
              </div>
              <div>
                <dt>Topology file</dt>
                <dd className={`${styles.plain} ${styles.mono}`}>
                  {drawing.source.split("/").at(-1)}
                </dd>
              </div>
              <div>
                <dt>Graph direction</dt>
                <dd className={styles.plain}>
                  {drawing.directed ? "Directed" : "Undirected"}
                </dd>
              </div>
              <div>
                <dt>Positioned objects</dt>
                <dd className={styles.plain}>
                  {drawing.nodes.length - (drawing.unpositioned ?? 0)} of{" "}
                  {drawing.nodes.length}
                </dd>
              </div>
            </dl>

            <h3>Selected asset</h3>
            <div className={styles.selectedCard}>
              <i style={{ background: selectedType.colour }} aria-hidden="true" />
              <strong>{label(selectedNode)}</strong>
              <p>{nameOf(selectedNode)}</p>
              {selectedAsset ? (
                <>
                  <p>{selectedAsset.description}</p>
                  <p>
                    <StatusChip value={selectedAsset.status} />{" "}
                    <SimulatedBadge label="Simulated register" />
                  </p>
                </>
              ) : null}
              <p>
                {joined.length} connected {joined.length === 1 ? "component" : "components"}{" "}
                · {connected.size} reachable
              </p>
              {!tagsByNode.has(selected) && (
                <button onClick={readTags}>Read printed tag from drawing</button>
              )}
              <button onClick={() => askAbout(selectedNode)}>Analyse with the agent</button>
            </div>

            {selectedAsset && selectedAsset.failureModes.length > 0 ? (
              <>
                <h3>Failure modes · ISO 14224</h3>
                <FailureModes asset={selectedAsset} />
              </>
            ) : null}

            <h3>Data connections</h3>
            <dl className={styles.connections}>
              <div>
                <dt>Drawing + topology</dt>
                <dd className={sourceMode === "backend" ? styles.live : styles.warnState}>
                  {sourceMode === "backend" ? "Connected" : "Offline"}
                </dd>
              </div>
              <div>
                <dt>Agent service</dt>
                <dd className={connectionDotClass(health.status)}>{health.status}</dd>
              </div>
              <div>
                <dt>Plant tags</dt>
                <dd className={namedCount > 0 ? styles.live : undefined}>
                  {namedCount > 0 ? `${namedCount} read from drawing` : "Not read yet"}
                </dd>
              </div>
              <div>
                <dt>Historian</dt>
                <dd className={styles.plain}>Simulated trends</dd>
              </div>
              <div>
                <dt>Work orders</dt>
                <dd className={styles.plain}>Simulated register</dd>
              </div>
            </dl>
          </div>

          <div hidden={agentTab !== "Assistant"} className={styles.assistantPanel}>
            <AgentPanel
              sessionId={sessionId}
              composer={composer}
              backendReady={health.status === "ready"}
              drawing={drawing}
              node={selectedNode}
              context={assistantContext}
              onDraft={draft}
              onIdentifyTag={readTags}
              onAnswer={absorbTags}
              askRef={ask}
            />
          </div>
        </aside>

        <div className={styles.bottom}>
          <TelemetryPanel
            asset={selectedAsset}
            source={measuringAsset}
            register={plant}
            onAsk={draft}
          />
          <HierarchyPanel
            register={plant}
            sheet={sheet}
            tag={label(selectedNode)}
            name={nameOf(selectedNode)}
            lineNumber={selectedLine?.number}
            onSite={() => setView("Files")}
            onArea={() => {
              setQuery("");
              setClassFilter(null);
              setView("Assets");
            }}
            onSystem={() => {
              setConnections(true);
              setView("Canvas");
            }}
            onLine={() => {
              trace();
              setView("Canvas");
            }}
            onTag={() => {
              select(selected);
              setView("Canvas");
            }}
          />
          <FilesPanel asset={selectedAsset} onOpen={setOpenDocument} />
          <WorkOrdersPanel
            asset={selectedAsset}
            onOpenDocument={setOpenDocument}
            onAsk={draft}
          />
          <SummaryPanel
            register={plant}
            drawingNodes={drawing.nodes.length}
            positioned={drawing.nodes.length - (drawing.unpositioned ?? 0)}
            printedTags={namedCount}
            onOpen={(target) => {
              if (target === "components") {
                setQuery("");
                setClassFilter(null);
                setView("Assets");
              } else if (target === "loops") {
                setQuery("");
                setClassFilter("control-valve");
                setView("Assets");
              } else if (target === "lines") {
                setConnections(true);
                setView("Canvas");
              } else if (target === "tags") {
                readTags();
              } else {
                setTags(true);
                setHidden(new Set());
                setView("Canvas");
              }
            }}
          />
        </div>
        {openDocument && selectedAsset && (
          <DocumentViewer
            key={`${selectedAsset.tag}#${openDocument.name}`}
            asset={selectedAsset}
            document={openDocument}
            context={{ register: plant, sheet, joined }}
            node={selectedNode}
            drawing={drawing}
            imageUrl={imageUrl}
            onSwitch={setOpenDocument}
            onClose={() => setOpenDocument(undefined)}
            onAsk={draft}
            onShowOnDrawing={() => {
              setShowCard(true);
              setView("Canvas");
            }}
          />
        )}
      </main>
    </div>
  );
}

/** One row of the contextualisation pipeline: done, or explicitly not done and why. */
function Step({
  n,
  title,
  done = false,
  action,
  children,
}: {
  readonly n: number;
  readonly title: string;
  readonly done?: boolean;
  readonly action?: () => void;
  readonly children: ReactNode;
}) {
  return (
    <li className={done ? styles.stepDone : styles.stepPending}>
      <span aria-hidden="true">{done ? "✓" : n}</span>
      <div>
        <strong>{title}</strong>
        <p>
          <span className="srOnly">{done ? "Complete. " : "Not run. "}</span>
          {children}
        </p>
        {action && (
          <button onClick={action}>
            Ask the agent
            <ChevronRightIcon size={13} />
          </button>
        )}
      </div>
    </li>
  );
}

function SourceFiles({
  imageUrl,
  graphUrl,
  drawing,
  sourceMode,
}: {
  readonly imageUrl: string;
  readonly graphUrl: string;
  readonly drawing: CanvasDrawing;
  readonly sourceMode: "backend" | "demo";
}) {
  return (
    <div className={styles.files}>
      <a href={imageUrl} target="_blank" rel="noreferrer">
        <ImageIcon />
        <div>
          <strong>Drawing raster</strong>
          <small>
            {drawing.imagePath.split("/").at(-1)} · {drawing.width} × {drawing.height} px
          </small>
        </div>
      </a>
      <a href={graphUrl} target="_blank" rel="noreferrer">
        <GraphIcon />
        <div>
          <strong>Extracted topology</strong>
          <small>
            {drawing.source.split("/").at(-1)} ·{" "}
            {sourceMode === "backend" ? "GraphML from the corpus" : "GraphML fixture"}
          </small>
        </div>
      </a>
    </div>
  );
}

/**
 * The conversation, with openers drawn from this drawing.
 *
 * The suggestions are prompts, not answers: choosing one fills the composer and the
 * engineer sends it. Each names the source file, so a question can never be about a drawing
 * the request did not identify.
 */
function AgentPanel({
  sessionId,
  composer,
  backendReady,
  drawing,
  node,
  context,
  onDraft,
  onIdentifyTag,
  onAnswer,
  askRef,
}: {
  readonly sessionId: string;
  readonly composer: React.RefObject<ComposerHandle | null>;
  readonly backendReady: boolean;
  readonly drawing: CanvasDrawing;
  readonly node: DrawingNode;
  readonly context: CanvasAssistantContext;
  readonly onDraft: (text: string) => void;
  readonly onIdentifyTag: () => void;
  /** Hand a completed answer to the workspace, which mines it for printed tags. */
  readonly onAnswer: (text: string) => number;
  /** Filled in by this panel so the workspace can send a composed request. */
  readonly askRef: React.RefObject<
    ((text: string, extra?: readonly string[]) => void) | null
  >;
}) {
  const history = useSessionHistory(sessionId);
  const run = useAgentStream(sessionId, history.refresh);
  const absorbed = useRef("");

  // A finished answer may carry tags read off the drawing. Scanning it here, once per
  // completed run, is what turns "Instrument 14" into "CV-38148" across the workspace.
  // Guarded by the text itself so a re-render never re-applies the same answer.
  useEffect(() => {
    const answer = run.state.assistantText;
    if (run.state.phase !== "completed" || !answer || absorbed.current === answer) return;
    absorbed.current = answer;
    onAnswer(answer);
  }, [run.state.phase, run.state.assistantText, onAnswer]);
  const name =
    context.semantic?.asset?.tag ??
    context.semantic?.line?.number ??
    displayName(node.id, node.kind);

  // Published imperatively rather than passed down, because the workspace triggers a send
  // from a button in a different subtree. Writing the ref during render would be read
  // before it is set on the first pass, and React makes no promise about a discarded one.
  useImperativeHandle(
    askRef,
    () =>
      (text: string, extra: readonly string[] = []) => {
        void run.submit({
          body: [{ role: "user", content: withWorkspaceContext(text, context, extra) }],
          displayText: text,
        });
      },
    [run, context],
  );

  const submit = (text: string) => {
    // A free-form question carries a short, factual footer naming the drawing in view, so
    // the agent verifies against the right source. The footer states the sheet and the
    // selection and nothing else; it makes no engineering claim of its own.
    const contextual = withWorkspaceContext(text, context);
    void run.submit({ body: [{ role: "user", content: contextual }], displayText: text });
  };

  const suggestions: readonly (readonly [string, string])[] = [
    [
      `Explain ${name} in plain language`,
      `Explain ${name}: what it is, what it does in this system, and every component it is connected to. Define any technical term you use.`,
    ],
    [
      `How could ${name} fail?`,
      `For ${name}, rank the most likely failure modes using ISO 14224 codes, say what each would do to the connected equipment, and list the checks that would detect it early.`,
    ],
    [
      `Trace ${name} through the plant`,
      `Trace ${name} through the connected equipment: the line it is on, what is upstream and downstream, and which loops it takes part in.`,
    ],
    [`Read the printed tag for ${name}`, "identify"],
    [
      "Review this drawing end to end",
      `Review ${drawing.imagePath} end to end: every component by class with counts, the control loops, the main lines, anomalies or conflicts, and what evidence is still unresolved.`,
    ],
  ];

  return (
    <>
      <Link className={styles.sessionLink} href={`/s/${sessionId}`}>
        Open full conversation
        <ChevronRightIcon size={13} />
      </Link>
      {!history.turns.length && !run.isActive && (
        <div className={styles.suggestions}>
          <h3>Suggested next steps</h3>
          {suggestions.map(([label, prompt]) => (
            <button
              key={label}
              onClick={() => (prompt === "identify" ? onIdentifyTag() : onDraft(prompt))}
            >
              <span>{label}</span>
              <ChevronRightIcon size={14} />
            </button>
          ))}
        </div>
      )}
      <ConversationViewport
        productName="Drawing assistant"
        turns={history.turns}
        run={run.state}
        loading={history.loading}
        historyError={history.error}
        evidenceInline
        onUseExample={(text) => composer.current?.setDraft(text)}
        onCancel={run.cancel}
        onRetry={() => composer.current?.setDraft(run.state.submittedText)}
        onReloadHistory={() => void history.refresh()}
      />
      <FollowUpComposer
        ref={composer}
        onSubmit={submit}
        onCancel={run.cancel}
        busy={run.isActive}
        blockedReason={
          backendReady
            ? undefined
            : "The agent backend is not ready. Recheck its connection before sending."
        }
        placeholder="Ask anything about this drawing…"
      />
    </>
  );
}
