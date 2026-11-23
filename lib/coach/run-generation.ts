/**
 * Owns the lifecycle of one plan generation.
 *
 * Generation takes around 70 seconds. Holding a request open that long works on a laptop
 * and fails on a phone, where the browser suspends background tabs as soon as the screen
 * locks or the user switches apps — which is the device this is for. So the database is
 * the handoff: this writes a `generating` row, does the work, and writes the result back.
 * The UI polls that row and never depends on one connection surviving.
 *
 * Uses a service-role client deliberately: the work continues after the request that
 * started it has returned, so there is no user session to carry. Every query is therefore
 * scoped to an explicit userId rather than relying on RLS, and that scoping is this
 * module's responsibility.
 */

import Anthropic from "@anthropic-ai/sdk";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { assembleCoachContext, todayInTimezone } from "./assemble";
import { generateWeekPlan } from "./generate-plan";
import type { WeekPlan } from "./generate-plan";

/**
 * How long a `generating` row may sit before it is presumed dead.
 *
 * Generation measures ~70s, so 6 minutes is a wide margin. This matters because a partial
 * unique index allows only one in-flight generation per user: without a reclaim, a crashed
 * worker would lock the user out of generating ever again.
 */
export const STALE_GENERATION_MS = 6 * 60 * 1000;

/** Longest a single generation may run before being abandoned. */
const GENERATION_TIMEOUT_MS = 4 * 60 * 1000;

export function serviceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Run `npm run check:env`.",
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Keeps an error message safe to store and useful to read.
 *
 * SDK errors do not embed credentials, but they are not guaranteed not to, and this string
 * is shown back to the user. Truncate, collapse whitespace, and redact anything
 * key-shaped — defence in depth on a field whose contents come from a third party.
 */
