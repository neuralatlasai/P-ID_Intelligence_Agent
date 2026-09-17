import { describe, expect, it } from "vitest";

import {
  checkpointDigest,
  checkpointLifecycle,
  checkpointUri,
  EVAL_SECONDS,
  evalEvery,
  filterEvents,
  matchesFilter,
  nextEvents,
  runEvents,
  WRITE_WINDOW_SECONDS,
  type EventFilter,
} from "@/lib/modellab/events";
import { STAGES, type Stage } from "@/lib/modellab/stages";

/**
 * The run event log is derived from the step timeline. These tests pin that it is a pure
 * function of (stage, step), that checkpoint events land on the configured cadence, and that
 * wall-clock durations stay wall-clock whatever the throughput.
 */

const NOW = Date.UTC(2026, 8, 16, 15, 0, 0);
const pretraining = STAGES.find((stage) => stage.id === "pretraining")!;
/** 33B on 24×H100: a realistically slow run. */
const slow: Stage = { ...pretraining, run: { ...pretraining.run, stepsPerSecond: 0.036 } };

describe("runEvents", () => {
  it("is deterministic", () => {
    for (const stage of [...STAGES, slow]) {
      const step = stage.run.openingStep + 123.4;
      const a = runEvents(stage, step, NOW, stage.run.stepsPerSecond, 20);
      const b = runEvents(stage, step, NOW, stage.run.stepsPerSecond, 20);
      expect(a).toEqual(b);
      expect(a.length).toBe(20);
      expect(new Set(a.map((event) => event.id)).size).toBe(a.length);
    }
  });

  it("returns newest first, none after the current step, and dates them from the rate", () => {
    const step = slow.run.openingStep;
    const events = runEvents(slow, step, NOW, 0.036, 30);
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index]!.step).toBeLessThanOrEqual(events[index - 1]!.step);
    }
    for (const event of events) {
      expect(event.step).toBeLessThanOrEqual(step);
      expect(event.ageSeconds).toBeCloseTo((step - event.step) / 0.036, 6);
      expect(event.atEpoch).toBeCloseTo(NOW - event.ageSeconds * 1000, 3);
    }
  });

  it("matches the newest events of a much longer listing", () => {
    const step = pretraining.run.openingStep;
    const rate = pretraining.run.stepsPerSecond;
    const short = runEvents(pretraining, step, NOW, rate, 8);
    const long = runEvents(pretraining, step, NOW, rate, 400);
    expect(short).toEqual(long.slice(0, 8));
  });

  it("aligns checkpoint writes and evaluations with their cadence", () => {
    for (const stage of STAGES) {
      const { run } = stage;
      const rate = run.stepsPerSecond;
      const events = runEvents(stage, run.openingStep, NOW, rate, 500);
      const writes = events.filter((event) => event.kind === "checkpoint-written");
      expect(writes.length).toBeGreaterThan(0);
      for (const write of writes) expect(write.step % run.checkpointEvery).toBe(0);
      for (const verified of events.filter((e) => e.kind === "checkpoint-verified")) {
        const boundary = verified.step - WRITE_WINDOW_SECONDS * rate;
        expect(
          Math.abs(
            boundary / run.checkpointEvery - Math.round(boundary / run.checkpointEvery),
          ),
        ).toBeLessThan(1e-6);
      }
      for (const evaluation of events.filter((e) => e.kind === "eval")) {
        const boundary = evaluation.step - EVAL_SECONDS * rate;
        const ratio = boundary / evalEvery(stage);
        expect(Math.abs(ratio - Math.round(ratio))).toBeLessThan(1e-6);
      }
    }
  });

  it("freezes while paused: the same step gives the same events at any later time", () => {
    const step = slow.run.openingStep + 57;
    const before = runEvents(slow, step, NOW, 0.036, 12);
    const later = runEvents(slow, step, NOW + 3_600_000, 0.036, 12);
    const strip = (list: typeof before) =>
      list.map(({ id, step: at, kind, message, severity, ageSeconds }) => ({
        id,
        at,
        kind,
        message,
        severity,
        ageSeconds,
      }));
    expect(strip(later)).toEqual(strip(before));
  });

  it("filters by warnings, checkpoints and evals", () => {
    const step = pretraining.run.openingStep;
    const rate = pretraining.run.stepsPerSecond;
    const all = runEvents(pretraining, step, NOW, rate, 2000);
    expect(all.some((event) => event.severity === "warn")).toBe(true);
    const filters: EventFilter[] = ["warnings", "checkpoints", "evals"];
    for (const filter of filters) {
      const filtered = runEvents(pretraining, step, NOW, rate, 10, { filter });
      expect(filtered.length).toBe(Math.min(10, filterEvents(all, filter).length));
      expect(filtered.length).toBeGreaterThan(0);
      expect(filtered.every((event) => matchesFilter(event, filter))).toBe(true);
      expect(filtered).toEqual(filterEvents(all, filter).slice(0, 10));
    }
    expect(filterEvents(all, "warnings").every((event) => event.severity === "warn")).toBe(
      true,
    );
    expect(
      filterEvents(all, "checkpoints").every((event) =>
        event.kind.startsWith("checkpoint"),
      ),
    ).toBe(true);
    expect(filterEvents(all, "evals").every((event) => event.kind === "eval")).toBe(true);
    expect(filterEvents(all, "all")).toEqual(all);
  });

  it("never reports a confidence figure", () => {
    for (const stage of STAGES) {
      const events = runEvents(
        stage,
        stage.run.totalSteps,
        NOW,
        stage.run.stepsPerSecond,
        300,
      );
      for (const event of events) expect(event.message).not.toMatch(/confidence\s*[\d.]/i);
    }
  });
});

