/**
 * Assembles the CoachContext from the database.
 *
 * The only impure part of lib/coach: it queries, then hands everything to the pure
 * functions in derive.ts and progression.ts. Keeping the queries here and the reasoning
 * there is what makes the reasoning testable without a database.
 *
 * Every query is scoped to one user and runs through a Supabase client carrying that
 * user's session, so row-level security applies. Nothing here should ever use the
 * service-role key.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { progressionStates } from "../progression";
import type { Exercise, ExerciseSession, ExerciseTarget, Unit } from "../types";
import {
  type BodyMetricRow,
  type PriorInstruction,
  type SessionRow,
  deriveMeasuredState,
  deriveObservedBehaviour,
  deriveUnmetInstructions,
  markStatementRecency,
} from "./derive";
import type { CoachContext, EpisodicMemory } from "./types";

/** How far back the observed and episodic layers look. */
export const WINDOW_WEEKS = 4;

/**
 * Today's date in a given timezone, as YYYY-MM-DD.
 *
 * Never use `new Date().toISOString().slice(0, 10)` for this. That is UTC, so for the
 * hours between local midnight and UTC midnight it returns tomorrow — which silently
 * shifts the history window and can make the app disagree about which day "today" is.
 * Every user has `profiles.timezone` for this reason.
 */
export function todayInTimezone(timeZone: string, now = new Date()): string {
  // en-CA formats as YYYY-MM-DD, which is what we want.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export interface AssembleOptions {
  userId: string;
  /**
   * Today, as YYYY-MM-DD. Optional: when omitted it is computed from the profile's
   * timezone, which is almost always what you want. Pass it explicitly only to make a
   * call deterministic, as the tests do.
   */
  today?: string;
  /** The week number the upcoming plan will carry. */
  currentWeek: number;
  windowWeeks?: number;
}

