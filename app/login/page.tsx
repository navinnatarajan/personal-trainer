import { GoogleButton } from "./google-button";

/**
 * Deliberately plain. One button, one decision — there is nothing here worth designing
 * beyond making it unmistakable and reachable with a thumb.
 */
export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  // Promise-based since Next.js 15.
  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : null;
  const next = typeof params.next === "string" ? params.next : undefined;

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-steel">
          Personal Trainer
        </p>
        <h1 className="mt-3 font-display text-4xl font-semibold leading-[1.05] tracking-tight text-ink">
          Train with a plan
          <br />
          that keeps moving.
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-ink-2">
          Weekly plans built from what you actually lifted, so the weight goes up when
          you have earned it.
        </p>

        <div className="mt-9">
          <GoogleButton next={next} />
        </div>

        {error && (
          <div
            role="alert"
            className="mt-5 rounded-[10px] border border-alert/30 bg-alert-soft px-4 py-3 text-sm text-alert"
          >
            <p className="font-medium">Could not sign you in</p>
            <p className="mt-1 opacity-90">{error}</p>
          </div>
        )}

        <p className="mt-8 border-t border-line-2 pt-5 text-[13px] leading-relaxed text-steel">
          Invite only while this is in testing. If Google says access is blocked, your
          address has not been added as a test user yet.
        </p>
      </div>
    </main>
  );
}