describe("nextEvents", () => {
  it("schedules the next checkpoint and evaluation with ETAs from the rate", () => {
    const step = 68_500;
    const upcoming = nextEvents(slow, step, NOW, 0.036);
    const checkpoint = upcoming.find((item) => item.kind === "checkpoint")!;
    expect(checkpoint.step).toBe(70_000);
    expect(checkpoint.etaSeconds).toBeCloseTo(1500 / 0.036, 6);
    const evaluation = upcoming.find((item) => item.kind === "eval")!;
    expect(evaluation.etaSeconds).toBeGreaterThan(0);
    for (let index = 1; index < upcoming.length; index += 1) {
      expect(upcoming[index]!.etaSeconds).toBeGreaterThanOrEqual(
        upcoming[index - 1]!.etaSeconds,
      );
    }
    expect(nextEvents(slow, slow.run.totalSteps, NOW, 0.036)).toEqual([]);
  });
});

describe("checkpointLifecycle", () => {
  it("keeps the writing window at five wall-clock minutes whatever the step rate", () => {
    for (const rate of [0.036, 1.6, 6]) {
      const stage: Stage = {
        ...pretraining,
        run: { ...pretraining.run, stepsPerSecond: rate },
      };
      const boundary = 68_000;
      const at = (seconds: number) =>
        checkpointLifecycle(stage, boundary + seconds * rate, rate, NOW);
      expect(at(1).writing?.step).toBe(boundary);
      expect(at(1).writing?.phase).toBe("serialize");
      expect(at(120).writing?.phase).toBe("upload");
      expect(at(WRITE_WINDOW_SECONDS - 1).writing?.phase).toBe("verify");
      expect(at(WRITE_WINDOW_SECONDS + 1).writing).toBeUndefined();
      expect(at(WRITE_WINDOW_SECONDS + 1).records[0]?.step).toBe(boundary);
      expect(at(1).records[0]?.step).toBe(boundary - stage.run.checkpointEvery);
    }
  });

  it("describes completed checkpoints with status, URI and a simulated digest", () => {
    const life = checkpointLifecycle(slow, 68_000 + 3600 * 0.036, 0.036, NOW);
    const newest = life.records[0]!;
    expect(newest.uri).toBe(`s3://pid-lab/${slow.experimentId}/step-068000/`);
    expect(checkpointUri(slow, 68_000)).toBe(newest.uri);
    expect(newest.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(checkpointDigest(slow, 68_000)).toBe(newest.digest);
    expect(newest.evalScore).toBeDefined();
    expect(life.records.filter((record) => record.best)).toHaveLength(1);
    expect(life.best?.status).toBe("Best");
    expect(life.next?.step).toBe(70_000);

    const fresh = checkpointLifecycle(slow, 68_000 + 400 * 0.036, 0.036, NOW).records[0]!;
    expect(fresh.evalScore).toBeUndefined();
    expect(["Verified", "Best"]).toContain(fresh.status);
  });
});

describe("live cards", () => {
  it("render for every stage without throwing", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { DEFAULT_CONFIG, runProfile } = await import("@/lib/modellab/config");
    const { ProgressLiveCard } = await import("@/components/modellab/ProgressLiveCard");
    const { CheckpointsLiveCard } =
      await import("@/components/modellab/CheckpointsLiveCard");
    const { RunLogCard } = await import("@/components/modellab/RunLogCard");
    for (const base of STAGES) {
      const config = DEFAULT_CONFIG[base.id];
      const profile = runProfile(base.id, config);
      const stage: Stage = {
        ...base,
        run: { ...base.run, stepsPerSecond: profile.stepsPerSecond },
      };
      const step = base.run.openingStep;
      const props = {
        stage,
        step,
        progress: step / stage.run.totalSteps,
        now: NOW,
        running: true,
        config,
        profile,
      };
      const html = [
        renderToStaticMarkup(
          createElement(ProgressLiveCard, { ...props, verifierPassRate: 0.8 }),
        ),
        renderToStaticMarkup(createElement(CheckpointsLiveCard, props)),
        renderToStaticMarkup(createElement(RunLogCard, props)),
      ].join("");
      expect(html).toContain("Simulated");
      expect(html).not.toMatch(/confidence\s*[\d.]/i);
    }
  });
});
