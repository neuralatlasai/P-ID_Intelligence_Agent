"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import {
  CheckIcon,
  ChevronRightIcon,
  GraphIcon,
  ImageIcon,
  ProductMark,
  SearchIcon,
  SessionIcon,
} from "@/components/ui/icons";
import { useAgentStream } from "@/hooks/useAgentStream";
import { useSessionHistory } from "@/hooks/useSession";
import type { CanvasDrawing, DrawingNode } from "@/lib/canvas/model";
import { objectClass } from "@/lib/canvas/taxonomy";
import {
  coordinate,
  displayProfile,
  displayValue,
  scenarioProfile,
  scenarioWindow,
  SIMULATION_VERSION,
  traceEquipment,
} from "@/lib/investigation/engineering";
import { AnswerRenderer } from "@/components/conversation/AnswerRenderer";
import { ActivityDisclosure } from "@/components/conversation/ActivityDisclosure";
import type { ActivityView, StreamPhase } from "@/lib/responses/projector";
import {
  createInvestigationModel,
  type FusionAsset,
  type FusionManifest,
  type InvestigationPage,
} from "@/lib/investigation/model";

import styles from "./InvestigationWorkspace.module.css";

const PAGES: ReadonlyArray<{
  readonly id: InvestigationPage;
  readonly number: string;
  readonly label: string;
}> = [
  { id: "evidence", number: "01", label: "Evidence map" },
  { id: "investigation", number: "02", label: "Asset investigation" },
  { id: "brief", number: "03", label: "Engineering brief" },
];

