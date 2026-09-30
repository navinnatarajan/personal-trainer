/** Weight units as they appear in the source tracker. */
export type Unit = "lb" | "/side" | "BW";

export type SessionStatus = "active" | "paused" | "completed" | "abandoned";

export interface Exercise {
  id: string;
  name: string;
  muscleGroup: string;
  equipment: string | null;
  unit: Unit;
  /** Smallest weight jump available for this exercise: DB 2.5, BB 5, machines vary. */
  incrementLbs: number;
}

export interface ExerciseTarget {
  exerciseId: string;
  baselineWeight: number | null;
  nextTarget: number | null;
}

export interface SetLog {
  id: string;
  sessionId: string;
  exerciseId: string;
  setNumber: number;
  weightLbs: number;
  reps: number;
  /** Reps in reserve. Null when not reported — common in the historical data. */
  rir: number | null;
  loggedAt: Date;
}

/**
 * One exercise's working sets within a single session, plus the rep range that was
 * prescribed. The rep range is required to judge progression: "8 reps" only means
 * "top of range" relative to a target.
 */
export interface ExerciseSession {
  exerciseId: string;
  date: Date;
  /** As prescribed, e.g. "8", "6-8", "10+". */
  targetReps: string;
  sets: Array<Pick<SetLog, "setNumber" | "weightLbs" | "reps" | "rir">>;
}

export type ProgressionAction =
  | "add_weight"
  | "add_reps"
  /** No history for this exercise — use the baseline and establish one. */
  | "establish_baseline";

export interface ProgressionState {
  exerciseId: string;
  action: ProgressionAction;
  /** Weight to prescribe next session. */
  nextWeight: number;
  /** Rep range to prescribe next session. */
  nextTargetReps: string;
  /** Human-readable justification, passed to the model as fact. */
  reason: string;
}
