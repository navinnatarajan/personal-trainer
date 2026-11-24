import { redirect } from "next/navigation";

import { getUser, createClient } from "@/lib/supabase/server";
import { getGenerationStatus, serviceClient } from "@/lib/coach/run-generation";
import { rebuildInfo } from "./actions";
import { PlanScreen } from "./plan-screen";
import { TabBar } from "@/components/tab-bar";

export default async function PlanPage() {
  const user = await getUser();
  if (!user) redirect("/login");

  const supabase = await createClient();
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("onboarded_at, checkin_dow, timezone")
    .eq("id", user.id)
    .maybeSingle();

  // A read failure must not look like an empty state — the user would reasonably try to
  // generate a plan on top of one that already exists.
  if (error) {
    throw new Error(`Could not load your profile: ${error.message}. Reload and try again.`);
  }
  if (!profile?.onboarded_at) redirect("/onboarding");

  const [status, rebuild] = await Promise.all([
    getGenerationStatus(serviceClient(), user.id),
    rebuildInfo(),
  ]);

  return (
    <>
      <PlanScreen initialStatus={status} checkinDow={profile.checkin_dow} rebuild={rebuild} />
      <TabBar active="plan" />
    </>
  );
}
