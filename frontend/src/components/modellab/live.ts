/**
 * The contract every live model-lab card is rendered with.
 *
 * `stage` is the EFFECTIVE stage: its `run.stepsPerSecond` and `experimentId` already reflect
 * the applied run configuration, so any function in `@/lib/modellab/run` given this stage
 * (checkpoints, bestCheckpoint, …) produces figures consistent with the selected hardware.
 * `now` ticks once per second while the tab is visible. Everything shown must be a pure
 * function of these props (plus local UI state), so two viewers at the same moment agree and
 * a paused run is frozen everywhere.
 */

import type { RunConfig, RunProfile } from "@/lib/modellab/config";
import type { Stage } from "@/lib/modellab/stages";

export interface LiveCardProps {
  readonly stage: Stage;
  /** Current global step, fractional. */
  readonly step: number;
  /** step / stage.run.totalSteps, 0–1. */
  readonly progress: number;
  /** Epoch ms, advancing once per second. */
  readonly now: number;
  /** True while the stage is training (not paused, not complete). */
  readonly running: boolean;
  /** The configuration the run is currently using. */
  readonly config: RunConfig;
  /** Planning estimate derived from `config`. */
  readonly profile: RunProfile;
}
