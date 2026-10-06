/**
 * Double progression.
 *
 * The rule, verbatim from the `Start Here` sheet of the original tracker:
 *
 *   "Hit the TOP of the rep range on EVERY working set -> add the smallest increment
 *    next session. Until then, add reps, not weight."
 *
 * This is a deterministic rule, not a judgment call, so it lives in code where it can be
 * unit-tested. The model is handed the *result* as fact and never asked to decide it.
 *
 * Pure module: no I/O, no database, no clock.
 */

import type {
  Exercise,
  ExerciseSession,
  ExerciseTarget,
  ProgressionState,
} from "./types";

export interface RepRange {
  bottom: number;
  top: number;
  /** True for ranges like "10+", where the number is a floor rather than a cap. */
  openEnded: boolean;
}

/**
 * Parses the rep-range notations used in the tracker: "8", "6-8", "10+", "8+".
 * Throws on anything unrecognised — a malformed range must fail loudly rather than
 * silently produce a progression decision from a misread target.
 */
export function parseRepRange(input: string): RepRange {
  const raw = input.trim();

  const range = raw.match(/^(\d+)\s*-\s*(\d+)$/);
  if (range) {
    const bottom = Number(range[1]);
    const top = Number(range[2]);
    if (bottom > top) {
      throw new Error(`Rep range "${input}" has its bounds reversed`);
    }
    return { bottom, top, openEnded: false };
  }

  const open = raw.match(/^(\d+)\s*\+$/);
  if (open) {
    const n = Number(open[1]);
    return { bottom: n, top: n, openEnded: true };
  }

  const exact = raw.match(/^(\d+)$/);
  if (exact) {
    const n = Number(exact[1]);
    return { bottom: n, top: n, openEnded: false };
  }

  throw new Error(`Unrecognised rep range: "${input}"`);
}

/** Epley estimated 1RM, matching the original spreadsheet's formula exactly. */
export function epley1RM(weightLbs: number, reps: number): number {
  return weightLbs * (1 + reps / 30);
}

export function volume(weightLbs: number, reps: number): number {
  return weightLbs * reps;
}

/**
 * True only when every working set reached the top of the range.
 *
 * Deliberately conservative: a set with missing or zero reps counts as *not* hitting the
 * top, so incomplete logging can never trigger a weight increase. The historical data
 * contains exactly this case ("set 3 done but rep count not reported"). Failing to
 * progress is recoverable next session; progressing on data that was never confirmed
 * means lifting a weight you haven't earned.
 */
export function hitTopOfRange(
  sets: ReadonlyArray<{ reps: number | null }>,
  top: number,
): boolean {
  if (sets.length === 0) return false;
  return sets.every((s) => typeof s.reps === "number" && s.reps >= top);
}

/** Most recent session for an exercise, or undefined when there's no history. */
export function mostRecentSession(
  history: ReadonlyArray<ExerciseSession>,
  exerciseId: string,
): ExerciseSession | undefined {
  return history
    .filter((s) => s.exerciseId === exerciseId && s.sets.length > 0)
    .reduce<ExerciseSession | undefined>(
      (latest, s) =>
        !latest || s.date.getTime() > latest.date.getTime() ? s : latest,
      undefined,
    );
}

/**
 * Decides what to prescribe next for one exercise.
 *
 * `history` may contain sessions for any exercise; only those matching
 * `exercise.id` are considered.
 */
export function progressionState(
  history: ReadonlyArray<ExerciseSession>,
  exercise: Exercise,
  target: ExerciseTarget,
): ProgressionState {
  const last = mostRecentSession(history, exercise.id);

  // No history: prescribe the baseline and gather data before progressing anything.
  if (!last) {
    return {
      exerciseId: exercise.id,
      action: "establish_baseline",
      nextWeight: target.baselineWeight ?? 0,
      nextTargetReps: "8",
      reason: target.baselineWeight
        ? `No sets logged yet. Start at the ${target.baselineWeight} lb baseline and establish a reference.`
        : `No sets logged and no baseline set. Work up to a weight that leaves 1-2 reps in reserve and log it.`,
    };
  }

  const range = parseRepRange(last.targetReps);
  const topWeight = Math.max(...last.sets.map((s) => s.weightLbs));
  const repsPerSet = last.sets
    .slice()
    .sort((a, b) => a.setNumber - b.setNumber)
    .map((s) => s.reps ?? 0)
    .join("/");
  const cleared = hitTopOfRange(last.sets, range.top);

  // Bodyweight exercises have no weight to add — progression is reps (or sets) only.
  if (exercise.unit === "BW") {
    return {
      exerciseId: exercise.id,
      action: "add_reps",
      nextWeight: 0,
      nextTargetReps: last.targetReps,
      reason: cleared
        ? `Bodyweight: cleared ${range.top} on every set (${repsPerSet}). Add reps or a set — there's no weight to add.`
        : `Bodyweight: ${repsPerSet} against a target of ${last.targetReps}. Keep pushing reps.`,
    };
  }

  if (cleared) {
    const nextWeight = topWeight + exercise.incrementLbs;
    return {
      exerciseId: exercise.id,
      action: "add_weight",
      nextWeight,
      nextTargetReps: last.targetReps,
      reason: `Hit ${range.top} on every set at ${topWeight} lb (${repsPerSet}). Earned the jump to ${nextWeight} lb.`,
    };
  }

  return {
    exerciseId: exercise.id,
    action: "add_reps",
    nextWeight: topWeight,
    nextTargetReps: last.targetReps,
    reason: `${repsPerSet} at ${topWeight} lb against a target of ${last.targetReps}. Stay at ${topWeight} lb until every set reaches ${range.top}.`,
  };
}

/** Convenience: progression state for a whole exercise library in one pass. */
export function progressionStates(
  history: ReadonlyArray<ExerciseSession>,
  exercises: ReadonlyArray<Exercise>,
  targets: ReadonlyArray<ExerciseTarget>,
): ProgressionState[] {
  const targetById = new Map(targets.map((t) => [t.exerciseId, t]));
  return exercises.map((ex) =>
    progressionState(history, ex, targetById.get(ex.id) ?? {
      exerciseId: ex.id,
      baselineWeight: null,
      nextTarget: null,
    }),
  );
}
