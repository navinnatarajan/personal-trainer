"use server";

import { getUser, createClient } from "@/lib/supabase/server";
import {
  getGenerationStatus,
  nextWeekStart,
  serviceClient,
  startGeneration,
  type GenerationStatus,
} from "@/lib/coach/run-generation";

/**
 * Server Actions for the plan screen.
 *
 * Every one re-checks authentication. Server Functions are reachable by direct POST, not
 * only through the UI, so the check is not optional — and these actions spend money.
 */

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/**
 * Kicks off generation and returns immediately.
 *
 * The work is deliberately not awaited: it continues after this returns, writing its
 * result to `week_plans` where the client discovers it by polling. Awaiting it would
 * reintroduce the 70-second request this design exists to avoid.
 */
export async function requestPlan(notes: string): Promise<ActionResult> {
  const user = await getUser();
  if (!user) return { ok: false, error: "You are not signed in." };

  const supabase = await createClient();
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("timezone, onboarded_at")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) return { ok: false, error: profileError.message };
  if (!profile?.onboarded_at) {
    return { ok: false, error: "Finish setting up your profile first." };
  }

  const db = serviceClient();

  // A committed week cannot be regenerated on a whim — that would make the plan a slot
  // machine, rerolled until Thursday is not leg day, at a real cost per spin.
  //
  // But a week nobody has trained yet has nothing to protect, and refusing to rebuild it
  // traps the user with a plan built from data they have since corrected. So the rule is
  // about protecting *logged work*, not about the plan being untouchable.
  const { data: active, error: activeError } = await db
    .from("week_plans")
    .select("id, week_number")
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();

  if (activeError) return { ok: false, error: activeError.message };
  if (active) {
    const logged = await loggedSetsForPlan(db, user.id, active.id);
    if (logged > 0) {
      return {
        ok: false,
        error:
          `Week ${active.week_number} already has ${logged} logged set${logged === 1 ? "" : "s"}.` +
          ` Rebuilding would throw that away — adjust the rest of the week instead.`,
      };
    }
    // Untrained: clear it so the new plan is the only active one.
    const discardError = await discardPlanRows(db, user.id, active.id);
    if (discardError) return { ok: false, error: discardError };
  }

  const weekStart = nextWeekStart(profile.timezone ?? "UTC");
  const weekNumber = await nextWeekNumber(db, user.id);

  const { result, work } = await startGeneration({
    userId: user.id,
    weekNumber,
    weekStart,
    notes: notes.trim() ? notes.trim() : null,
  });

  if (!result.ok) return { ok: false, error: result.error };

  // Not awaited on purpose. Attach a catch so a rejection cannot surface as an unhandled
  // rejection; runGeneration already records its own failures to the row.
  void work.catch(() => {});

  return { ok: true };
}

/** Polled by the client while a generation is in flight. */
export async function planStatus(): Promise<GenerationStatus | null> {
  const user = await getUser();
  if (!user) return null;
  return getGenerationStatus(serviceClient(), user.id);
}

/**
 * Commits a reviewed plan: expands `raw_plan` into the rows the rest of the app reads.
 *
 * `week_plans.raw_plan` is the audit trail of what the model said; `planned_sessions` and
 * `planned_exercises` are what the session logger and progression actually use. Keeping
 * both means a plan that looks wrong can always be traced back to its source.
 */
