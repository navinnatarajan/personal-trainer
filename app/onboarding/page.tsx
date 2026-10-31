import { redirect } from "next/navigation";

import { createClient, getUser } from "@/lib/supabase/server";
import { OnboardingFlow } from "./flow";
import type { OnboardingInput } from "./schema";

/**
 * Loads whatever is already known and hands it to the flow pre-filled.
 *
 * A returning user confirms rather than retypes, and — more importantly — cannot
 * accidentally blank a split or a set of training days by walking through setup again.
 */
export default async function OnboardingPage() {
  const user = await getUser();
  if (!user) redirect("/login");

  const supabase = await createClient();

  const [
    { data: profile },
    { data: dayPrefs },
    { data: metrics },
    { data: excluded },
    { data: activities },
    { data: library },
  ] = await Promise.all([
      supabase
        .from("profiles")
        .select(
          "display_name, sex, height_in, birth_year, weight_lbs, training_level, gym_type, equipment, style_preference, goals, split_preference, checkin_dow, durable_constraints, onboarded_at",
        )
        .eq("id", user.id)
        .maybeSingle(),
      supabase.from("day_preferences").select("dow, can_train, duration_min").eq("user_id", user.id),
      // Weight and waist live in body_metrics, which is the source of truth for anything
      // measured over time; profiles.weight_lbs is only the figure given at setup and is
      // null for a user whose history was imported.
      supabase
        .from("body_metrics")
        .select("weight_lbs, waist_in")
        .eq("user_id", user.id)
        .order("date", { ascending: false })
        .limit(1),
      supabase.from("exercises").select("name").eq("user_id", user.id).eq("preference", "excluded"),
      supabase.from("user_activities").select("name, dows, intensity").eq("user_id", user.id),
      // The whole library, so any lift can be excluded — not only the shortlist.
      supabase.from("exercises").select("name, muscle_group").eq("user_id", user.id).order("name"),
    ]);

  const prefByDow = new Map((dayPrefs ?? []).map((d) => [d.dow, d]));

  const initial: OnboardingInput = {
    sex: (profile?.sex ?? null) as OnboardingInput["sex"],
    heightIn: numOrNull(profile?.height_in),
    birthYear: profile?.birth_year ?? null,
    weightLbs: numOrNull(profile?.weight_lbs) ?? numOrNull(metrics?.[0]?.weight_lbs),
    waistIn: numOrNull(metrics?.[0]?.waist_in),
    trainingLevel: (profile?.training_level ?? "novice") as OnboardingInput["trainingLevel"],
    gymType: (profile?.gym_type ?? "full") as OnboardingInput["gymType"],
    equipment: (profile?.equipment ?? []) as string[],
    stylePreference: (profile?.style_preference ?? "mix") as OnboardingInput["stylePreference"],
    goals: ((profile?.goals ?? []) as OnboardingInput["goals"]).slice(0, 3),
    splitPreference: (profile?.split_preference ??
      "coach_decides") as OnboardingInput["splitPreference"],
    days: Array.from({ length: 7 }, (_, i) => {
      const dow = i + 1;
      const p = prefByDow.get(dow);
      return {
        dow,
        canTrain: p?.can_train ?? false,
        durationMin: p?.duration_min ?? null,
      };
    }),
    checkinDow: profile?.checkin_dow ?? 7,
    activities: (activities ?? []).map((a) => ({
      name: a.name,
      dows: (a.dows ?? []) as number[],
      intensity: a.intensity as OnboardingInput["activities"][number]["intensity"],
    })),
    excluded: (excluded ?? []).map((e) => e.name),
    durableConstraints: profile?.durable_constraints ?? null,
  };

  // onboarded_at is the authoritative signal; a seeded training day is not, since the
  // importer can create those without the user ever having seen this flow.
  const returning = profile?.onboarded_at !== null && profile?.onboarded_at !== undefined;

  return (
    <OnboardingFlow
      initial={initial}
      firstName={(profile?.display_name ?? "").split(" ")[0] || null}
      returning={returning}
      library={(library ?? []).map((e) => ({ name: e.name, muscleGroup: e.muscle_group }))}
    />
  );
}

/** Postgres numerics arrive as strings over PostgREST. */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