export function InvestigationWorkspace({
  sessionId,
  drawing,
  fusionManifest,
  sourceMode,
}: {
  readonly sessionId: string;
  readonly drawing: CanvasDrawing;
  readonly fusionManifest: FusionManifest;
  readonly sourceMode: "backend" | "demo";
}) {
  const baseModel = useMemo(
    () => createInvestigationModel(drawing, fusionManifest),
    [drawing, fusionManifest],
  );
  const parameters = useSearchParams();
  const initialPage = parameters.get("page");
  const [page, setPage] = useState<InvestigationPage>(
    initialPage === "investigation" || initialPage === "brief" ? initialPage : "evidence",
  );
  const [selectedEvidence, setSelectedEvidence] = useState("asset");
  const [selectedFusionId, setSelectedFusionId] = useState(
    baseModel.fusionAssets.find((asset) => asset.node.id === parameters.get("node"))?.node
      .id ?? baseModel.asset.id,
  );
  const [tick, setTick] = useState(30);
  const [playing, setPlaying] = useState(true);
  const [disturbance, setDisturbance] = useState(15);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible")
        setTick((value) => Math.min(3600, value + 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [playing]);
  const model = useMemo(
    () => ({ ...baseModel, trend: scenarioWindow(selectedFusionId, tick, disturbance) }),
    [baseModel, selectedFusionId, tick, disturbance],
  );
  function selectFusion(id: string) {
    setSelectedFusionId(id);
    const url = new URL(window.location.href);
    url.searchParams.set("node", id);
    url.searchParams.set("page", page);
    window.history.replaceState({}, "", url);
  }
  const [question, setQuestion] = useState("");
  const assistantInput = useRef<HTMLInputElement>(null);
  const history = useSessionHistory(sessionId);
  const run = useAgentStream(sessionId, history.refresh);
  const [answerNode, setAnswerNode] = useState("");
  const imageUrl =
    sourceMode === "backend"
      ? `/api/canvas/image/${encodeURIComponent(drawing.imagePath)}`
      : "/demo/main-steam.png";
  const currentIndex = PAGES.findIndex((entry) => entry.id === page);
  const selectedFusion =
    model.fusionAssets.find((asset) => asset.node.id === selectedFusionId) ??
    model.fusionAssets[0];

  function openAssistant() {
    setPage("brief");
    requestAnimationFrame(() => assistantInput.current?.focus());
  }

  function askAssistant() {
    const text = question.trim();
    if (!text || run.isActive) return;
    setAnswerNode(selectedFusionId);
    const contextual = [
      `The user is asking from a linked investigation for corpus drawing ${drawing.imagePath} and topology ${drawing.source}.`,
      `The selected fusion annotation is ${selectedFusion?.annotationId ?? "unavailable"}, mapped to source node ${selectedFusion?.node.id ?? model.asset.id}, detected as ${selectedFusion ? objectClass(selectedFusion.node.kind).name : model.assetName}. It has ${selectedFusion?.incidentEdges ?? model.incidentEdges} incident graph edges.`,
      `The complete reference-image mapping set is: ${model.fusionAssets.map((asset) => `${asset.annotationId} -> ${asset.node.id} (${objectClass(asset.node.kind).name})`).join(", ")}.`,
      `Mapping manifest ${model.fusionMappingVersion} is ${model.fusionValidationStatus}; every record passed unique annotation, unique node, exact GraphML class, coordinate, adjacency, and incident-edge validation.`,
      "The field visual is illustrative reference material and the operating trace is simulated. They must never be cited as observed plant evidence.",
      `Specific reference subtype ${selectedFusion?.fieldClass ?? "unknown"} is UNVERIFIED; only coarse GraphML class is checked. Physical flow direction is ${drawing.directed ? "not inferred from graph direction alone" : "not recorded in the undirected source"}.`,
      `Drawing transcription and reference comparison: ${JSON.stringify(selectedFusion?.drawingIdentity ?? { status: "unavailable" })}. Report conflicting reference subtype explicitly and inspect the named source before making a claim.`,
      `Selected image bounds: ${JSON.stringify(selectedFusion?.annotationBox)}. Source node geometry: ${JSON.stringify(selectedFusion?.node)}. Manifest checked at ${fusionManifest.validatedAt ?? "not recorded"}; graph SHA-256 ${fusionManifest.graphDigest ?? "not recorded"}.`,
      `Simulation ${SIMULATION_VERSION}: t=${tick}s, normalized output percent, imposed step ${disturbance} percentage points. Synthetic first-order model, no plant calibration.`,
      "Answer the question in plain language, then give the exact component, evidence, topology, provenance, uncertainty, and pipeline coverage that the corpus supports.",
      "",
      text,
    ].join("\n");
    void run.submit({
      body: [{ role: "user", content: contextual }],
      displayText: text,
    });
    setQuestion("");
  }

  return (
    <div className={styles.workspace}>
      <aside className={styles.rail} aria-label="Investigation navigation">
        <ProductMark size={30} />
        <button aria-current="page" title="Linked investigation">
          <GraphIcon />
          <span>Links</span>
        </button>
        <Link href={`/canvas?session=${sessionId}`} title="Return to Industrial Canvas">
          <ImageIcon />
          <span>Canvas</span>
        </Link>
        <Link href={`/s/${sessionId}`} title="Open assistant conversation">
          <SessionIcon />
          <span>Assistant</span>
        </Link>
      </aside>

      <header className={styles.header}>
        <div className={styles.breadcrumb}>
          <Link href={`/canvas?session=${sessionId}`}>Canvas</Link>
          <ChevronRightIcon size={13} />
          <strong>Linked investigation / {selectedFusionId}</strong>
        </div>
        <nav className={styles.pageNav} aria-label="Investigation pages">
          {PAGES.map((entry) => (
            <button
              key={entry.id}
              aria-current={page === entry.id ? "step" : undefined}
              onClick={() => setPage(entry.id)}
            >
              <span>{entry.number}</span>
              {entry.label}
            </button>
          ))}
        </nav>
        <span className={styles.sourceStatus}>
          <i aria-hidden="true" />
          {sourceMode === "backend" ? "Corpus linked" : "Demo sources"}
        </span>
      </header>

      <main className={styles.main}>
        <header className={styles.pageHeader}>
          <div>
            <span>Linked investigation / page {currentIndex + 1} of 3</span>
            <h1>{PAGES[currentIndex]?.label}</h1>
            <p>
              Source node <strong>{selectedFusion?.node.id ?? model.asset.id}</strong> /{" "}
              {selectedFusion
                ? objectClass(selectedFusion.node.kind).name
                : model.assetName}{" "}
              / {selectedFusion?.incidentEdges ?? model.incidentEdges} recorded connections
            </p>
          </div>
          <div className={styles.pageActions}>
            <button onClick={openAssistant}>Ask the assistant</button>
            <button
              disabled={currentIndex === PAGES.length - 1}
              onClick={() => setPage(PAGES[currentIndex + 1]?.id ?? "brief")}
            >
              Next page
              <ChevronRightIcon size={14} />
            </button>
          </div>
        </header>

        {page === "evidence" ? (
          <EvidenceMap
            imageUrl={imageUrl}
            model={model}
            selected={selectedEvidence}
            onSelect={setSelectedEvidence}
            selectedFusion={selectedFusion}
            onSelectFusion={selectFusion}
            onOpenInvestigation={() => setPage("investigation")}
          />
        ) : null}
        {page === "investigation" ? (
          <AssetInvestigation
            imageUrl={imageUrl}
            model={model}
            selectedFusion={selectedFusion}
            onSelectFusion={selectFusion}
            onOpenBrief={() => setPage("brief")}
            simulation={{
              tick,
              playing: playing && tick < 3600,
              disturbance,
              onPlay: () => setPlaying((value) => !value),
              onReplay: () => {
                setTick(0);
                setPlaying(true);
              },
              onDisturbance: (value) => {
                setDisturbance(value);
                setTick(0);
              },
            }}
            fusionManifest={fusionManifest}
          />
        ) : null}
        {page === "brief" ? (
          <AiBrief
            imageUrl={imageUrl}
            model={model}
            selectedFusion={selectedFusion}
            sessionId={sessionId}
            question={question}
            onQuestionChange={setQuestion}
            onAsk={askAssistant}
            assistantInput={assistantInput}
            assistantText={answerNode === selectedFusionId ? run.state.assistantText : ""}
            submittedText={run.state.submittedText}
            phase={run.state.phase}
            isActive={run.isActive}
            errorMessage={run.state.error?.detail ?? ""}
            answerNode={answerNode}
            activities={run.state.activities}
            onCancel={run.cancel}
          />
        ) : null}
      </main>
    </div>
  );
}

function EvidenceMap({
  imageUrl,
  model,
  selected,
  onSelect,
  selectedFusion,
  onSelectFusion,
  onOpenInvestigation,
}: {
  readonly imageUrl: string;
  readonly model: ReturnType<typeof createInvestigationModel>;
  readonly selected: string;
  readonly onSelect: (id: string) => void;
  readonly selectedFusion: FusionAsset | undefined;
  readonly onSelectFusion: (id: string) => void;
  readonly onOpenInvestigation: () => void;
}) {
  return (
    <section className={styles.map} aria-label="Linked evidence map">
      <LinkCanvas selectedNode={selectedFusion?.node.id ?? model.asset.id} />

      <section
        className={styles.fusionGallery}
        aria-label="Twelve reference asset mappings"
      >
        <header>
          <span>Field-reference registry / illustrative</span>
          <strong>
            {model.fusionAssets.length}/{model.fusionAssets.length} node + class verified
          </strong>
        </header>
        <div>
          {model.fusionAssets.map((asset) => (
            <button
              key={asset.annotationId}
              aria-pressed={selectedFusion?.node.id === asset.node.id}
              onClick={() => {
                onSelect("asset");
                onSelectFusion(asset.node.id);
              }}
            >
              <AnnotatedImage asset={asset} compact />
              <span>
                <b>{asset.annotationId}</b>
                {asset.node.id}
              </span>
            </button>
          ))}
        </div>
      </section>

      <button
        className={`${styles.mapCard} ${styles.drawingNode} ${selected === "drawing" ? styles.selected : ""}`}
        onClick={() => onSelect("drawing")}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageUrl} alt="P&ID source drawing" />
        <span className={styles.cardBody}>
          <small>OBS / controlled corpus drawing</small>
          <strong>PID2Graph OPEN100 / Sheet 0</strong>
          <em>
            {model.drawing.nodes.length} GraphML nodes / {model.drawing.edges.length} edges
          </em>
        </span>
      </button>

      <button
        className={`${styles.mapCard} ${styles.observationNode} ${selected === "observation" ? styles.selected : ""}`}
        onClick={() => onSelect("observation")}
      >
        <span className={styles.observationIcon} aria-hidden="true">
          <SearchIcon size={20} />
        </span>
        <span className={styles.cardBody}>
          <small>Simulation / inspection scenario</small>
          <strong>Operating response workbench</strong>
          <em>{selectedFusion?.node.id} / model inputs and response</em>
        </span>
      </button>

      <button
        className={`${styles.mapCard} ${styles.trendNode} ${selected === "trend" ? styles.selected : ""}`}
        onClick={() => onSelect("trend")}
      >
        <span className={styles.cardBody}>
          <small>SIM / {SIMULATION_VERSION}</small>
          <strong>
            {selectedFusion?.node.id} /{" "}
            {displayProfile(selectedFusion?.node.id ?? model.asset.id).label}
          </strong>
        </span>
        <TrendChart
          values={model.trend}
          nodeId={selectedFusion?.node.id ?? model.asset.id}
          compact
        />
      </button>

      <aside className={styles.mappingPanel}>
        <span className={styles.mappingLabel}>Selected mapping</span>
        <h2>{mappingTitle(selected, selectedFusion)}</h2>
        <IdentityAssessment asset={selectedFusion} />
        <p>{mappingDescription(selected, model, selectedFusion)}</p>
        <dl>
          <div>
            <dt>Drawing</dt>
            <dd>{model.drawing.imagePath}</dd>
          </div>
          <div>
            <dt>Topology</dt>
            <dd>{model.drawing.source}</dd>
          </div>
          <div>
            <dt>Source node</dt>
            <dd>{selectedFusion?.node.id ?? model.asset.id}</dd>
          </div>
          <div>
            <dt>Graph class</dt>
            <dd>{selectedFusion?.node.kind ?? model.asset.kind}</dd>
          </div>
          <div>
            <dt>Center</dt>
            <dd>
              x={coordinate(selectedFusion?.node.x ?? model.asset.x)}, y=
              {coordinate(selectedFusion?.node.y ?? model.asset.y)}
            </dd>
          </div>
          <div>
            <dt>Annotation</dt>
            <dd>{selectedFusion?.annotationId ?? "Not applicable"}</dd>
          </div>
          <div>
            <dt>Provenance</dt>
            <dd>
              {selected === "drawing"
                ? "Corpus evidence"
                : selected === "asset"
                  ? "Illustrative reference"
                  : "Simulation context"}
            </dd>
          </div>
        </dl>
        <button onClick={onOpenInvestigation}>
          Inspect correlation record
          <ChevronRightIcon size={14} />
        </button>
      </aside>
    </section>
  );
}