export function sanitiseError(message: string): string {
  return message
    .replace(/\b(sk-ant-[\w-]+|sb_(secret|publishable)_[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

export interface StartResult {
  ok: boolean;
  weekPlanId?: string;
  error?: string;
}

/**
 * Releases generations that have been in flight implausibly long.
 *
 * Called before starting a new one. Marks them failed rather than deleting, so the user
 * sees that something went wrong instead of finding the attempt silently vanished.
 */
export async function reclaimStaleGenerations(
  db: SupabaseClient,
  userId: string,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_GENERATION_MS).toISOString();

  const { data, error } = await db
    .from("week_plans")
    .update({
      status: "failed",
      generation_error:
        "Generation stopped unexpectedly and was abandoned. Nothing was saved — try again.",
      generation_finished_at: now.toISOString(),
    })
    .eq("user_id", userId)
    .eq("status", "generating")
    .lt("generation_started_at", cutoff)
    .select("id");

  if (error) throw error;
  return data?.length ?? 0;
}

/**
 * Starts a generation and returns as soon as the row exists.
 *
 * The caller is expected not to await `work` — it continues in the background and the UI
 * discovers the outcome by polling. Returning the id before any model call means the user
 * sees a "generating" screen immediately rather than a hung button.
 */
export async function startGeneration(opts: {
  userId: string;
  weekNumber: number;
  weekStart: string;
  notes: string | null;
  /** Injected in tests. */
  db?: SupabaseClient;
  anthropic?: Anthropic;
}): Promise<{ result: StartResult; work: Promise<void> }> {
  const db = opts.db ?? serviceClient();

  try {
    await reclaimStaleGenerations(db, opts.userId);
  } catch (err) {
    return {
      result: { ok: false, error: sanitiseError(asMessage(err)) },
      work: Promise.resolve(),
    };
  }

  // The partial unique index enforces one in-flight generation per user, so a double tap
  // fails here rather than billing twice or racing two writers at the same week.
  const { data: created, error: insertError } = await db
    .from("week_plans")
    .insert({
      user_id: opts.userId,
      week_number: opts.weekNumber,
      starts_on: opts.weekStart,
      ends_on: addDays(opts.weekStart, 6),
      status: "generating",
      generation_started_at: new Date().toISOString(),
      model_used: "claude-opus-5",
    })
    .select("id")
    .single();

  if (insertError) {
    const duplicate = insertError.code === "23505";
    return {
      result: {
        ok: false,
        error: duplicate
          ? "A plan is already being generated. Give it a minute."
          : sanitiseError(insertError.message),
      },
      work: Promise.resolve(),
    };
  }

  const weekPlanId = created.id as string;

  return {
    result: { ok: true, weekPlanId },
    work: runGeneration({ ...opts, db, weekPlanId }),
  };
}

/**
 * Does the actual work and records the outcome.
 *
 * Never throws: a rejected background promise would be an unhandled rejection with no UI
 * consequence, leaving the row at `generating` until the staleness sweep. Every failure
 * path writes `failed` with a readable reason instead.
 */
async function runGeneration(opts: {
  userId: string;
  weekNumber: number;
  weekStart: string;
  notes: string | null;
  weekPlanId: string;
  db: SupabaseClient;
  anthropic?: Anthropic;
}): Promise<void> {
  const { db, weekPlanId } = opts;

  try {
    const context = await assembleCoachContext(db, {
      userId: opts.userId,
      currentWeek: opts.weekNumber,
    });

    const generated = await withTimeout(
      generateWeekPlan({
        context,
        weekStart: opts.weekStart,
        weekNumber: opts.weekNumber,
        thisWeekNotes: opts.notes,
        client: opts.anthropic,
      }),
      GENERATION_TIMEOUT_MS,
    );

    const { error } = await db
      .from("week_plans")
      .update({
        // `draft` rather than `active`: the user reviews before anything is committed.
        status: "draft",
        headline: generated.plan.headline,
        notes: generated.plan.week_note,
        raw_plan: generated.plan,
        generation_source: generated.source,
        generation_error: generated.fallbackReason
          ? sanitiseError(generated.fallbackReason)
          : null,
        warnings: generated.warnings.map(sanitiseError),
        generation_finished_at: new Date().toISOString(),
      })
      .eq("id", weekPlanId);

    if (error) throw error;
  } catch (err) {
    await db
      .from("week_plans")
      .update({
        status: "failed",
        generation_error: sanitiseError(asMessage(err)),
        generation_finished_at: new Date().toISOString(),
      })
      .eq("id", weekPlanId);
  }
}

export interface GenerationStatus {
  weekPlanId: string;
  status: "generating" | "draft" | "active" | "failed" | "completed" | "superseded";
  /** Seconds since generation began, for honest progress rather than a bare spinner. */
  elapsedSec: number | null;
  plan: WeekPlan | null;
  source: string | null;
  error: string | null;
  warnings: string[];
  weekNumber: number;
  startsOn: string;
}

/** The current state of a user's most recent plan, or null if they have none. */
export async function getGenerationStatus(
  db: SupabaseClient,
  userId: string,
  now = new Date(),
): Promise<GenerationStatus | null> {
  const { data, error } = await db
    .from("week_plans")
    .select(
      "id, status, week_number, starts_on, raw_plan, generation_source, generation_error, generation_started_at, warnings",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const started = data.generation_started_at
    ? new Date(data.generation_started_at).getTime()
    : null;

  return {
    weekPlanId: data.id,
    status: data.status,
    elapsedSec: started ? Math.max(0, Math.round((now.getTime() - started) / 1000)) : null,
    plan: (data.raw_plan ?? null) as WeekPlan | null,
    source: data.generation_source ?? null,
    error: data.generation_error ?? null,
    warnings: (data.warnings ?? []) as string[],
    weekNumber: data.week_number,
    startsOn: data.starts_on,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * The Monday of the week a plan should cover.
 *
 * Derived from the user's timezone, never `toISOString()` — that is UTC, and between local
 * midnight and UTC midnight it returns tomorrow, which would silently plan the wrong week.
 */
export function nextWeekStart(timezone: string, now = new Date()): string {
  const today = todayInTimezone(timezone, now);
  const d = new Date(`${today}T00:00:00Z`);
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  // Monday of the current week if today is Monday, otherwise the coming Monday.
  const daysUntilMonday = dow === 1 ? 0 : 8 - dow;
  return addDays(today, daysUntilMonday);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Generation took longer than ${Math.round(ms / 60000)} minutes.`)),
        ms,
      ),
    ),
  ]);
}
