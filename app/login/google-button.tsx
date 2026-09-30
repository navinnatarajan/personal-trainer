"use client";

import { useState } from "react";

import { createClient } from "@/lib/supabase/client";

/**
 * Starts the Google OAuth flow.
 *
 * Client-side rather than a Server Action because Supabase returns a URL the browser
 * must navigate to, and the PKCE verifier has to be stored by the same client that
 * later completes the exchange.
 */
export function GoogleButton({ next }: { next?: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setPending(true);
    setError(null);

    const supabase = createClient();
    const callback = new URL("/auth/callback", window.location.origin);
    if (next) callback.searchParams.set("next", next);

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: callback.toString() },
    });

    // On success the browser navigates away, so this only runs on failure.
    if (error) {
      setError(error.message);
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={signIn}
        disabled={pending}
        className="flex w-full items-center justify-center gap-3 rounded-[10px] border border-line bg-card px-4 py-3.5 text-[15px] font-medium text-ink shadow-card transition-colors hover:bg-card-2 disabled:opacity-60"
      >
        <GoogleMark />
        {pending ? "Redirecting…" : "Continue with Google"}
      </button>
      {error && (
        <p role="alert" className="mt-3 text-sm text-alert">
          {error}
        </p>
      )}
    </>
  );
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92a8.78 8.78 0 0 0 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86a5.33 5.33 0 0 1-5-3.68H1v2.34A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M4 10.74a5.4 5.4 0 0 1 0-3.46V4.96H1a9 9 0 0 0 0 8.1l3-2.32Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 1 4.96l3 2.32A5.33 5.33 0 0 1 9 3.58Z"
      />
    </svg>
  );
}
