import Link from "next/link";
import { redirect } from "next/navigation";

import { createClient, getUser } from "@/lib/supabase/server";
import { todayInTimezone } from "@/lib/coach/assemble";
import { TabBar } from "@/components/tab-bar";

/**
 * Lift — what you see when you open the app.
 *
 * One job: get from standing in the gym doorway to the first set without reading. So the
 * page routes on state rather than presenting choices: no plan means there is nothing to
 * do here but build one, and saying that plainly beats a dashboard full of empty tiles.
 */
export default async function HomePage() {
  // Verified against the auth server rather than decoded from the cookie. proxy.ts already
  // redirects anonymous users, but that is a convenience — this is the real check.
  const user = await getUser();
  if (!user) redirect("/login");

  const supabase = await createClient();
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("display_name, timezone, onboarded_at")
    .eq("id", user.id)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not load your profile: ${error.message}. Reload and try again.`);
  }

  // The signup trigger creates the profile row, so its existence proves nothing.
  if (!profile?.onboarded_at) redirect("/onboarding");

  const timezone = profile.timezone ?? "UTC";
  const today = todayInTimezone(timezone);

  const { data: activePlan } = await supabase
    .from("week_plans")
    .select("id, week_number, headline, starts_on")
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();

  // Nothing committed yet: the only useful action is building a week.
  if (!activePlan) {
    const { data: draft } = await supabase
      .from("week_plans")
      .select("status")
      .eq("user_id", user.id)
      .in("status", ["draft", "generating"])
      .maybeSingle();

    return (
      <>
        <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 pb-6 pt-10">
          <p className="font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-steel">
            {firstName(profile.display_name)}
          </p>
          <h1 className="mt-3 font-display text-[30px] font-semibold uppercase leading-[1.03] tracking-[-0.03em] text-bone">
            No week yet
          </h1>
          <p className="mt-3 text-[14px] leading-relaxed text-muted">
            {draft?.status === "generating"
              ? "A plan is being built right now."
              : draft?.status === "draft"
                ? "You have a plan waiting to be reviewed."
                : "Tell the coach what is going on this week and it will build you one."}
          </p>
          <Link
            href="/plan"
            className="mt-7 w-full rounded-full bg-sage px-5 py-3.5 text-center font-sans text-[14px] font-bold uppercase tracking-[0.1em] text-ink"
          >
            {draft ? "See it" : "Build my week"}
          </Link>
        </main>
        <TabBar active="lift" />
      </>
    );
  }

  // A committed week exists: show today, and the week around it.
  const { data: sessions } = await supabase
    .from("planned_sessions")
    .select("id, date, dow, session_name, time_budget_min, warmup_min, headline")
    .eq("week_plan_id", activePlan.id)
    .order("date");

  const all = sessions ?? [];
  const todaySession = all.find((s) => s.date === today) ?? null;
  const upcoming = all.filter((s) => s.date > today);

  const { count: todayExercises } = todaySession
    ? await supabase
        .from("planned_exercises")
        .select("id", { count: "exact", head: true })
        .eq("planned_session_id", todaySession.id)
    : { count: 0 };

  return (
    <>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-5 pb-6 pt-6">
        <header className="flex items-baseline justify-between">
          <span className="font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-steel">
            {firstName(profile.display_name)}
          </span>
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-steel">
            Week {activePlan.week_number}
          </span>
        </header>

        {todaySession ? (
          <div className="flex flex-col gap-3.5 rounded-[20px] bg-sage p-5 text-ink">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink/60">
              {longDow(todaySession.dow)} · today
            </span>
            <div>
              <div className="font-display text-[30px] font-semibold uppercase leading-none tracking-[-0.03em]">
                {todaySession.session_name}
              </div>
              <div className="mt-1.5 text-[13px] font-medium text-ink/70">
                {todayExercises ?? 0} exercises · {todaySession.time_budget_min} min
              </div>
            </div>
            {todaySession.headline && (
              <p className="text-[13px] leading-snug text-ink/75">{todaySession.headline}</p>
            )}
            {/* The logger is the next thing to build; until then this is honest about it. */}
            <div className="w-full rounded-full bg-ink/10 px-4 py-3 text-center font-sans text-[12px] font-semibold uppercase tracking-[0.1em] text-ink/55">
              Logging coming next
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2 rounded-[20px] border border-line bg-card p-5">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted">
              Today
            </span>
            <div className="font-display text-[26px] font-semibold uppercase leading-none tracking-[-0.03em] text-bone">
              Rest day
            </div>
            <p className="text-[13px] text-muted">Nothing scheduled. Next up below.</p>
          </div>
        )}

        {upcoming.length > 0 && (
          <div className="flex flex-col gap-[7px]">
            <span className="font-sans text-[10px] font-bold uppercase tracking-[0.12em] text-muted">
              Rest of the week
            </span>
            {upcoming.map((s) => (
              <div
                key={s.id}
                className="flex items-baseline justify-between gap-3 rounded-[12px] border border-line bg-card px-4 py-3"
              >
                <span className="font-mono text-[12px] font-semibold text-bone">
                  {s.dow.toUpperCase()} · {s.session_name}
                </span>
                <span className="font-mono text-[11px] text-muted">
                  {s.time_budget_min}m
                </span>
              </div>
            ))}
          </div>
        )}
      </main>
      <TabBar active="lift" />
    </>
  );
}

function firstName(name: string | null): string {
  return (name ?? "").split(" ")[0] || "Welcome";
}

const DOW_LONG: Record<string, string> = {
  Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday",
  Fri: "Friday", Sat: "Saturday", Sun: "Sunday",
};
const longDow = (d: string) => DOW_LONG[d] ?? d;
