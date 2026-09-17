"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { buildPlantRegister } from "@/lib/canvas/engineering";
import { buildAdjacency, type CanvasDrawing } from "@/lib/canvas/model";
import { fieldClassesFor } from "@/lib/investigation/model";
import type { RunConfig } from "@/lib/modellab/config";
import {
  ROLLOUT_MS,
  policyAnswer,
  rlPolicyProfile,
  rolloutIndexAt,
  sampleProvenance,
  studentProfile,
  teacherProfile,
  type ErrorProfile,
} from "@/lib/modellab/policy";
import { checkpoints, pause, resume, stepAt } from "@/lib/modellab/run";
import {
  buildSamples,
  corpusFacts,
  groundedAnswer,
  verifyAnswer,
  type CheckId,
  type LabSample,
} from "@/lib/modellab/samples";
import {
  SESSION_KEY,
  applyConfig,
  effectiveStage,
  freshSession,
  lineageOf,
  loadSession,
  resumeFromCheckpoint,
  stopRun,
  type LabSession,
} from "@/lib/modellab/session";
import { STAGES, stageById, type StageId } from "@/lib/modellab/stages";
import { HEAT_EXCHANGER_SCENE, resolveAnchor } from "@/lib/twin/scene";

import { ArtifactsRow, RewardBreakdownCard, TeacherStudentRuntimeCard } from "./Cards";
import { CheckpointsLiveCard } from "./CheckpointsLiveCard";
import { ContractLiveCard } from "./ContractLiveCard";
import { CurvesLiveCard } from "./CurvesLiveCard";
import { DeploymentLiveCard } from "./DeploymentLiveCard";
import { HardwareCard } from "./HardwareCard";
import { MetricsLiveCard } from "./MetricsLiveCard";
import { MixtureLiveCard } from "./MixtureLiveCard";
import { ProgressLiveCard } from "./ProgressLiveCard";
import { RecipeLiveCard } from "./RecipeLiveCard";
import { RunControls, LineageBanner, Freshness } from "./RunControls";
import { RunLogCard } from "./RunLogCard";
import { RuntimeConfigCard } from "./RuntimeConfigCard";
import { SampleStrip } from "./SampleStrip";
import { Icon, type IconName } from "./icons";
import styles from "./ModelLab.module.css";

const CYCLE_MS = 15_000;

/**
 * What is simulated and what is real, said once per stage and only about that stage. The
 * training itself is simulated everywhere; what differs is which evidence on the page is live.
 */
const STAGE_NOTE: Record<StageId, string> = {
  pretraining:
    "Simulated pretraining run at the selected hardware's estimated rate · corpus counts, P&ID crops and topology are live from the corpus.",
  sft: "Simulated SFT run · instruction samples, evidence counts and the reasoning trace are built from real register and topology facts.",
  rl: "Simulated policy rollouts with injected errors at the current hallucination rate · the verifier checks each one against the real register, graph and telemetry.",
  distillation:
    "Simulated distillation · teacher and student answers are verified live; deployment latencies come from the simulated eval.",
};

const NAV: readonly {
  label: string;
  icon: IconName;
  href?: string;
  action?: "settings";
}[] = [
  { label: "Home", icon: "home", href: "/" },
  { label: "Canvas", icon: "canvas", href: "/canvas" },
  { label: "Assets", icon: "assets", href: "/canvas?view=Assets" },
  { label: "Data", icon: "data", href: "#data-contract" },
  { label: "Model Lab", icon: "model", href: "/model-lab/pretraining" },
  { label: "Simulation", icon: "simulation", href: "/canvas?view=Twin" },
  { label: "Deploy", icon: "deploy", href: "/model-lab/distillation#deployment" },
  { label: "Monitoring", icon: "monitoring", href: "/canvas?view=Canvas" },
  { label: "Experiments", icon: "experiments", href: "#runtime" },
  { label: "Reports", icon: "reports", href: "/investigation" },
  { label: "Settings", icon: "settings", action: "settings" },
];