interface SimulationControls {
  readonly tick: number;
  readonly playing: boolean;
  readonly disturbance: number;
  readonly onPlay: () => void;
  readonly onReplay: () => void;
  readonly onDisturbance: (value: number) => void;
}

function AssetInvestigation({
  imageUrl,
  model,
  selectedFusion,
  onSelectFusion,
  onOpenBrief,
  simulation,
  fusionManifest,
}: {
  readonly imageUrl: string;
  readonly model: ReturnType<typeof createInvestigationModel>;
  readonly selectedFusion: FusionAsset | undefined;
  readonly onSelectFusion: (id: string) => void;
  readonly onOpenBrief: () => void;
  readonly simulation: SimulationControls;
  readonly fusionManifest: FusionManifest;
}) {
  const node = selectedFusion?.node ?? model.asset;
  const neighbours = selectedFusion?.neighbours ?? model.neighbours;
  const incidentEdges = selectedFusion?.incidentEdges ?? model.incidentEdges;
  const nodeById = new Map(model.drawing.nodes.map((entry) => [entry.id, entry]));
  const paths = useMemo(
    () => traceEquipment(model.drawing, node.id),
    [model.drawing, node.id],
  );
  const [pathTarget, setPathTarget] = useState("");
  const selectedPath = paths.find((entry) => entry.id === pathTarget);
  const profile = scenarioProfile(node.id);
  const instrument = displayProfile(node.id);
  const currentValue = displayValue(node.id, model.trend.at(-1) ?? profile.baseline);
  const targetValue = displayValue(node.id, profile.baseline + simulation.disturbance);

  return (
    <section className={styles.investigationGrid}>
      <nav className={styles.fusionSelector} aria-label="Select a fused asset mapping">
        <div>
          <span>Fusion records</span>
          <strong>
            {model.fusionAssets.length}/{model.fusionAssets.length} annotations verified
          </strong>
        </div>
        {model.fusionAssets.map((asset) => (
          <button
            key={asset.annotationId}
            aria-pressed={asset.node.id === node.id}
            onClick={() => onSelectFusion(asset.node.id)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={asset.generatedImagePath} alt="" />
            <span>
              <b>{asset.annotationId}</b>
              {asset.node.id}
            </span>
          </button>
        ))}
      </nav>

      <article className={`${styles.contentCard} ${styles.correlationCard}`}>
        <CardHeader
          eyebrow="01 / synchronized field-to-P&ID correlation"
          title="Selected component match"
          meta="Both boxes update from the selected annotation and source-node geometry"
        />
        <IdentityAssessment asset={selectedFusion} />
        <div className={styles.correlationPair}>
          <section className={styles.correlationSide} aria-label="Annotated field image">
            <header>
              <span>Field-image reference</span>
              <strong>{selectedFusion?.annotationId ?? "Unavailable"}</strong>
            </header>
            {selectedFusion ? <AnnotatedImage asset={selectedFusion} /> : null}
            <p>Reference image / bounded component / not plant evidence</p>
          </section>

          <div className={styles.correlationLink} aria-label="Verified correlation">
            <span>{selectedFusion?.annotationId ?? "--"}</span>
            <i aria-hidden="true" />
            <strong>Registered link</strong>
            <i aria-hidden="true" />
            <span>{node.id}</span>
          </div>

          <section className={styles.correlationSide} aria-label="Annotated P and ID crop">
            <header>
              <span>P&amp;ID source crop</span>
              <strong>{node.id}</strong>
            </header>
            <PidCorrelationCrop
              imageUrl={imageUrl}
              drawing={model.drawing}
              node={node}
              path={selectedPath?.path}
            />
            <p>Corpus evidence · rectangle is the exact GraphML detection bounds</p>
          </section>

          {selectedFusion ? (
            <section className={styles.correlationProof} aria-label="Correlation proof">
              <header>
                <span>Correlation detail block</span>
                <strong>
                  <CheckIcon size={13} /> Annotation ↔ source node
                </strong>
              </header>
              <div>
                <label>
                  Field annotation
                  <output>{selectedFusion.annotationId}</output>
                </label>
                <label>
                  Image box (x, y, w, h)
                  <output>
                    {selectedFusion.annotationBox.x}%, {selectedFusion.annotationBox.y}%,{" "}
                    {selectedFusion.annotationBox.width}%,{" "}
                    {selectedFusion.annotationBox.height}%
                  </output>
                </label>
                <label>
                  P&amp;ID source node
                  <output>{selectedFusion.node.id}</output>
                </label>
                <label>
                  GraphML bounds (w x h)
                  <output>
                    {selectedFusion.node.width.toFixed(2)} x{" "}
                    {selectedFusion.node.height.toFixed(2)} px
                  </output>
                </label>
                <label>
                  GraphML center (x, y)
                  <output>
                    {coordinate(selectedFusion.node.x)}, {coordinate(selectedFusion.node.y)}
                  </output>
                </label>
                <label>
                  Class comparison
                  <output>
                    {selectedFusion.expectedKind} = {selectedFusion.node.kind} / exact
                  </output>
                </label>
                <label>
                  Direct graph links
                  <output>{incidentEdges} incident edges</output>
                </label>
                <label>
                  Field-reference class
                  <output>{selectedFusion.fieldClass}</output>
                </label>
                <label>
                  Specific device identity
                  <output>Unverified / reference subtype only</output>
                </label>
                <label>
                  Field box method
                  <output>Manual region / review required</output>
                </label>
                <label>
                  Flow direction
                  <output>
                    {model.drawing.directed
                      ? "Graph direction recorded; process role unverified"
                      : "Unknown / undirected source"}
                  </output>
                </label>
                <label>
                  Manifest
                  <output>{model.fusionMappingVersion} / verified</output>
                </label>
              </div>
            </section>
          ) : null}
        </div>
        <details className={styles.evidenceDetails}>
          <summary>Source integrity and registration evidence</summary>
          <dl>
            <dt>Validation time (UTC)</dt>
            <dd>{fusionManifest.validatedAt ?? "Offline demonstration"}</dd>
            <dt>Graph SHA-256</dt>
            <dd>{fusionManifest.graphDigest ?? "Unavailable"}</dd>
            <dt>Reference image SHA-256</dt>
            <dd>{selectedFusion?.evidence?.image.sha256 ?? "Unavailable"}</dd>
            <dt>Capture / reviewer / detector</dt>
            <dd>Plant capture unavailable / reviewer not recorded / detector not run</dd>
          </dl>
          <a href={imageUrl} target="_blank" rel="noreferrer">
            Open original P&amp;ID
          </a>
          {" · "}
          <a
            href={`/api/canvas/fusion/${encodeURIComponent(model.drawing.source)}`}
            target="_blank"
            rel="noreferrer"
          >
            Inspect mapping record
          </a>
        </details>
      </article>

      <article className={`${styles.contentCard} ${styles.trendCard}`}>
        <CardHeader
          eyebrow="02 / operating response • simulator"
          title={`${instrument.label} / ${selectedFusion?.drawingIdentity?.tag ?? node.id}`}
          meta={`${node.id} / 1-second scan / ${simulation.playing ? "Running" : "Paused"}`}
        />
        <div className={styles.faceplate}>
          <div>
            <span>PROCESS RESPONSE</span>
            <strong data-testid="simulation-reading">
              {currentValue.toFixed(2)} <small>{instrument.unit}</small>
            </strong>
            <em>Calculated model output</em>
          </div>
          <div>
            <span>INPUT TARGET</span>
            <strong>
              {targetValue.toFixed(2)} <small>{instrument.unit}</small>
            </strong>
            <em>Step at t = {profile.stepAt}s</em>
          </div>
          <div>
            <span>RESPONSE ERROR</span>
            <strong>
              {(targetValue - currentValue).toFixed(2)} <small>{instrument.unit}</small>
            </strong>
            <em>
              {Math.abs(targetValue - currentValue) < instrument.span * 0.01
                ? "Settled within 1% span"
                : "Approaching target"}
            </em>
          </div>
        </div>
        <div className={styles.simulationControls}>
          <button onClick={simulation.onPlay} disabled={simulation.tick >= 3600}>
            {simulation.playing ? "Pause simulation" : "Run simulation"}
          </button>
          <button onClick={simulation.onReplay}>Replay from start</button>
          <label>
            Input step (percentage points)
            <input
              aria-label="Simulation input step"
              type="range"
              min="-25"
              max="25"
              step="1"
              value={simulation.disturbance}
              onChange={(event) => simulation.onDisturbance(Number(event.target.value))}
            />
          </label>
          <output aria-live="off">
            {simulation.disturbance > 0 ? "+" : ""}
            {simulation.disturbance} pp · t={simulation.tick}s ·{" "}
            {simulation.playing ? "RUNNING" : "PAUSED"}
          </output>
        </div>
        <TrendChart
          values={model.trend}
          nodeId={node.id}
          target={profile.baseline + simulation.disturbance}
          endSeconds={simulation.tick}
        />
        <div className={styles.trendStats}>
          <span>
            Current output{" "}
            <strong>
              {currentValue.toFixed(2)} {instrument.unit}
            </strong>
          </span>
          <span>
            Window range{" "}
            <strong>
              {displayValue(node.id, Math.min(...model.trend)).toFixed(1)}–
              {displayValue(node.id, Math.max(...model.trend)).toFixed(1)} {instrument.unit}
            </strong>
          </span>
          <span>
            Response constant <strong>{profile.tau}s</strong>
          </span>
          <span>
            Elapsed time <strong>{simulation.tick}s</strong>
          </span>
        </div>
        <details className={styles.evidenceDetails}>
          <summary>Model basis and operating assumptions</summary>
          <p>
            Model {SIMULATION_VERSION}: dy/dt = (target − y)/τ. Baseline{" "}
            {displayValue(node.id, profile.baseline).toFixed(2)} {instrument.unit}; τ=
            {profile.tau}s; step applied at {profile.stepAt}s. Engineering display span{" "}
            {instrument.lower}–{instrument.lower + instrument.span} {instrument.unit}.
            Parameters and units define a demonstration exercise; no plant calibration or
            alarm limits are established. Playback pauses in hidden tabs and stops at one
            hour.
          </p>
        </details>
      </article>

      <article className={`${styles.contentCard} ${styles.traceCard}`}>
        <CardHeader
          eyebrow="03 / topology trace"
          title="Equipment relationship trace"
          meta={`${paths.length} reachable equipment endpoints (maximum 60) / ${neighbours.length} direct graph neighbours`}
        />
        <div className={styles.topologyTable}>
          <div className={styles.topologyHeader}>
            <span>Node ID</span>
            <span>Graph class</span>
            <span>Graph relationship</span>
          </div>
          {paths.length ? (
            paths.map(({ id, path }) => {
              const neighbour = nodeById.get(id);
              return (
                <div key={id} className={styles.topologyRow}>
                  <button
                    aria-pressed={selectedPath?.id === id}
                    onClick={() => setPathTarget(id)}
                  >
                    {id}
                  </button>
                  <span>{neighbour?.kind ?? "unclassified"}</span>
                  <span>{path.length - 1} graph hops / direction unverified</span>
                </div>
              );
            })
          ) : (
            <p>No equipment endpoint was found through the recorded graph connections.</p>
          )}
        </div>
        {selectedPath ? (
          <p className={styles.modelNote}>
            Selected path: {selectedPath.path.join(" → ")}. Order shows traversal, not fluid
            flow.
          </p>
        ) : (
          <p className={styles.modelNote}>
            Select an endpoint to highlight its route on the P&amp;ID. Connectivity follows
            extracted edges; crossing interpretation and physical service require drawing
            review.
          </p>
        )}
        <button onClick={onOpenBrief}>
          Open engineering brief
          <ChevronRightIcon size={14} />
        </button>
      </article>
    </section>
  );
}

function AiBrief({
  imageUrl,
  model,
  selectedFusion,
  sessionId,
  question,
  onQuestionChange,
  onAsk,
  assistantInput,
  assistantText,
  submittedText,
  phase,
  isActive,
  errorMessage,
  answerNode,
  activities,
  onCancel,
}: {
  readonly imageUrl: string;
  readonly model: ReturnType<typeof createInvestigationModel>;
  readonly selectedFusion: FusionAsset | undefined;
  readonly sessionId: string;
  readonly question: string;
  readonly onQuestionChange: (value: string) => void;
  readonly onAsk: () => void;
  readonly assistantInput: RefObject<HTMLInputElement | null>;
  readonly assistantText: string;
  readonly submittedText: string;
  readonly phase: StreamPhase;
  readonly isActive: boolean;
  readonly errorMessage: string;
  readonly answerNode: string;
  readonly activities: readonly ActivityView[];
  readonly onCancel: () => void;
}) {
  const node = selectedFusion?.node ?? model.asset;
  const incidentEdges = selectedFusion?.incidentEdges ?? model.incidentEdges;
  const neighbours = selectedFusion?.neighbours ?? model.neighbours;
  const [activityOpen, setActivityOpen] = useState(false);

  return (
    <section className={styles.briefLayout}>
      <div className={styles.briefCanvas}>
        <div className={styles.sourceStrip}>
          <article>
            <header>
              <span className={styles.sourceCode}>REF</span>
              <strong>Field-reference image</strong>
            </header>
            {selectedFusion ? <AnnotatedImage asset={selectedFusion} compact /> : null}
            <footer>
              {selectedFusion?.annotationId ?? "Unavailable"} / reference / non-evidentiary
            </footer>
          </article>
          <article>
            <header>
              <span className={`${styles.sourceCode} ${styles.sourceCodeObserved}`}>
                OBS
              </span>
              <strong>Controlled P&amp;ID source</strong>
            </header>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imageUrl} alt="Linked P&ID drawing" />
            <footer>{model.drawing.source} / corpus evidence</footer>
          </article>
          <article className={styles.miniTrend}>
            <header>
              <span className={`${styles.sourceCode} ${styles.sourceCodeSimulated}`}>
                SIM
              </span>
              <strong>Scenario signal</strong>
            </header>
            <TrendChart values={model.trend} nodeId={node.id} compact />
            <footer>
              {node.id} / {displayProfile(node.id).unit} / response model
            </footer>
          </article>
        </div>

        <article className={styles.engineeringDossier}>
          <header>
            <div>
              <span className={styles.briefStatus}>
                <CheckIcon size={13} /> REGISTRY AND GRAPH CHECKED
              </span>
              <IdentityAssessment asset={selectedFusion} />
              <h2>Engineering correlation dossier</h2>
              <p>
                Active registration{" "}
                <code>{selectedFusion?.annotationId ?? "unavailable"}</code>
                {" -> "}
                <code>{node.id}</code>. Identity is registered; topology and geometry are
                independently revalidated against the loaded GraphML.
              </p>
            </div>
            <dl className={styles.dossierCodes}>
              <div>
                <dt>Manifest</dt>
                <dd>{model.fusionMappingVersion}</dd>
              </div>
              <div>
                <dt>Drawing</dt>
                <dd>OPEN100 / 0</dd>
              </div>
              <div>
                <dt>Record state</dt>
                <dd>COARSE CLASS CHECKED</dd>
              </div>
            </dl>
          </header>

          <div className={styles.dossierGrid}>
            <section>
              <h3>Registered identity</h3>
              <dl>
                <div>
                  <dt>Annotation ID</dt>
                  <dd>{selectedFusion?.annotationId ?? "Unavailable"}</dd>
                </div>
                <div>
                  <dt>GraphML node</dt>
                  <dd>{node.id}</dd>
                </div>
                <div>
                  <dt>Graph class</dt>
                  <dd>{node.kind}</dd>
                </div>
                <div>
                  <dt>Field-reference class</dt>
                  <dd>{selectedFusion?.fieldClass ?? "Unavailable"}</dd>
                </div>
                <div>
                  <dt>Drawing center</dt>
                  <dd>
                    x={coordinate(node.x)}, y={coordinate(node.y)}
                  </dd>
                </div>
                <div>
                  <dt>Incident edges</dt>
                  <dd>{incidentEdges}</dd>
                </div>
              </dl>
            </section>

            <section>
              <h3>Evidence classification</h3>
              <table>
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th>Authority</th>
                    <th>Permitted use</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>GraphML</td>
                    <td>OBSERVED</td>
                    <td>Node class, bounds, adjacency</td>
                  </tr>
                  <tr>
                    <td>Field reference</td>
                    <td>REFERENCE</td>
                    <td>Visual recognition only</td>
                  </tr>
                  <tr>
                    <td>Signal trace</td>
                    <td>SIMULATED</td>
                    <td>Workflow demonstration only</td>
                  </tr>
                </tbody>
              </table>
            </section>
          </div>

          <footer>
            <strong>Engineering boundary:</strong> no plant tag, operating condition,
            failure state, or inspection result is inferred from the reference image or
            simulated signal.
          </footer>

          <div className={styles.briefMetrics}>
            <div>
              <strong>{model.drawing.nodes.length}</strong>
              <span>GraphML nodes</span>
            </div>
            <div>
              <strong>{incidentEdges}</strong>
              <span>incident edges</span>
            </div>
            <div>
              <strong>
                {model.fusionAssets.length}/{model.fusionAssets.length}
              </strong>
              <span>verified registrations</span>
            </div>
          </div>
        </article>
      </div>

      <aside className={styles.copilotPanel}>
        <header>
          <ProductMark size={20} />
          <div>
            <strong>Engineering evidence assistant</strong>
            <span>Evidence context / source verification required</span>
          </div>
        </header>
        <div className={styles.promptBubble}>
          {submittedText || "Summarize the linked investigation package"}
        </div>
        <div className={styles.answerBubble}>
          <strong>{assistantText ? "Assistant response" : "Source record summary"}</strong>
          {errorMessage ? <p role="alert">{errorMessage}</p> : null}
          {answerNode && answerNode !== node.id ? (
            <p role="status">
              The previous answer belongs to {answerNode}. Ask a new question for {node.id}.
            </p>
          ) : null}
          {assistantText ? (
            <AnswerRenderer
              text={assistantText}
              streaming={isActive}
              partial={phase === "failed" || phase === "cancelled"}
            />
          ) : (
            <ul>
              <li>
                <b>GraphML evidence:</b> node <code>{node.id}</code> is class{" "}
                <code>{node.kind}</code> in <code>{model.drawing.source}</code>, centered at
                x=
                {coordinate(node.x)}, y={coordinate(node.y)}, with {incidentEdges} incident
                edges.
              </li>
              <li>
                <b>Registered linkage:</b> annotation{" "}
                <code>{selectedFusion?.annotationId ?? "unavailable"}</code> resolves
                one-to-one to <code>{node.id}</code>; {neighbours.length} direct neighbours
                are available for topology review.
              </li>
              <li>
                <b>Evidence boundary:</b> the field visual is illustrative and the trace is
                simulated. Neither establishes plant identity, condition, or measurement.
              </li>
            </ul>
          )}
        </div>
        <ActivityDisclosure
          activities={activities}
          phase={phase}
          open={activityOpen || isActive}
          onToggle={setActivityOpen}
          onCancel={onCancel}
        />
        <div className={styles.briefThumbnails}>
          {selectedFusion ? <AnnotatedImage asset={selectedFusion} compact /> : null}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl} alt="P&ID thumbnail" />
          <TrendChart values={model.trend} nodeId={node.id} compact />
        </div>
        <Link
          className={styles.addButton}
          href={`/canvas?session=${sessionId}&node=${encodeURIComponent(node.id)}`}
        >
          Open Industrial Canvas
        </Link>
        <Link className={styles.assistantLink} href={`/s/${sessionId}`}>
          Continue with the full assistant
          <ChevronRightIcon size={14} />
        </Link>
        <form
          className={styles.assistantComposer}
          onSubmit={(event) => {
            event.preventDefault();
            onAsk();
          }}
        >
          <label className="srOnly" htmlFor="investigation-question">
            Ask about this investigation
          </label>
          <input
            ref={assistantInput}
            id="investigation-question"
            value={question}
            maxLength={4000}
            disabled={isActive}
            onChange={(event) => onQuestionChange(event.target.value)}
            placeholder={
              isActive ? `Assistant ${phase}...` : "Ask about this investigation..."
            }
          />
          <button disabled={isActive || !question.trim()} type="submit">
            Ask
          </button>
        </form>
      </aside>
    </section>
  );
}

