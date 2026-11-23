import { redirect } from "next/navigation";

import { getUser, createClient } from "@/lib/supabase/server";
import { TabBar } from "@/components/tab-bar";
import { ProfileScreen } from "./profile-screen";

export default async function ProfilePage() {
  const user = await getUser();
  if (!user) redirect("/login");

  const supabase = await createClient();
  const [{ data: profile, error }, { data: dayPrefs }, { data: activities }, { data: excluded }] =
    await Promise.all([
      supabase
        .from("profiles")
        .select(
          "display_name, goals, split_preference, checkin_dow, durable_constraints, training_level, gym_type, onboarded_at",
        )
        .eq("id", user.id)
        .maybeSingle(),
      supabase.from("day_preferences").select("dow, can_train, duration_min").eq("user_id", user.id),
      supabase.from("user_activities").select("name, dows, intensity").eq("user_id", user.id),
      supabase.from("exercises").select("name").eq("user_id", user.id).eq("preference", "excluded"),
    ]);

  if (error) {
    throw new Error(`Could not load your profile: ${error.message}. Reload and try again.`);
  }
  if (!profile?.onboarded_at) redirect("/onboarding");

  const byDow = new Map((dayPrefs ?? []).map((d) => [d.dow, d]));

  return (
    <>
      <ProfileScreen
        email={user.email ?? ""}
        displayName={profile.display_name}
        initial={{
          days: Array.from({ length: 7 }, (_, i) => {
            const dow = i + 1;
            const p = byDow.get(dow);
            return {
              dow,
              canTrain: p?.can_train ?? false,
              durationMin: p?.duration_min ?? null,
            };
          }),
          checkinDow: profile.checkin_dow,
          durableConstraints: profile.durable_constraints,
          goals: (profile.goals ?? []) as string[],
          splitPreference: profile.split_preference,
          activities: (activities ?? []).map((a) => ({
            name: a.name,
            dows: (a.dows ?? []) as number[],
            intensity: a.intensity as string,
          })),
        }}
        excluded={(excluded ?? []).map((e) => e.name)}
        trainingLevel={profile.training_level}
        gymType={profile.gym_type}
      />
      <TabBar active="profile" />
    </>
  );
}
