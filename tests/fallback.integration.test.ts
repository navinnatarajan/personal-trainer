import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assembleCoachContext } from "../lib/coach/assemble";
import { buildFallbackPlan, validatePlan } from "../lib/coach/generate-plan";

const e = (() => {
  const o: Record<string, string> = {};
  for (const l of readFileSync(".env.local", "utf8").split("\n")) {
    const i = l.indexOf("="); const t = l.trim();
    if (!t || t.startsWith("#") || i < 0) continue;
    o[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return { ...o, ...process.env } as Record<string, string>;
})();

describe("the fallback plan", () => {
  it("does not violate the rules the validator enforces", async () => {
    const db = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
    const ctx = await assembleCoachContext(db, {
      userId: "7e450fac-ac37-4b2e-b271-ca3afc6ae63f",
      currentWeek: 7,
    });
    const plan = buildFallbackPlan(ctx, "2026-10-12");
    const warnings = validatePlan(plan, ctx);
    if (warnings.length) console.log("\nfallback warnings:\n" + warnings.map((w) => "  ! " + w).join("\n"));
    // The fallback must satisfy every rule the validator enforces, anchors included —
    // it is the safety net for a failed generation, so it cannot itself be a bad week.
    console.log(
      "\nfallback sessions:\n" +
        plan.sessions
          .map(
            (s) =>
              `  ${s.dow} ${s.session_name} (${s.time_budget_min}m, warmup ${s.warmup_min}m)\n` +
              s.exercises.map((e) => `     - ${e.name}`).join("\n"),
          )
          .join("\n"),
    );
    expect(warnings).toEqual([]);
  }, 60_000);
});
