import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/supabase/env";

/**
 * Runs before every matched request.
 *
 * In Next.js 16 this file is `proxy.ts`, not `middleware.ts` — the feature was renamed.
 * Every Supabase-plus-Next tutorial still says `middleware.ts`; a file by that name is
 * simply not picked up here.
 *
 * Two jobs:
 *  1. Refresh the auth session so it doesn't expire mid-use, writing the rotated cookies
 *     onto the response. Server Components cannot set cookies, so this is the only place
 *     the refresh can be persisted.
 *  2. An *optimistic* redirect for unauthenticated users.
 *
 * Deliberately no database calls here: this runs on every request including prefetches,
 * per the Next.js guidance. It is not the authorization boundary — pages and Server
 * Actions verify the user themselves via getUser(), and row-level security is the real
 * backstop. A redirect here is a convenience, not a security control.
 */

/** Prefixes that never require a session. */
const PUBLIC_PREFIXES = ["/login", "/auth"];

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(SUPABASE_URL(), SUPABASE_ANON_KEY(), {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Touching getUser() is what triggers the refresh and the setAll above.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    // Remember where they were headed so login can send them back.
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (user && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  // Skip static assets and images: running auth on those wastes work and can break
  // caching. Everything else passes through so sessions refresh site-wide.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|woff2?)$).*)",
  ],
};