export async function assembleCoachContext(
  db: SupabaseClient,
  opts: AssembleOptions,
): Promise<CoachContext> {
  const { userId, currentWeek } = opts;
  const windowWeeks = opts.windowWeeks ?? WINDOW_WEEKS;

  // Fetched together; they are independent and the round trips add up on a phone.
  const [profileRes, dayPrefRes, exerciseRes, sessionRes, bodyRes, weekRes, checkinRes] =
    await Promise.all([
      db
        .from("profiles")
        .select(
          "display_name, goals, lifecycle_stage, training_level, height_in, weight_lbs, sex, birth_year, equipment, gym_name, durable_constraints, checkin_dow, timezone",
        )
        .eq("id", userId)
        .maybeSingle(),

      db.from("day_preferences").select("dow, can_train, duration_min").eq("user_id", userId),

      db
        .from("exercises")
        .select(
          "id, name, muscle_group, unit, increment_lbs, preference, equipment, exercise_targets(baseline_weight, next_target)",
        )
        .eq("user_id", userId),

      // Sessions with their sets. One query rather than N+1 per exercise.
      db
        .from("sessions")
        .select(
          "id, date, session_name, status, active_ms, set_logs(exercise_id, set_number, weight_lbs, reps, rir)",
        )
        .eq("user_id", userId)
        .order("date", { ascending: true }),

      db
        .from("body_metrics")
        .select("date, weight_lbs, bodyfat_pct, waist_in")
        .eq("user_id", userId)
        .order("date", { ascending: true }),

      // Recent generated plans, for the episodic layer.
      db
        .from("week_plans")
        .select("week_number, starts_on, headline, raw_plan")
        .eq("user_id", userId)
        .order("week_number", { ascending: false })
        .limit(windowWeeks),

      db
        .from("checkins")
        .select("week_number, user_constraints, ai_summary")
        .eq("user_id", userId)
        .order("week_number", { ascending: false })
        .limit(windowWeeks),
    ]);

  for (const res of [profileRes, dayPrefRes, exerciseRes, sessionRes, bodyRes, weekRes, checkinRes]) {
    if (res.error) throw res.error;
  }

  const profile = profileRes.data;
  if (!profile) {
    throw new Error(`No profile for user ${userId}. Onboarding has not been completed.`);
  }

  // The user's local date, not the server's and not UTC.
  const today = opts.today ?? todayInTimezone(profile.timezone ?? "UTC");

  // --- exercise library -----------------------------------------------------

  type ExRow = {
    id: string;
    name: string;
    muscle_group: string;
    unit: string;
    increment_lbs: number | string;
    preference: string;
    equipment: string | null;
    exercise_targets: Array<{ baseline_weight: number | null; next_target: number | null }>;
  };
  const exRows = (exerciseRes.data ?? []) as unknown as ExRow[];

  const exercises: Exercise[] = exRows.map((r) => ({
    id: r.id,
    name: r.name,
    muscleGroup: r.muscle_group,
    equipment: r.equipment,
    unit: r.unit as Unit,
    incrementLbs: Number(r.increment_lbs),
  }));

  const targets: ExerciseTarget[] = exRows.map((r) => ({
    exerciseId: r.id,
    baselineWeight: num(r.exercise_targets?.[0]?.baseline_weight),
    nextTarget: num(r.exercise_targets?.[0]?.next_target),
  }));

  const nameById = new Map(exRows.map((r) => [r.id, r.name]));
  const excluded = exRows.filter((r) => r.preference === "excluded").map((r) => r.name);
  const favourites = exRows.filter((r) => r.preference === "favourite").map((r) => r.name);

  // --- sessions and sets ----------------------------------------------------

  type SessRow = {
    id: string;
    date: string;
    session_name: string | null;
    status: string;
    active_ms: number | string | null;
    set_logs: Array<{
      exercise_id: string;
      set_number: number;
      weight_lbs: number | string;
      reps: number | null;
      rir: number | null;
    }>;
  };
  const sessRows = (sessionRes.data ?? []) as unknown as SessRow[];

  const sessionRowsForDerive: SessionRow[] = sessRows.map((s) => ({
    date: s.date,
    sessionName: s.session_name,
    status: s.status,
    activeMs: num(s.active_ms),
    plannedDurationMin: null,
  }));

  // One ExerciseSession per (session, exercise), which is the shape progression wants.
  const exerciseSessions: ExerciseSession[] = [];
  for (const s of sessRows) {
    if (s.status !== "completed") continue;
    const byExercise = new Map<string, SessRow["set_logs"]>();
    for (const set of s.set_logs ?? []) {
      const list = byExercise.get(set.exercise_id) ?? [];
      list.push(set);
      byExercise.set(set.exercise_id, list);
    }
    for (const [exerciseId, sets] of byExercise) {
      exerciseSessions.push({
        exerciseId,
        date: new Date(`${s.date}T00:00:00Z`),
        // The prescribed range is not stored on the log, so it is reconstructed from what
        // was achieved. Imperfect for imported history; planned_exercises supplies the
        // real target once plans are generated by the app.
        targetReps: inferTargetReps(sets),
        sets: sets.map((x) => ({
          setNumber: x.set_number,
          weightLbs: Number(x.weight_lbs),
          reps: x.reps,
          rir: x.rir,
        })),
      });
    }
  }

  // --- derived layers -------------------------------------------------------

  const dayPrefs = (dayPrefRes.data ?? []) as Array<{
    dow: number;
    can_train: boolean;
    duration_min: number | null;
  }>;
  const trainingDays = dayPrefs.filter((d) => d.can_train);

  // The most common budget across training days: what "a normal session" means here.
  const budgeted = modeOf(
    trainingDays.map((d) => d.duration_min).filter((d): d is number => d !== null),
  );

  const observed = deriveObservedBehaviour(
    sessionRowsForDerive,
    today,
    windowWeeks,
    budgeted,
  );

  // PostgREST returns snake_case; the derivation layer speaks camelCase.
  const bodyRows: BodyMetricRow[] = (
    (bodyRes.data ?? []) as Array<{
      date: string;
      weight_lbs: number | string | null;
      bodyfat_pct: number | string | null;
      waist_in: number | string | null;
    }>
  ).map((r) => ({
    date: r.date,
    weightLbs: num(r.weight_lbs),
    bodyfatPct: num(r.bodyfat_pct),
    waistIn: num(r.waist_in),
  }));

  const measured = deriveMeasuredState(bodyRows, today, num(profile.height_in));

  const progression = progressionStates(exerciseSessions, exercises, targets);

  // --- episodic layer -------------------------------------------------------

  const weekPlans = (weekRes.data ?? []) as Array<{
    week_number: number;
    starts_on: string;
    headline: string | null;
    raw_plan: unknown;
  }>;

  const checkins = (checkinRes.data ?? []) as Array<{
    week_number: number;
    user_constraints: unknown;
    ai_summary: string | null;
  }>;

  const statementsRaised = markStatementRecency(
    checkins.flatMap((c) => extractStatements(c.week_number, c.user_constraints)),
    currentWeek,
  );

  const episodic: EpisodicMemory = {
    unmetInstructions: deriveUnmetInstructions(
      buildInstructionHistory(weekPlans, exerciseSessions, nameById),
      currentWeek,
    ),
    // Populated by the consolidation pass, which is the only thing that can judge whether
    // a change the coach made actually worked.
    standingAdjustments: [],
    statementsRaised,
    // Verbatim prose from the latest week only. Four weeks invites the model to recycle
    // its own phrasing and buries the unmet instruction among dozens of lines.
    lastWeekNotes: extractNotes(weekPlans[0]?.raw_plan),
  };

  // --- what may be programmed ----------------------------------------------

  const available = new Set(
    ((profile.equipment ?? []) as string[]).map((e) => e.toLowerCase()),
  );
  const withHistory = new Set(exerciseSessions.map((s) => s.exerciseId));

  const programmable = exRows
    .filter((r) => r.preference !== "excluded")
    // Equipment is a hard gate: a plan containing a lift you cannot load is worse than a
    // slightly worse plan. An exercise with no recorded equipment is allowed through —
    // absence of data is not evidence the gym lacks it.
    .filter((r) => !r.equipment || available.size === 0 || available.has(r.equipment.toLowerCase()))
    .map((r) => ({
      name: r.name,
      muscleGroup: r.muscle_group,
      unit: r.unit,
      incrementLbs: Number(r.increment_lbs),
      preference: r.preference,
      hasHistory: withHistory.has(r.id),
    }));

  return {
    identity: {
      sex: (profile.sex ?? null) as CoachContext["identity"]["sex"],
      heightIn: num(profile.height_in),
      birthYear: profile.birth_year ?? null,
    },
    environment: {
      // gym_type lands in a later migration; inferred from equipment breadth until then.
      gymType: null,
      equipment: (profile.equipment ?? []) as string[],
      gymName: profile.gym_name ?? null,
    },
    preferences: {
      stylePreference: null,
      excluded,
      favourites,
      durableConstraints: profile.durable_constraints ?? null,
    },
    goals: {
      ordered: (profile.goals ?? []) as string[],
      lifecycleStage: profile.lifecycle_stage,
      trainingLevel: profile.training_level,
    },
    stated: {
      days: trainingDays.map((d) => ({ dow: d.dow, durationMin: d.duration_min })),
      checkinDow: profile.checkin_dow,
    },
    measured,
    observed,
    episodic,
    progression,
    programmable,
    windowWeeks,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Postgres numerics arrive as strings over PostgREST. */
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function modeOf(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const counts = new Map<number, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Reconstructs the prescribed rep range from what was logged.
 *
 * Only needed for history imported without a plan. Uses the highest rep count achieved as
 * the top of the range, which is the conservative reading: it can under-state the target
 * and so decline to progress, never over-state it and award an unearned increase.
 */
function inferTargetReps(sets: Array<{ reps: number | null }>): string {
  const reps = sets.map((s) => s.reps).filter((r): r is number => typeof r === "number");
  if (reps.length === 0) return "8";
  return String(Math.max(...reps));
}

/** Pulls whatever the user wrote in a check-in out of its JSON blob. */
function extractStatements(
  weekNumber: number,
  constraints: unknown,
): Array<{ weekNumber: number; text: string }> {
  if (!constraints || typeof constraints !== "object") return [];
  const out: Array<{ weekNumber: number; text: string }> = [];
  for (const value of Object.values(constraints as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim()) {
      out.push({ weekNumber, text: value.trim() });
    }
  }
  return out;
}

interface RawPlanShape {
  sessions?: Array<{
    session_name?: string;
    exercises?: Array<{ name?: string; coaching_note?: string; target_reps?: string }>;
  }>;
}

/** Coaching notes from a stored plan, flattened. */
function extractNotes(rawPlan: unknown): EpisodicMemory["lastWeekNotes"] {
  const plan = rawPlan as RawPlanShape | null;
  if (!plan?.sessions) return [];
  const out: EpisodicMemory["lastWeekNotes"] = [];
  for (const s of plan.sessions) {
    for (const e of s.exercises ?? []) {
      if (e.coaching_note) {
        out.push({
          session: s.session_name ?? "",
          exercise: e.name ?? null,
          note: e.coaching_note,
        });
      }
    }
  }
  return out;
}

/**
 * Pairs each prescription the coach made with whether the logs show it was satisfied.
 *
 * "Met" is defined the same way progression is: every working set reached the top of the
 * prescribed range. Using the same definition in both places is deliberate — an
 * instruction the user satisfied must never still read as outstanding.
 */
function buildInstructionHistory(
  weekPlans: Array<{ week_number: number; raw_plan: unknown }>,
  exerciseSessions: ReadonlyArray<ExerciseSession>,
  nameById: Map<string, string>,
): PriorInstruction[] {
  const out: PriorInstruction[] = [];

  for (const wp of weekPlans) {
    const plan = wp.raw_plan as RawPlanShape | null;
    if (!plan?.sessions) continue;

    for (const session of plan.sessions) {
      for (const ex of session.exercises ?? []) {
        if (!ex.name || !ex.coaching_note) continue;

        // Sessions logged for this exercise, most recent first.
        const logged = exerciseSessions
          .filter((s) => nameById.get(s.exerciseId) === ex.name)
          .sort((a, b) => b.date.getTime() - a.date.getTime());
        if (logged.length === 0) continue;

        const latest = logged[0];
        const top = topOfRange(ex.target_reps ?? latest.targetReps);
        const met =
          latest.sets.length > 0 &&
          latest.sets.every((s) => typeof s.reps === "number" && s.reps >= top);

        out.push({
          weekNumber: wp.week_number,
          exercise: ex.name,
          instruction: ex.coaching_note,
          met,
          outcome: `${Math.max(...latest.sets.map((s) => s.weightLbs))} x ${latest.sets
            .slice()
            .sort((a, b) => a.setNumber - b.setNumber)
            .map((s) => s.reps ?? "-")
            .join("/")}`,
        });
      }
    }
  }

  return out;
}

function topOfRange(targetReps: string): number {
  const m = targetReps.match(/(\d+)\s*(?:-\s*(\d+))?\s*\+?/);
  if (!m) return Number.POSITIVE_INFINITY;
  return Number(m[2] ?? m[1]);
}