function CardHeader({
  eyebrow,
  title,
  meta,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly meta: string;
}) {
  return (
    <header className={styles.cardHeader}>
      <span>{eyebrow}</span>
      <h2>{title}</h2>
      <p>{meta}</p>
    </header>
  );
}

function IdentityAssessment({ asset }: { readonly asset: FusionAsset | undefined }) {
  const identity = asset?.drawingIdentity;
  return (
    <details className={styles.identityAssessment}>
      <summary>
        {identity?.status === "reviewed-transcription"
          ? `P&ID: ${identity.tag}`
          : "P&ID identity awaiting review"}{" "}
        ·{" "}
        {identity?.referenceComparison === "conflicting"
          ? "Reference mismatch"
          : "Subtype unverified"}
      </summary>
      <p>
        {identity?.description}.{" "}
        {identity?.referenceComparison === "conflicting"
          ? "Reference subtype conflicts with the printed P&ID identity. This image is illustrative only."
          : "Reference subtype and physical asset identity are not verified."}
      </p>
    </details>
  );
}

function PidCorrelationCrop({
  imageUrl,
  drawing,
  node,
  path,
}: {
  readonly imageUrl: string;
  readonly drawing: CanvasDrawing;
  readonly node: DrawingNode;
  readonly path?: readonly string[];
}) {
  const cropWidth = Math.min(
    drawing.width,
    Math.max(node.width * 7, node.height * 5 * (4 / 3), drawing.width * 0.11),
  );
  const cropHeight = Math.min(drawing.height, Math.max(node.height * 5, cropWidth * 0.75));
  const cropX = Math.max(0, Math.min(drawing.width - cropWidth, node.x - cropWidth / 2));
  const cropY = Math.max(0, Math.min(drawing.height - cropHeight, node.y - cropHeight / 2));
  const boxX = node.x - node.width / 2;
  const boxY = node.y - node.height / 2;
  const pathIds = new Set(path ?? []);
  const routeNodes = drawing.nodes.filter((entry) => pathIds.has(entry.id));
  const routeLeft = Math.max(
    0,
    Math.min(...routeNodes.map((entry) => entry.x - entry.width / 2)) - 35,
  );
  const routeTop = Math.max(
    0,
    Math.min(...routeNodes.map((entry) => entry.y - entry.height / 2)) - 35,
  );
  const routeRight = Math.min(
    drawing.width,
    Math.max(...routeNodes.map((entry) => entry.x + entry.width / 2)) + 35,
  );
  const routeBottom = Math.min(
    drawing.height,
    Math.max(...routeNodes.map((entry) => entry.y + entry.height / 2)) + 35,
  );

  return (
    <svg
      className={styles.pidCorrelationCrop}
      viewBox={
        routeNodes.length
          ? `${routeLeft} ${routeTop} ${routeRight - routeLeft} ${routeBottom - routeTop}`
          : `${cropX} ${cropY} ${cropWidth} ${cropHeight}`
      }
      role="img"
      aria-label={`P&ID crop with exact GraphML bounds for ${node.id}`}
      data-testid="source-node-marker"
      data-source-x={node.x}
      data-source-y={node.y}
    >
      <image
        href={imageUrl}
        x="0"
        y="0"
        width={drawing.width}
        height={drawing.height}
        preserveAspectRatio="none"
      />
      {routeNodes.map((entry) => (
        <circle
          key={entry.id}
          cx={entry.x}
          cy={entry.y}
          r="8"
          fill="#0284c7"
          fillOpacity="0.45"
          stroke="#075985"
          vectorEffect="non-scaling-stroke"
        >
          <title>{entry.id}</title>
        </circle>
      ))}
      <rect
        className={styles.pidDetectionBox}
        x={boxX}
        y={boxY}
        width={Math.max(node.width, 1)}
        height={Math.max(node.height, 1)}
        vectorEffect="non-scaling-stroke"
      />
      <circle
        className={styles.pidDetectionCenter}
        cx={node.x}
        cy={node.y}
        r={Math.max(2, Math.min(node.width, node.height) * 0.08)}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function AnnotatedImage({
  asset,
  compact = false,
}: {
  readonly asset: FusionAsset;
  readonly compact?: boolean;
}) {
  const box = asset.annotationBox;
  // All coordinates share the same SVG viewBox. Letterboxing transforms both together.
  const width = asset.evidence?.image.width ?? 1448;
  const height = asset.evidence?.image.height ?? 1086;
  const x = (box.x * width) / 100;
  const y = (box.y * height) / 100;
  const labelHeight = height * 0.035;
  return (
    <span
      className={`${styles.annotatedImage} ${compact ? styles.annotatedImageCompact : ""}`}
      data-annotation-id={asset.annotationId}
      data-node-id={asset.node.id}
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Illustrative field reference: ${asset.fieldClass}; annotation ${asset.annotationId}; manually registered region`}
      >
        <image href={asset.generatedImagePath} x="0" y="0" width={width} height={height} />
        <rect
          data-testid="field-annotation-box"
          x={x}
          y={y}
          width={(box.width * width) / 100}
          height={(box.height * height) / 100}
          fill="none"
          stroke="#dc234e"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
        <rect
          x={x}
          y={Math.max(0, y - labelHeight)}
          width={width * 0.16}
          height={labelHeight}
          fill="#941c3b"
        />
        <text
          x={x + 8}
          y={Math.max(0, y - labelHeight) + labelHeight * 0.74}
          fill="white"
          fontSize={labelHeight * 0.65}
          fontFamily="monospace"
        >
          {asset.annotationId}
        </text>
      </svg>
      <span className={styles.generatedBadge}>Reference</span>
    </span>
  );
}

function TrendChart({
  values,
  compact = false,
  endSeconds,
  nodeId = "",
  target,
}: {
  readonly values: readonly number[];
  readonly compact?: boolean;
  readonly endSeconds?: number;
  readonly nodeId?: string;
  readonly target?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const context = element.getContext("2d");
    if (!context) return;
    const width = element.width;
    const height = element.height;
    context.clearRect(0, 0, width, height);
    context.strokeStyle = "#e3e7ef";
    context.lineWidth = 1;
    for (let row = 1; row < 4; row += 1) {
      const y = (height / 4) * row;
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }
    context.fillStyle = "#405965";
    context.font = "18px sans-serif";
    if (!compact) {
      for (const value of [0, 50, 100])
        context.fillText(
          `${displayValue(nodeId, value).toFixed(0)}`,
          4,
          height - 30 - (value / 100) * (height - 60),
        );
      context.fillText(
        `${Math.max(0, (endSeconds ?? values.length - 1) - values.length + 1)}s`,
        55,
        height - 4,
      );
      context.fillText(`${endSeconds ?? values.length - 1}s`, width - 60, height - 4);
    }
    if (target !== undefined) {
      context.strokeStyle = "#697c86";
      context.setLineDash([8, 5]);
      context.beginPath();
      const targetY = height - 35 - (target / 100) * (height - 60);
      context.moveTo(55, targetY);
      context.lineTo(width - 16, targetY);
      context.stroke();
      context.setLineDash([]);
      context.fillText("TARGET", width - 95, targetY - 7);
    }
    context.strokeStyle = "#086585";
    context.lineWidth = compact ? 3 : 4;
    context.lineJoin = "round";
    context.beginPath();
    values.forEach((value, index) => {
      const x = (index / Math.max(1, values.length - 1)) * (width - 70) + 55;
      const y = height - 35 - (value / 100) * (height - 60);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  }, [values, compact, endSeconds, nodeId, target]);

  return (
    <canvas
      ref={canvas}
      className={compact ? styles.compactChart : styles.chart}
      width={compact ? 420 : 900}
      height={compact ? 130 : 260}
      role="img"
      aria-label={`Simulated ${displayProfile(nodeId).label}, ${values.length} samples, latest ${displayValue(nodeId, values.at(-1) ?? 0).toFixed(2)} ${displayProfile(nodeId).unit}; sample interval one second`}
    />
  );
}

function LinkCanvas({ selectedNode }: { readonly selectedNode: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const draw = () => {
      const box = element.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      element.width = Math.max(1, Math.round(box.width * scale));
      element.height = Math.max(1, Math.round(box.height * scale));
      const context = element.getContext("2d");
      if (!context) return;
      context.scale(scale, scale);
      context.clearRect(0, 0, box.width, box.height);
      context.strokeStyle = "#697386";
      context.lineWidth = 1.5;
      context.setLineDash([5, 5]);
      const container = element.parentElement;
      if (!container) return;
      const selected = container.querySelector(
        `.${styles.fusionGallery} button[aria-pressed="true"]`,
      );
      const drawing = container.querySelector(`.${styles.drawingNode}`);
      const panel = container.querySelector(`.${styles.mappingPanel}`);
      const trend = container.querySelector(`.${styles.trendNode}`);
      for (const [from, to] of [
        [selected, drawing],
        [drawing, panel],
        [drawing, trend],
      ]) {
        if (!from || !to) continue;
        const a = from.getBoundingClientRect();
        const b = to.getBoundingClientRect();
        context.beginPath();
        context.moveTo(a.right - box.left, a.top + a.height / 2 - box.top);
        context.lineTo(b.left - box.left, b.top + b.height / 2 - box.top);
        context.stroke();
      }
    };
    const observer = new ResizeObserver(draw);
    observer.observe(element);
    if (element.parentElement) observer.observe(element.parentElement);
    draw();
    return () => observer.disconnect();
  }, [selectedNode]);

  return <canvas ref={canvas} className={styles.linkCanvas} aria-hidden="true" />;
}

function mappingTitle(selected: string, asset: FusionAsset | undefined): string {
  switch (selected) {
    case "drawing":
      return "Corpus drawing and extracted topology";
    case "observation":
      return "Simulated inspection observation";
    case "trend":
      return "Simulated time-series context";
    default:
      return asset ? `${asset.annotationId} / ${asset.title}` : "Field reference";
  }
}

function mappingDescription(
  selected: string,
  model: ReturnType<typeof createInvestigationModel>,
  asset: FusionAsset | undefined,
): string {
  if (selected === "drawing") {
    return `The raster and GraphML are corpus sources. The active registration resolves to node ${asset?.node.id ?? model.asset.id}; topology facts come from ${model.drawing.source}.`;
  }
  if (selected === "observation") {
    return "A demonstration inspection record showing how field observations attach to a source asset. It is labeled as simulation and is not treated as plant history.";
  }
  if (selected === "trend") {
    return "A deterministic demonstration series used to show temporal linkage. No historian is connected, so these values are never presented as measurements.";
  }
  return asset
    ? `Reference visual ${asset.annotationId} illustrates the ${asset.fieldClass.toLowerCase()} class registered to GraphML node ${asset.node.id}. Its overlay box is application annotation data; the corpus node and its geometry remain the detection authority.`
    : `Reference visual context is unavailable for ${model.asset.id}.`;
}
