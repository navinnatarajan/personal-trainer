"use server";

import { redirect } from "next/navigation";

import { createClient, getUser } from "@/lib/supabase/server";
import { assembleCoachContext, todayInTimezone } from "@/lib/coach/assemble";
import { extractProposals, type Consolidation, type Proposal } from "@/lib/coach/consolidate";
import { applyProposals } from "@/lib/coach/apply-proposals";
import { serviceClient } from "@/lib/coach/run-generation";

/**
 * Profile editing and context import.
 *
 * Every action re-checks authentication: Server Functions are reachable by direct POST,
 * not only through the UI, and these spend money and rewrite a profile.
 */

export interface Result {
  ok: boolean;
  error?: string;
}

export interface ImportResult extends Result {
  consolidation?: Consolidation;
}

/** Reads pasted text and returns proposals. Writes nothing. */
export async function importContext(text: string): Promise<ImportResult> {
  const user = await getUser();
  if (!user) return { ok: false, error: "You are not signed in." };

  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("timezone")
    .eq("id", user.id)
    .maybeSingle();

  const db = serviceClient();
  const context = await assembleCoachContext(db, { userId: user.id, currentWeek: 1 });

  const res = await extractProposals({
    text,
    context,
    today: todayInTimezone(profile?.timezone ?? "UTC"),
  });

  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, consolidation: res.consolidation };
}

/** Writes the proposals the user ticked. */
export async function confirmProposals(proposals: Proposal[]): Promise<Result> {
  const user = await getUser();
  if (!user) return { ok: false, error: "You are not signed in." };
  if (!proposals.length) return { ok: true };

  const { applied, failures } = await applyProposals(serviceClient(), user.id, proposals);

  if (failures.length) {
    return {
      ok: applied > 0,
      error:
        `${applied} applied, ${failures.length} could not be: ` +
        failures.map((f) => `${f.summary} (${f.reason})`).join("; "),
    };
  }
  return { ok: true };
}

export interface ProfileEdits {
  days: Array<{ dow: number; canTrain: boolean; durationMin: number | null }>;
  checkinDow: number;
  durableConstraints: string | null;
  goals: string[];
  splitPreference: string;
  activities: Array<{ name: string; dows: number[]; intensity: string }>;
}

/** Saves direct edits from the profile form. */
export async function saveProfile(edits: ProfileEdits): Promise<Result> {
  const user = await getUser();
  if (!user) return { ok: false, error: "You are not signed in." };

  const trainingDays = edits.days.filter((d) => d.canTrain);
  if (trainingDays.length === 0) {
    return { ok: false, error: "Pick at least one day you can train." };
  }
  if (edits.goals.length === 0) {
    return { ok: false, error: "Pick at least one goal." };
  }

  const db = serviceClient();

  const { error: profileError } = await db
    .from("profiles")
    .update({
      checkin_dow: edits.checkinDow,
      durable_constraints: edits.durableConstraints,
      goals: edits.goals,
      split_preference: edits.splitPreference,
      updated_at: new Date().toISOString(),
    })
    .eq("id", user.id);
  if (profileError) return { ok: false, error: profileError.message };

  const { error: dayError } = await db.from("day_preferences").upsert(
    edits.days.map((d) => ({
      user_id: user.id,
      dow: d.dow,
      can_train: d.canTrain,
      duration_min: d.canTrain ? d.durationMin : null,
    })),
    { onConflict: "user_id,dow" },
  );
  if (dayError) return { ok: false, error: dayError.message };

  // Activities are replaced wholesale: removing one has to actually remove it, and these
  // rows carry no history worth preserving — unlike exercises, where deleting would take
  // logged sets with it.
  const { error: delError } = await db
    .from("user_activities")
    .delete()
    .eq("user_id", user.id);
  if (delError) return { ok: false, error: delError.message };

  if (edits.activities.length) {
    const { error: actError } = await db.from("user_activities").insert(
      edits.activities.map((a) => ({
        user_id: user.id,
        name: a.name.trim(),
        dows: a.dows,
        intensity: a.intensity,
      })),
    );
    if (actError) return { ok: false, error: actError.message };
  }

  return { ok: true };
}

/**
 * Clears `onboarded_at` so the app routes back through setup.
 *
 * Deliberately does not delete anything: the stored answers remain, so setup arrives
 * pre-filled and running it again cannot lose data. It is a way to walk the flow, not a
 * factory reset.
 */
export async function replayOnboarding(): Promise<void> {
  const user = await getUser();
  if (!user) redirect("/login");

  const { error } = await serviceClient()
    .from("profiles")
    .update({ onboarded_at: null })
    .eq("id", user.id);

  // Thrown rather than returned: this is a form action, which must resolve to void, and a
  // silent no-op would leave the user tapping a button that appears to do nothing.
  if (error) throw new Error(`Could not restart setup: ${error.message}`);

  redirect("/onboarding");
}

export async function signOutAction(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
