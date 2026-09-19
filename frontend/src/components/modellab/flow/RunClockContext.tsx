"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { RunConfig, RunProfile } from "@/lib/modellab/config";
import type { RunControl } from "@/lib/modellab/run";
import type { Stage } from "@/lib/modellab/stages";

/**
 * The run clock of the stage on screen: its session control (step, time and replay speed),
 * the effective stage, and the configuration and profile its telemetry is computed from.
 * A figure that shows the run live derives the exact fractional step from this with
 * `stepAt`, so it agrees with the run console to the frame.
 */
export interface RunClock {
  readonly control: RunControl;
  readonly stage: Stage;
  readonly profile: RunProfile;
  readonly config: RunConfig;
  /** The page clock, epoch ms, advancing once per second. */
  readonly now: number;
  /** The stage cannot run yet (its input checkpoint does not exist): step 0. */
  readonly blocked: boolean;
}

const RunClockContext = createContext<RunClock | undefined>(undefined);

export function RunClockProvider({
  control,
  stage,
  profile,
  config,
  now,
  blocked = false,
  children,
}: RunClock & { readonly children: ReactNode }) {
  const value = useMemo(
    () => ({ control, stage, profile, config, now, blocked }),
    [control, stage, profile, config, now, blocked],
  );
  return <RunClockContext.Provider value={value}>{children}</RunClockContext.Provider>;
}

/** The run clock, or undefined outside a provider (the figure then draws statically). */
export function useRunClock(): RunClock | undefined {
  return useContext(RunClockContext);
}
