"use server";

import { redirect } from "next/navigation";

import { createClient, getUser } from "@/lib/supabase/server";
import {
  OnboardingSchema,
  crossFieldErrors,
  type OnboardingInput,
} from "./schema";

export interface SaveResult {
  ok: boolean;
  errors: string[];
}

/**
 * Persists an onboarding submission.
 *
 * Every write is scoped to the authenticated user and goes through a client carrying their
 * session, so row-level security applies as a second line of defence. The auth check here
 * is not optional: Server Functions are reachable by direct POST, not only through the UI.
 *
 * Exclusions never delete an exercise or its logged sets — they set
 * `preference = 'excluded'`, which stops the lift being programmed while keeping its
 * history. A user ruling out a lift they have done before must not lose that data.
 */
export async function saveOnboarding(input: OnboardingInput): Promise<SaveResult> {
  const user = await getUser();
  if (!user) return { ok: false, errors: ["You are not signed in."] };

  const parsed = OnboardingSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => i.message),
    };
  }

  const data = parsed.data;
  const crossErrors = crossFieldErrors(data);
  if (crossErrors.length) return { ok: false, errors: crossErrors };

  const supabase = await createClient();

  // A full gym implies everything; storing a partial list would then wrongly gate
  // exercises the user can actually load.
  const equipment = data.gymType === "full" ? [] : data.equipment;

  const { error: profileError } = await supabase
    .from("profiles")
    .update({
      sex: data.sex,
      height_in: data.heightIn,
      birth_year: data.birthYear,
      weight_lbs: data.weightLbs,
      training_level: data.trainingLevel,
      gym_type: data.gymType,
      equipment,
      style_preference: data.stylePreference,
      goals: data.goals,
      split_preference: data.splitPreference,
      checkin_dow: data.checkinDow,
      durable_constraints: data.durableConstraints,
      onboarded_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", user.id);

  if (profileError) return { ok: false, errors: [profileError.message] };

  // Today's weight and waist are a measurement, so they belong in body_metrics as well as
  // on the profile — that is what the 7-day average and waist-to-height read from.
  if (data.weightLbs !== null || data.waistIn !== null) {
    const today = new Date().toISOString().slice(0, 10);
    const { error: metricError } = await supabase.from("body_metrics").upsert(
      {
        user_id: user.id,
        date: today,
        weight_lbs: data.weightLbs,
        waist_in: data.waistIn,
      },
      { onConflict: "user_id,date" },
    );
    if (metricError) return { ok: false, errors: [metricError.message] };
  }

  const { error: dayError } = await supabase.from("day_preferences").upsert(
    data.days.map((d) => ({
      user_id: user.id,
      dow: d.dow,
      can_train: d.canTrain,
      duration_min: d.canTrain ? d.durationMin : null,
    })),
    { onConflict: "user_id,dow" },
  );
  if (dayError) return { ok: false, errors: [dayError.message] };

  // --- exclusions ---
  //
  // Reset then apply, so unticking something in a later run actually un-excludes it.
  // Only 'excluded' rows are reset: anchors and favourites are set elsewhere and must
  // survive re-onboarding.
  const { error: clearError } = await supabase
    .from("exercises")
    .update({ preference: "neutral" })
    .eq("user_id", user.id)
    .eq("preference", "excluded");
  if (clearError) return { ok: false, errors: [clearError.message] };

  if (data.excluded.length) {
    const { error: excludeError } = await supabase
      .from("exercises")
      .update({ preference: "excluded" })
      .eq("user_id", user.id)
      .in("name", data.excluded);
    if (excludeError) return { ok: false, errors: [excludeError.message] };
  }

  // --- activities ---
  //
  // Replace wholesale rather than merge: removing one in a later run has to actually
  // remove it, and these rows carry no history worth preserving (unlike exercises, where
  // deletion would take logged sets with it).
  const { error: delActivities } = await supabase
    .from("user_activities")
    .delete()
    .eq("user_id", user.id);
  if (delActivities) return { ok: false, errors: [delActivities.message] };

  if (data.activities.length) {
    const { error: actError } = await supabase.from("user_activities").insert(
      data.activities.map((a) => ({
        user_id: user.id,
        name: a.name.trim(),
        dows: a.dows,
        intensity: a.intensity,
      })),
    );
    if (actError) return { ok: false, errors: [actError.message] };
  }

  return { ok: true, errors: [] };
}

/** Saves, then sends the user to generate their first week. */
export async function completeOnboarding(input: OnboardingInput): Promise<SaveResult> {
  const result = await saveOnboarding(input);
  if (!result.ok) return result;
  // redirect() throws, so it must come after every write has succeeded.
  redirect("/plan");
}
