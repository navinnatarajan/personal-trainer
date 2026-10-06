/**
 * The shape of what the coach knows.
 *
 * The Claude API is stateless: it remembers nothing between calls. Everything that makes
 * the coach feel like it knows the user is assembled here, per call. This file is
 * therefore the contract for "knowing someone" — if a fact isn't in these types, the
 * coach cannot act on it, no matter what is in the database.
 *
 * Two principles run through it:
 *
 *  1. Derived over raw. 155 set rows bury the signal; "Lat Pulldown stuck at 120 for
 *     three weeks" is one line and is the whole insight.
 *  2. Everything carries a date. A constraint raised a month ago and never repeated is
 *     weaker evidence than one raised this week, and the model can only weigh that if it
 *     is told when things were said.
 */

import type { ProgressionState } from "../types";

// ---------------------------------------------------------------------------
// Layers that are asked
// ---------------------------------------------------------------------------

/** Set once, never changes. */
export interface IdentityFacts {
  sex: "male" | "female" | "prefer_not_to_say" | null;
  heightIn: number | null;
  /** Birth year rather than age, so it cannot go stale. */
  birthYear: number | null;
}

/**
 * What the gym has. A hard gate: anything not available is never programmed, however
 * well it would fit. A plan containing a lift you cannot load is worse than a slightly
 * worse plan.
 */
export interface EnvironmentFacts {
  gymType: "full" | "limited" | "home_basics" | null;
  equipment: string[];
  gymName: string | null;
}

/**
 * Durable preferences. Distinct from environment: these bias selection rather than
 * gating it. "Mostly machines" should tilt the choice, not delete every free-weight lift.
 */
export interface PreferenceFacts {
  stylePreference: "machines" | "mix" | "free_weights" | null;
  /** Exercise names the user has ruled out. Their history is kept; they are not programmed. */
  excluded: string[];
  favourites: string[];
  /** Equipment gaps, standing injuries, anything true until changed. */
  durableConstraints: string | null;
}

/**
 * Goals in priority order. Order is load-bearing: losing fat and building muscle pull
 * against each other, and a flat list gives the model no way to arbitrate, so it splits
 * the difference and serves neither.
 */
export interface GoalFacts {
  ordered: string[];
  lifecycleStage: string;
  trainingLevel: string;
}

/** What the user says they can do. Compare against ObservedBehaviour, which is the truth. */
export interface StatedAvailability {
  days: Array<{ dow: number; durationMin: number | null }>;
  checkinDow: number;
}

// ---------------------------------------------------------------------------
// Layers that are measured or derived — never asked
// ---------------------------------------------------------------------------

export interface MeasuredState {
  weightLbs: number | null;
  /** Daily weight is water and salt; the average is the number worth reading. */
  weightTrend7d: number | null;
  weightChange30d: number | null;
  waistIn: number | null;
  /** Waist / height. Under 0.5 is the common lean threshold, and unlike BMI it does not
   *  punish height or muscle. */
  waistToHeight: number | null;
  asOf: string | null;
}

/**
 * What the logs say, as opposed to what the user said.
 *
 * This is the layer that separates a coach from a template. Stated and observed
 * behaviour always diverge — someone who says "four days a week" may be training 2.2 —
 * and an assistant that trusts the stated version is agreeing with a self-image rather
 * than responding to a life.
 */
export interface ObservedBehaviour {
  sessionsPerWeek: number;
  /** Planned vs completed over the window, per weekday. Exposes the wrong training day. */
  byWeekday: Array<{ dow: number; planned: number; completed: number; missed: number }>;
  /** Planned vs completed per session type. Exposes the systematically skipped session. */
  bySessionType: Array<{ name: string; planned: number; completed: number }>;
  /** Median actual minutes against the budget. Null while nothing has been timed. */
  medianSessionMin: number | null;
  budgetedSessionMin: number | null;
  daysSinceLastSession: number | null;
  totalSessions: number;
}

// ---------------------------------------------------------------------------
// Episodic — written by the system, about the system
// ---------------------------------------------------------------------------

/**
 * An instruction the coach gave that the logs show was not met.
 *
 * The highest-value line in the whole context. A coach that cannot see its own unmet
 * instruction writes it a third time, and that third repetition is the exact moment a
 * user concludes the thing is not listening.
 */
export interface UnmetInstruction {
  exercise: string;
  instruction: string;
  weeksOutstanding: number;
  /** What actually happened, e.g. "120 x 12/12/10 in both weeks". */
  outcome: string;
}

/** Something the coach changed that worked, and should therefore be kept. */
export interface StandingAdjustment {
  what: string;
  sinceWeek: number;
  outcome: string;
}

/**
 * Something the user said, with when they said it.
 *
 * Recency is the point. An unrepeated constraint decays — four silent weeks about a
 * shoulder probably means it healed — but decay must never be silent: the check-in asks
 * rather than assuming, which is what the consolidation pass is for.
 */
export interface DatedStatement {
  weekNumber: number;
  weeksAgo: number;
  text: string;
  /** False once a later check-in has superseded or dropped it. */
  stillCurrent: boolean;
}

export interface EpisodicMemory {
  unmetInstructions: UnmetInstruction[];
  standingAdjustments: StandingAdjustment[];
  statementsRaised: DatedStatement[];
  /** Verbatim notes from the most recent week only. Four weeks of prose invites the model
   *  to recycle its own phrasing and buries the unmet instruction among dozens of lines. */
  lastWeekNotes: Array<{ session: string; exercise: string | null; note: string }>;
}

// ---------------------------------------------------------------------------
// Assembled
// ---------------------------------------------------------------------------

export interface CoachContext {
  identity: IdentityFacts;
  environment: EnvironmentFacts;
  preferences: PreferenceFacts;
  goals: GoalFacts;
  stated: StatedAvailability;
  measured: MeasuredState;
  observed: ObservedBehaviour;
  episodic: EpisodicMemory;
  /** Computed by lib/progression.ts. Facts, not judgements — the model is told these. */
  progression: ProgressionState[];
  /** Exercises available to program: in the library, not excluded, equipment present. */
  programmable: Array<{
    name: string;
    muscleGroup: string;
    unit: string;
    incrementLbs: number;
    preference: string;
    hasHistory: boolean;
  }>;
  /** How many weeks of behaviour the observed and episodic layers cover. */
  windowWeeks: number;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Consolidation — the write-back half
// ---------------------------------------------------------------------------

/**
 * A proposed change to the stored profile, extracted from what the user has said.
 *
 * Never applied silently. The failure mode this guards against is an offhand remark
 * permanently rewriting a goal; the second failure mode is a silent correct update,
 * which earns no trust because the user never sees it happen. So: propose, show, confirm.
 */
export interface ProfileProposal {
  field:
    | "excluded_exercise"
    | "favourite_exercise"
    | "durable_constraints"
    | "equipment"
    | "goals"
    | "day_preference"
    | "style_preference";
  /** Human-readable summary of the change, shown to the user for confirmation. */
  summary: string;
  /** The value to write if confirmed. Shape depends on `field`. */
  value: unknown;
  /** Why this is being proposed — quoted evidence, not inference. */
  evidence: string;
  /** How many separate occasions support it. One mention is weak; three is a pattern. */
  occurrences: number;
}
