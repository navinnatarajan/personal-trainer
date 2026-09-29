import { createBrowserClient } from "@supabase/ssr";

import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./env";

/**
 * Supabase client for Client Components.
 *
 * Safe to ship to the browser: it carries only the anon key, and row-level security
 * is what actually constrains access. Never import the service-role key here.
 */
export function createClient() {
  return createBrowserClient(SUPABASE_URL(), SUPABASE_ANON_KEY());
}