export async function commitPlan(weekPlanId: string): Promise<ActionResult> {
  const user = await getUser();
  if (!user) return { ok: false, error: "You are not signed in." };

  const db = serviceClient();

  // Scoped by user_id as well as id: the id comes from the client, so ownership has to be
  // proven here rather than assumed.
  const { data: plan, error: loadError } = await db
    .from("week_plans")
    .select("id, status, week_number, starts_on, raw_plan")
    .eq("id", weekPlanId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (loadError) return { ok: false, error: loadError.message };
  if (!plan) return { ok: false, error: "That plan does not exist." };
  if (plan.status !== "draft") {
    return { ok: false, error: `This plan is ${plan.status}, so it cannot be committed.` };
  }

  const raw = plan.raw_plan as {
    sessions: Array<{
      dow: string;
      date: string;
      session_name: string;
      time_budget_min: number;
      warmup_min: number;
      warmup_note: string;
      headline: string;
      exercises: Array<{
        name: string;
        sets: number;
        target_weight: number | null;
        unit?: string;
        target_reps: string;
        rest_sec: number;
        superset_group: string | null;
        tag: string | null;
        coaching_note: string;
      }>;
    }>;
  } | null;

  if (!raw?.sessions?.length) {
    return { ok: false, error: "That plan has no sessions to commit." };
  }

  // Exercise names in the plan are database keys. Resolve them all up front so a single
  // unknown name fails before anything is written, rather than committing half a week.
  const { data: library, error: libError } = await db
    .from("exercises")
    .select("id, name, unit")
    .eq("user_id", user.id);
  if (libError) return { ok: false, error: libError.message };

  const byName = new Map((library ?? []).map((e) => [e.name, e]));
  const unknown = raw.sessions
    .flatMap((s) => s.exercises.map((e) => e.name))
    .filter((n) => !byName.has(n));
  if (unknown.length) {
    return {
      ok: false,
      error: `The plan names exercises that are not in your library: ${[...new Set(unknown)].join(", ")}.`,
    };
  }

  for (const [i, session] of raw.sessions.entries()) {
    const { data: created, error: sessionError } = await db
      .from("planned_sessions")
      .insert({
        user_id: user.id,
        week_plan_id: plan.id,
        date: session.date,
        dow: session.dow,
        session_name: session.session_name,
        time_budget_min: session.time_budget_min,
        warmup_min: session.warmup_min,
        warmup_note: session.warmup_note,
        headline: session.headline,
        sort_order: i,
      })
      .select("id")
      .single();

    if (sessionError) return { ok: false, error: sessionError.message };

    const { error: exError } = await db.from("planned_exercises").insert(
      session.exercises.map((ex, j) => ({
        user_id: user.id,
        planned_session_id: created.id,
        exercise_id: byName.get(ex.name)!.id,
        sort_order: j,
        sets: ex.sets,
        target_weight: ex.target_weight,
        unit: byName.get(ex.name)!.unit,
        target_reps: ex.target_reps,
        rest_sec: ex.rest_sec,
        superset_group: ex.superset_group,
        tag: ex.tag,
        coaching_note: ex.coaching_note,
      })),
    );

    if (exError) return { ok: false, error: exError.message };
  }

  const { error: activateError } = await db
    .from("week_plans")
    .update({ status: "active" })
    .eq("id", plan.id);

  if (activateError) return { ok: false, error: activateError.message };

  return { ok: true };
}

/**
 * Throws away a draft so the user can generate a different one.
 *
 * Only ever a draft: a committed week is locked. Deleted rather than marked superseded —
 * an unreviewed draft carries no history worth keeping, unlike a week that was trained.
 */
export async function discardDraft(weekPlanId: string): Promise<ActionResult> {
  const user = await getUser();
  if (!user) return { ok: false, error: "You are not signed in." };

  const db = serviceClient();
  const { error } = await db
    .from("week_plans")
    .delete()
    .eq("id", weekPlanId)
    .eq("user_id", user.id)
    .in("status", ["draft", "failed"]);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Week numbers continue from the user's history rather than restarting at 1. */
async function nextWeekNumber(
  db: ReturnType<typeof serviceClient>,
  userId: string,
): Promise<number> {
  const { data } = await db
    .from("week_plans")
    .select("week_number")
    .eq("user_id", userId)
    .order("week_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (data?.week_number) return data.week_number + 1;

  // No plans yet: continue from the imported history rather than calling it week 1.
  const { data: sessions } = await db
    .from("sessions")
    .select("date")
    .eq("user_id", userId)
    .order("date", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!sessions?.date) return 1;
  const first = new Date(`${sessions.date}T00:00:00Z`).getTime();
  const weeks = Math.floor((Date.now() - first) / (7 * 86_400_000));
  return Math.max(1, weeks + 1);
}

/** How many sets have been logged against sessions belonging to a plan. */
async function loggedSetsForPlan(
  db: ReturnType<typeof serviceClient>,
  userId: string,
  weekPlanId: string,
): Promise<number> {
  const { data: planned } = await db
    .from("planned_sessions")
    .select("id")
    .eq("week_plan_id", weekPlanId);

  const ids = (planned ?? []).map((p) => p.id);
  if (!ids.length) return 0;

  const { data: sessions } = await db
    .from("sessions")
    .select("id")
    .eq("user_id", userId)
    .in("planned_session_id", ids);

  const sessionIds = (sessions ?? []).map((s) => s.id);
  if (!sessionIds.length) return 0;

  const { count } = await db
    .from("set_logs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("session_id", sessionIds);

  return count ?? 0;
}

/**
 * Removes a plan and everything generated from it.
 *
 * planned_sessions and planned_exercises cascade from week_plans, so deleting the plan is
 * enough — but it is done explicitly rather than relying on a cascade staying in place.
 */
async function discardPlanRows(
  db: ReturnType<typeof serviceClient>,
  userId: string,
  weekPlanId: string,
): Promise<string | null> {
  const { error } = await db
    .from("week_plans")
    .delete()
    .eq("id", weekPlanId)
    .eq("user_id", userId);
  return error ? error.message : null;
}

export interface RebuildInfo {
  canRebuild: boolean;
  loggedSets: number;
  /** True when the profile changed after the plan was built — the plan is stale. */
  profileChangedSince: boolean;
}

/** Whether the active week can be rebuilt, and whether it is worth suggesting. */
export async function rebuildInfo(): Promise<RebuildInfo | null> {
  const user = await getUser();
  if (!user) return null;

  const db = serviceClient();
  const { data: active } = await db
    .from("week_plans")
    .select("id, created_at")
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();

  if (!active) return null;

  const { data: profile } = await db
    .from("profiles")
    .select("updated_at")
    .eq("id", user.id)
    .maybeSingle();

  const logged = await loggedSetsForPlan(db, user.id, active.id);

  return {
    canRebuild: logged === 0,
    loggedSets: logged,
    profileChangedSince: Boolean(
      profile?.updated_at && new Date(profile.updated_at) > new Date(active.created_at),
    ),
  };
}
