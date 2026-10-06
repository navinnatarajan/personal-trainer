import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./env";

/**
 * Supabase client for Server Components, Server Actions, and Route Handlers.
 *
 * Carries the user's session from cookies, so row-level security applies as that user.
 * Must be created per request — never hoisted into a module-level singleton, which would
 * leak one user's session into another's request.
 */
export async function createClient() {
  // Async since Next.js 15; `cookies()` returns a promise.
  const cookieStore = await cookies();

  return createServerClient(SUPABASE_URL(), SUPABASE_ANON_KEY(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Thrown when called during a Server Component render, where cookies are
          // read-only. Safe to ignore: proxy.ts refreshes the session on every request,
          // so the refreshed cookie is already being written there.
        }
      },
    },
  });
}

/**
 * The current user, verified against the auth server, or null.
 *
 * Always prefer this over `auth.getSession()` on the server. `getSession()` decodes the
 * cookie without validating it, so a forged or stale cookie would be trusted;
 * `getUser()` revalidates the token. Authorization decisions must use this.
 */
export async function getUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}
