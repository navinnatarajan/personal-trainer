import { redirect } from "next/navigation";

import { signOut } from "@/app/auth/actions";
import { createClient, getUser } from "@/lib/supabase/server";

/**
 * Placeholder home. Exists to prove the auth round trip and the signup trigger; the real
 * dashboard is designed before it is built.
 */
export default async function HomePage() {
  // Verified against the auth server, not just decoded from the cookie. proxy.ts already
  // redirects anonymous users, but that is a convenience — this is the actual check.
  const user = await getUser();
  if (!user) redirect("/login");

  const supabase = await createClient();
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("display_name, timezone, lifecycle_stage, created_at, onboarded_at")
    .eq("id", user.id)
    .maybeSingle();

  // A user who has not finished setup has nothing to see here. The trigger creates the
  // profile row at signup, so its existence proves nothing — onboarded_at is the signal.
  if (profile && !profile.onboarded_at) redirect("/onboarding");

  return (
    <main className="mx-auto w-full max-w-lg flex-1 px-6 py-14">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-steel">
        Signed in
      </p>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight text-ink">
        {profile?.display_name ?? user.email}
      </h1>

      <dl className="mt-8 divide-y divide-line-2 border-y border-line-2 text-[14px]">
        <Row label="Email" value={user.email ?? "—"} />
        <Row label="User ID" value={user.id} mono />
        <Row
          label="Profile row"
          value={
            error
              ? `error: ${error.message}`
              : profile
                ? "created by trigger"
                : "missing"
          }
        />
        <Row
          label="Onboarded"
          value={profile?.onboarded_at ? profile.onboarded_at.slice(0, 10) : "not yet"}
        />
        <Row label="Timezone" value={profile?.timezone ?? "—"} />
        <Row label="Stage" value={profile?.lifecycle_stage ?? "—"} />
      </dl>

      <p className="mt-8 text-[14px] leading-relaxed text-ink-2">
        Auth works. Next: the dashboard, the Sunday check-in, and importing your training
        history.
      </p>

      <form action={signOut} className="mt-8">
        <button
          type="submit"
          className="rounded-[10px] border border-line bg-card px-4 py-2.5 text-sm font-medium text-ink-2 transition-colors hover:bg-card-2"
        >
          Sign out
        </button>
      </form>
    </main>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-3">
      <dt className="text-steel">{label}</dt>
      <dd
        className={`text-right text-ink ${mono ? "font-mono text-[12px] break-all" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}