export function ModelLab({
  stageId,
  drawing,
  source,
  drawings,
  corpusFiles,
  offlineReason,
}: {
  readonly stageId: StageId;
  readonly drawing: CanvasDrawing;
  readonly source: "backend" | "demo";
  readonly drawings: number | null;
  readonly corpusFiles: number | null;
  readonly offlineReason?: string | undefined;
}) {
  const adjacency = useMemo(
    () => buildAdjacency(drawing.nodes, drawing.edges, drawing.directed),
    [drawing],
  );
  const register = useMemo(() => {
    const anchor = resolveAnchor(HEAT_EXCHANGER_SCENE, drawing, adjacency);
    const confirmed =
      anchor !== undefined && HEAT_EXCHANGER_SCENE.preferredAnchors.includes(anchor);
    return buildPlantRegister(
      drawing,
      adjacency,
      undefined,
      confirmed && anchor ? new Set([anchor]) : new Set(),
      fieldClassesFor(drawing),
    );
  }, [drawing, adjacency]);

  // ── the clock, the session and the effective stages ──────────────────────────────────────
  const [now, setNow] = useState(() => Date.now());
  const [session, setSession] = useState(() => loadSession(Date.now(), storage()));
  const [drafts, setDrafts] = useState<Partial<Record<StageId, RunConfig>>>({});
  const [autoCycle, setAutoCycle] = useState(true);
  const [cycleStart, setCycleStart] = useState(() => Date.now());
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch {
      // Not persisting only means a reload finds the runs where a fresh visitor would.
    }
  }, [session]);

  const effective = useMemo(
    () =>
      Object.fromEntries(
        STAGES.map((plan) => [plan.id, effectiveStage(plan, session.applied[plan.id])]),
      ) as Record<StageId, ReturnType<typeof effectiveStage>>,
    [session.applied],
  );
  const { stage, profile } = effective[stageId];
  const config = session.applied[stageId].config;
  const draft = drafts[stageId] ?? config;

  const control = session.controls[stageId];
  const step = stepAt(control, stage.run, now);
  const progress = step / stage.run.totalSteps;
  const complete = step >= stage.run.totalSteps;
  const lineage = lineageOf(session, stageId, now);
  const blocked = lineage.source === "blocked";
  const running = control.status === "running" && !complete && !blocked;

  const act = (change: (current: LabSession, at: number) => LabSession) => {
    const at = Date.now();
    setNow(at);
    setSession((current) => change(current, at));
  };
  const toggleRun = () =>
    act((current, at) => {
      freezeCycle();
      const run = effectiveStage(stageById(stageId)!, current.applied[stageId]).stage.run;
      return {
        ...current,
        controls: {
          ...current.controls,
          [stageId]: running
            ? pause(current.controls[stageId], run, at)
            : resume(current.controls[stageId], run, at),
        },
      };
    });
  const clearDraft = () => setDrafts((current) => ({ ...current, [stageId]: undefined }));

  const liveProps = { stage, step, progress, now, running, config, profile };

  // ── samples, rollouts and verification ────────────────────────────────────────────────────
  const samples = useMemo(
    () => buildSamples(stage, drawing, register, adjacency),
    [stage, drawing, register, adjacency],
  );
  // The shown sample is derived from the clock while auto-cycling, so there is no timer state
  // to drift: base index plus whole cycles elapsed since the cycle started.
  const [baseIndex, setBaseIndex] = useState(0);
  const cycling = autoCycle && running && samples.length > 1;
  const cycleElapsed = Math.max(0, now - cycleStart);
  const sampleIndex =
    (baseIndex + (cycling ? Math.floor(cycleElapsed / CYCLE_MS) : 0)) %
    Math.max(1, samples.length);
  const sample = samples[sampleIndex];
  const freezeCycle = () => {
    setBaseIndex(sampleIndex);
    setCycleStart(Date.now());
  };
  const choose = (index: number) => {
    setAutoCycle(false);
    setCycleStart(Date.now());
    setBaseIndex((index + samples.length) % samples.length);
  };

  // A new rollout every 30 s of a running stage; verification always runs against "now", so a
  // reading that has drifted since the answer was composed is caught.
  const composedAt = running ? Math.floor(now / ROLLOUT_MS) * ROLLOUT_MS : control.at;
  const rolloutIndex = rolloutIndexAt(composedAt);
  const verifyBucket = Math.floor(now / 5000) * 5000;
  const evalProgress = Math.floor(progress * 200) / 200;

  const answer = useMemo(
    () => (sample ? groundedAnswer(sample, register, composedAt) : undefined),
    [sample, register, composedAt],
  );
  const student = useMemo(
    () => (sample ? groundedAnswer(sample, register, composedAt, true) : undefined),
    [sample, register, composedAt],
  );
  const verification = useMemo(
    () =>
      sample && answer
        ? verifyAnswer(answer.text, sample, drawing, register, adjacency, verifyBucket)
        : undefined,
    [sample, answer, drawing, register, adjacency, verifyBucket],
  );
  const studentVerification = useMemo(
    () =>
      sample && student
        ? verifyAnswer(student.text, sample, drawing, register, adjacency, verifyBucket)
        : undefined,
    [sample, student, drawing, register, adjacency, verifyBucket],
  );

  const rollout = useCallback(
    (item: LabSample, profile: ErrorProfile, compact = false) => {
      const produced = policyAnswer(
        item,
        register,
        drawing,
        adjacency,
        composedAt,
        profile,
        rolloutIndex,
        compact,
      );
      return {
        ...produced,
        verification: verifyAnswer(
          produced.answer.text,
          item,
          drawing,
          register,
          adjacency,
          verifyBucket,
        ),
      };
    },
    [register, drawing, adjacency, composedAt, rolloutIndex, verifyBucket],
  );
  const policy = useMemo(
    () =>
      sample && stage.id === "rl"
        ? rollout(sample, rlPolicyProfile(stage, evalProgress))
        : undefined,
    [sample, stage, evalProgress, rollout],
  );
  const teacherPolicy = useMemo(
    () =>
      sample && stage.id === "distillation"
        ? rollout(sample, teacherProfile(stage))
        : undefined,
    [sample, stage, rollout],
  );
  const studentPolicy = useMemo(
    () =>
      sample && stage.id === "distillation"
        ? rollout(sample, studentProfile(stage, evalProgress), true)
        : undefined,
    [sample, stage, evalProgress, rollout],
  );
  const provenance = sample
    ? sampleProvenance(stage, sample, rolloutIndex, drawing.source)
    : undefined;

  // Every sample's current rollout, verified: the stage-wide pass rate and reward inputs.
  const allVerifications = useMemo(
    () =>
      samples.map((item) => {
        const result =
          stage.id === "rl"
            ? rollout(item, rlPolicyProfile(stage, evalProgress)).verification
            : stage.id === "distillation"
              ? rollout(item, studentProfile(stage, evalProgress), true).verification
              : verifyAnswer(
                  groundedAnswer(item, register, composedAt).text,
                  item,
                  drawing,
                  register,
                  adjacency,
                  verifyBucket,
                );
        return {
          tag: item.tag,
          overall: Number(result.overall.toFixed(3)),
          pass: result.pass,
          checks: result.checks,
          fabricated: result.fabricated.length,
        };
      }),
    [
      samples,
      stage,
      evalProgress,
      rollout,
      register,
      composedAt,
      drawing,
      adjacency,
      verifyBucket,
    ],
  );

  const checkMeans = useMemo(() => {
    const means: Partial<Record<CheckId, number>> = {};
    if (!allVerifications.length) return means;
    for (const check of allVerifications[0]!.checks) {
      means[check.id] =
        allVerifications.reduce(
          (sum, item) => sum + (item.checks.find((c) => c.id === check.id)?.score ?? 0),
          0,
        ) / allVerifications.length;
    }
    return means;
  }, [allVerifications]);
  const fabricatedRate = allVerifications.length
    ? allVerifications.filter((item) => item.fabricated > 0).length /
      allVerifications.length
    : 0;
  const artifactSamples = useMemo(
    () => allVerifications.map(({ tag, overall, pass }) => ({ tag, overall, pass })),
    [allVerifications],
  );

  const minute = Math.floor(now / 60_000);
  const facts = useMemo(
    () => corpusFacts(drawing, register, source, drawings, corpusFiles, minute * 60_000),
    [drawing, register, source, drawings, corpusFiles, minute],
  );

  const sheet = drawing.imagePath.split("/").at(-1) ?? drawing.imagePath;
  const imageUrl =
    source === "backend"
      ? `/api/canvas/image/${encodeURIComponent(drawing.imagePath)}`
      : "/demo/main-steam.png";

  const statusChip = (
    <span
      className={styles.liveStatus}
      data-state={complete ? "done" : running ? "run" : "pause"}
    >
      <i aria-hidden="true" />
      {complete ? "Complete" : blocked ? "Blocked" : running ? "Training" : "Paused"}
    </span>
  );

  const resumeFrom = (checkpointStep: number) =>
    act((current, at) => resumeFromCheckpoint(current, stageId, checkpointStep, at));

  const checkpointsCard = (
    <CheckpointsLiveCard
      key={`checkpoints-${stage.id}`}
      {...liveProps}
      onResumeFrom={resumeFrom}
    />
  );
  const sideCard: ReactNode = (() => {
    switch (stage.id) {
      case "pretraining":
        return checkpointsCard;
      case "sft":
        return <MixtureLiveCard {...liveProps} />;
      case "rl":
        return (
          <RewardBreakdownCard
            stage={stage}
            progress={progress}
            checkMeans={checkMeans}
            fabricatedRate={fabricatedRate}
          />
        );
      case "distillation":
        return <DeploymentLiveCard {...liveProps} />;
    }
  })();

  return (
    <div className={styles.app}>
      <aside className={styles.sidebar} aria-label="Primary navigation">
        <Link href="/" className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">
            <Icon name="brand" size={18} />
          </span>
          Industrial AI
        </Link>
        <nav>
          {NAV.map((item) =>
            item.action ? (
              <button key={item.label} onClick={() => setSettingsOpen(true)}>
                <Icon name={item.icon} />
                <span>{item.label}</span>
              </button>
            ) : (
              <Link
                key={item.label}
                href={item.href!}
                aria-current={item.label === "Model Lab" ? "page" : undefined}
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
              </Link>
            ),
          )}
        </nav>
      </aside>

      <div className={styles.page}>
        <TopBar
          register={register}
          session={session}
          effective={effective}
          now={now}
          source={source}
          onSettings={() => setSettingsOpen(true)}
        />

        <main className={styles.main} id="model-lab">
          <header className={styles.stageHeader}>
            <span className={styles.stageIcon} aria-hidden="true">
              <Icon name="clipboard" size={20} />
            </span>
            <div>
              <h1>
                <span className={styles.stageNumber}>{stage.number}</span> {stage.title}
                <span className={stage.required ? styles.required : styles.optional}>
                  {stage.required ? "Required" : "Optional"}
                </span>
              </h1>
              <p>
                {stage.subtitle} · <Freshness now={now} running={running} />
              </p>
            </div>
            <div className={styles.headerActions}>
              <Link
                className={styles.secondaryButton}
                href={
                  sample ? `/canvas?node=${encodeURIComponent(sample.nodeId)}` : "/canvas"
                }
              >
                <Icon name="external" size={15} />
                Open in canvas
              </Link>
              <RunControls
                stage={stage}
                step={step}
                running={running}
                complete={complete}
                blocked={blocked}
                history={session.history}
                now={now}
                onToggle={toggleRun}
                onStop={() => act((current, at) => stopRun(current, stageId, at))}
                onResumeFrom={resumeFrom}
              />
            </div>
          </header>

          <p className={styles.truth} role="note">
            <Icon name="info" size={14} />
            <span>
              {STAGE_NOTE[stage.id]}
              {source === "demo"
                ? ` Backend offline (${offlineReason ?? "unavailable"}) — using the bundled sheet.`
                : ""}
            </span>
          </p>

          <LineageBanner lineage={lineage} stage={stage} />

          <Stepper current={stage.id} session={session} effective={effective} now={now} />

          <section className={styles.upper}>
            <div className={styles.upperLeft}>
              <div className={styles.topLeft} data-stage={stage.id}>
                <RecipeLiveCard {...liveProps} />
                <ContractLiveCard {...liveProps} facts={facts} />
              </div>
              <div className={styles.sampleSlot}>
                {sample ? (
                  <SampleStrip
                    stage={stage}
                    sample={sample}
                    samples={samples}
                    index={sampleIndex}
                    onChoose={choose}
                    autoCycle={autoCycle && running}
                    onToggleCycle={() => {
                      freezeCycle();
                      setAutoCycle((value) => !value);
                    }}
                    drawing={drawing}
                    imageUrl={imageUrl}
                    register={register}
                    answer={answer}
                    student={student}
                    verification={verification}
                    studentVerification={studentVerification}
                    now={now}
                    running={running}
                    policy={policy}
                    teacherPolicy={teacherPolicy}
                    studentPolicy={studentPolicy}
                    provenance={provenance}
                    rolloutLabel={provenance?.rolloutId}
                    cycleSecondsLeft={Math.max(
                      0,
                      Math.ceil((CYCLE_MS - (cycleElapsed % CYCLE_MS)) / 1000),
                    )}
                    cyclePeriodSeconds={CYCLE_MS / 1000}
                  />
                ) : (
                  <div className={styles.card}>
                    <p className={styles.quiet}>
                      This sheet has no registered field references, so there is no sample
                      to align.
                    </p>
                  </div>
                )}
              </div>
              <RunLogCard {...liveProps} />
            </div>
            <div className={styles.rightColumn} id="runtime">
              {stage.teacherStudent && <TeacherStudentRuntimeCard stage={stage} />}
              <RuntimeConfigCard
                {...liveProps}
                draft={draft}
                onDraft={(next) =>
                  setDrafts((current) => ({ ...current, [stageId]: next }))
                }
                onApply={() => {
                  act((current, at) => applyConfig(current, stageId, draft, at));
                  clearDraft();
                }}
                onDiscard={clearDraft}
                statusChip={statusChip}
              />
              <ProgressLiveCard
                {...liveProps}
                verifierPassRate={passRate(allVerifications)}
              />
            </div>
          </section>

          <section className={styles.analysisRow} data-stage={stage.id}>
            <MetricsLiveCard {...liveProps} />
            {stage.id === "rl" ? (
              <>
                {sideCard}
                <CurvesLiveCard {...liveProps} />
              </>
            ) : (
              <>
                <CurvesLiveCard {...liveProps} />
                {sideCard}
              </>
            )}
          </section>

          <section
            className={styles.opsRow}
            data-with-checkpoints={stage.id !== "pretraining" || undefined}
          >
            <HardwareCard {...liveProps} />
            {stage.id !== "pretraining" && checkpointsCard}
          </section>

          <ArtifactsRow
            stage={stage}
            progress={progress}
            step={step}
            sheet={sheet}
            verifications={artifactSamples}
            now={now}
            running={running}
          />
        </main>
      </div>

      {settingsOpen && (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          autoCycle={autoCycle}
          onAutoCycle={setAutoCycle}
          onReset={() => act((_current, at) => freshSession(at))}
          source={source}
          facts={facts}
        />
      )}
    </div>
  );
}

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function passRate(items: readonly { readonly pass: boolean }[]): number {
  return items.length ? items.filter((item) => item.pass).length / items.length : 0;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Stepper
// ────────────────────────────────────────────────────────────────────────────────────────────

function Stepper({
  current,
  session,
  effective,
  now,
}: {
  readonly current: StageId;
  readonly session: LabSession;
  readonly effective: Record<StageId, ReturnType<typeof effectiveStage>>;
  readonly now: number;
}) {
  return (
    <nav className={styles.stepper} aria-label="Training lifecycle stages">
      {STAGES.map((plan, index) => {
        const stage = effective[plan.id].stage;
        const step = stepAt(session.controls[stage.id], stage.run, now);
        const share = step / stage.run.totalSteps;
        const running = session.controls[stage.id].status === "running" && share < 1;
        return (
          <div key={stage.id} className={styles.stepWrap}>
            <Link
              href={`/model-lab/${stage.id}`}
              className={styles.step}
              aria-current={stage.id === current ? "page" : undefined}
            >
              <span className={styles.stepNumber}>{stage.number}</span>
              <span className={styles.stepText}>
                <strong>{stage.title}</strong>
                <small>{stage.tagline}</small>
                <span className={styles.stepBar} aria-hidden="true">
                  <i style={{ width: `${(share * 100).toFixed(1)}%` }} />
                </span>
              </span>
              <span className={styles.stepMeta}>
                <span className={stage.required ? styles.required : styles.optional}>
                  {stage.required ? "Required" : "Optional"}
                </span>
                <small data-running={running || undefined}>
                  {share >= 1
                    ? "Done"
                    : `${Math.floor(share * 100)}%${running ? " · live" : " · paused"}`}
                </small>
              </span>
            </Link>
            {index < STAGES.length - 1 && (
              <span className={styles.stepArrow} aria-hidden="true">
                <Icon name="arrow" size={16} />
              </span>
            )}
          </div>
        );
      })}
    </nav>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Top bar: breadcrumbs, tag search, checkpoint notifications, project menu
// ────────────────────────────────────────────────────────────────────────────────────────────

function TopBar({
  register,
  session,
  effective,
  now,
  source,
  onSettings,
}: {
  readonly register: ReturnType<typeof buildPlantRegister>;
  readonly session: LabSession;
  readonly effective: Record<StageId, ReturnType<typeof effectiveStage>>;
  readonly now: number;
  readonly source: "backend" | "demo";
  readonly onSettings: () => void;
}) {
  const [query, setQuery] = useState("");
  const [bellOpen, setBellOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [seenAt] = useState(() => Date.now());
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const results = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (term.length < 2) return [];
    return [...register.assets.values()]
      .filter((asset) => `${asset.tag} ${asset.name}`.toLowerCase().includes(term))
      .slice(0, 8);
  }, [query, register]);

  // Checkpoints written by any running stage since this page opened, newest first.
  const events = STAGES.flatMap((plan) => {
    const stage = effective[plan.id].stage;
    const step = stepAt(session.controls[stage.id], stage.run, now);
    return checkpoints(stage, step, 3).map((item) => ({ stage, item }));
  }).sort((a, b) => a.item.ageSeconds - b.item.ageSeconds);
  const fresh = events.filter(
    (event) => event.item.ageSeconds * 1000 < now - seenAt,
  ).length;

  return (
    <header className={styles.topbar}>
      <nav className={styles.breadcrumbs} aria-label="Breadcrumb">
        <Link href="/canvas">Canvas</Link>
        <span aria-hidden="true">›</span>
        <Link href="/model-lab/pretraining">Model Lab</Link>
        <span aria-hidden="true">›</span>
        <strong>Training Lifecycle</strong>
      </nav>

      <div className={styles.search}>
        <Icon name="search" size={15} />
        <input
          ref={input}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search assets, tags, equipment, or ask AI..."
          aria-label="Search assets and tags"
        />
        <kbd>Ctrl K</kbd>
        {results.length > 0 && (
          <ul className={styles.searchResults}>
            {results.map((asset) => (
              <li key={asset.nodeId}>
                <Link href={`/canvas?node=${encodeURIComponent(asset.nodeId)}`}>
                  <strong>{asset.tag}</strong>
                  <span>{asset.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={styles.topActions}>
        <button
          className={styles.bell}
          aria-label={`Checkpoint notifications${fresh ? `, ${fresh} new` : ""}`}
          aria-expanded={bellOpen}
          onClick={() => setBellOpen((value) => !value)}
        >
          <Icon name="bell" size={18} />
          {fresh > 0 && <b>{fresh > 9 ? "9+" : fresh}</b>}
        </button>
        {bellOpen && (
          <div
            className={styles.popover}
            role="dialog"
            aria-label="Checkpoint notifications"
          >
            <h2>Recent checkpoints</h2>
            <ul>
              {events.slice(0, 6).map(({ stage, item }) => (
                <li key={`${stage.id}-${item.step}`}>
                  <Link href={`/model-lab/${stage.id}`}>
                    <strong>
                      {stage.number} · step {item.step.toLocaleString("en-US")}
                    </strong>
                    <span>
                      val loss {item.valLoss.toFixed(3)} ·{" "}
                      {Math.round(item.ageSeconds / 60)} min ago
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
        <button
          className={styles.user}
          aria-label="Account and data source"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((value) => !value)}
        >
          <span className={styles.avatar} aria-hidden="true">
            LN
          </span>
          <span className={styles.userText}>
            <strong>User</strong>
            <small>Project: {register.site.split("/").at(-1)}</small>
          </span>
          <Icon name="chevron" size={14} />
        </button>
        {menuOpen && (
          <div className={`${styles.popover} ${styles.menu}`} role="menu">
            <p>
              Data source:{" "}
              <strong>{source === "backend" ? "Backend corpus" : "Offline fixture"}</strong>
            </p>
            <p>
              Site: <strong>{register.site}</strong>
            </p>
            <button role="menuitem" onClick={onSettings}>
              Lab settings
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

function SettingsDialog({
  onClose,
  autoCycle,
  onAutoCycle,
  onReset,
  source,
  facts,
}: {
  readonly onClose: () => void;
  readonly autoCycle: boolean;
  readonly onAutoCycle: (value: boolean) => void;
  readonly onReset: () => void;
  readonly source: "backend" | "demo";
  readonly facts: ReturnType<typeof corpusFacts>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      onClose={onClose}
      aria-labelledby="lab-settings"
    >
      <h2 id="lab-settings">Lab settings</h2>
      <label className={styles.toggle}>
        <input
          type="checkbox"
          checked={autoCycle}
          onChange={(event) => onAutoCycle(event.target.checked)}
        />
        Cycle samples every 15 s while a stage runs
      </label>
      <button
        onClick={() => {
          onReset();
          dialog.current?.close();
        }}
      >
        Reset all simulated runs to their opening step
      </button>
      <dl>
        <div>
          <dt>Data source</dt>
          <dd>{source === "backend" ? "Backend corpus" : "Offline fixture"}</dd>
        </div>
        <div>
          <dt>Drawing pairs in corpus</dt>
          <dd>{facts.drawings ?? "Unknown (backend offline)"}</dd>
        </div>
        <div>
          <dt>Served artifacts</dt>
          <dd>{facts.corpusFiles ?? "Unknown (backend offline)"}</dd>
        </div>
        <div>
          <dt>Tags on this sheet</dt>
          <dd>{facts.equipment}</dd>
        </div>
      </dl>
      <button className={styles.primaryButton} onClick={() => dialog.current?.close()}>
        Done
      </button>
    </dialog>
  );
}
