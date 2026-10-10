/**
 * Makes a real Anthropic API call. Costs roughly $0.15-0.25 per run.
 * `npm run test:integration` only — never part of `npm test`.
 *
 * The assertions check the things that must hold. The printed plan is the point: whether
 * the coaching notes sound like they know this person is not something a test can judge.
 */

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

import { assembleCoachContext } from "./assemble";
import { generateWeekPlan, type GenerateResult } from "./generate-plan";
import { renderContext } from "./prompts";
import type { CoachContext } from "./types";

function env() {
  const out: Record<string, string> = {};
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const i = line.indexOf("=");
    const t = line.trim();
    if (!t || t.startsWith("#") || i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { ...out, ...process.env } as Record<string, string>;
}

const e = env();
const USER_ID = e.INTEGRATION_USER_ID ?? "7e450fac-ac37-4b2e-b271-ca3afc6ae63f";
const WEEK_START = "2026-10-12";
const WEEK_NUMBER = 7;

describe("generateWeekPlan against real history", () => {
  let ctx: CoachContext;
  let result: GenerateResult;

  beforeAll(async () => {
    const db = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
    ctx = await assembleCoachContext(db, { userId: USER_ID, currentWeek: WEEK_NUMBER });

    const client = new Anthropic({ apiKey: e.ANTHROPIC_API_KEY });
    result = await generateWeekPlan({
      context: ctx,
      weekStart: WEEK_START,
      weekNumber: WEEK_NUMBER,
      // Override with PLAN_NOTES to try a scenario without editing this file.
      thisWeekNotes:
        e.PLAN_NOTES ??
        "Left shoulder is a bit cranky on overhead pressing. Volleyball Thursday evening.",
      client,
    });
  }, 300_000);

  it("produced a plan", () => {
    expect(result.plan.sessions.length).toBeGreaterThan(0);
    if (result.source === "fallback") {
      console.log(`\n⚠ FELL BACK: ${result.fallbackReason}\n`);
    }
  });

  it("only used exercises that exist", () => {
    const allowed = new Set(ctx.programmable.map((p) => p.name));
    const unknown: string[] = [];
    for (const s of result.plan.sessions) {
      for (const ex of s.exercises) if (!allowed.has(ex.name)) unknown.push(ex.name);
    }
    expect(unknown).toEqual([]);
  });

  it("respected the earned and hold weights computed in code", () => {
    // The whole reason progression lives in code is that it is not the model's to change.
    const weightErrors = result.warnings.filter((w) => /earned|hold at|no history/.test(w));
    expect(weightErrors).toEqual([]);
  });

  it("only scheduled days the user offered", () => {
    const dayErrors = result.warnings.filter((w) => /not available/.test(w));
    expect(dayErrors).toEqual([]);
  });

  it("prints the prompt size and the plan", () => {
    const prompt = renderContext(ctx, WEEK_START, WEEK_NUMBER, "…");
    const out: string[] = [
      "",
      "═".repeat(72),
      `SOURCE: ${result.source}${result.fallbackReason ? ` — ${result.fallbackReason}` : ""}`,
      result.usage
        ? `TOKENS: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out` +
          ` ≈ $${((result.usage.inputTokens * 5 + result.usage.outputTokens * 25) / 1_000_000).toFixed(3)}`
        : "TOKENS: n/a",
      `CONTEXT: ${prompt.length} chars rendered`,
      `WARNINGS: ${result.warnings.length}`,
      ...result.warnings.map((w) => `  ! ${w}`),
      "═".repeat(72),
      "",
      result.plan.headline.toUpperCase(),
      "",
      result.plan.week_note,
      "",
    ];

    for (const s of result.plan.sessions) {
      out.push("─".repeat(72));
      out.push(`${s.dow} ${s.date} · ${s.session_name} · ${s.time_budget_min} min`);
      out.push(`${s.headline}`);
      out.push("");
      for (const ex of s.exercises) {
        const w = ex.target_weight === null ? "find it" : `${ex.target_weight} lb`;
        out.push(
          `  ${ex.name}${ex.tag ? `  [${ex.tag}]` : ""}` +
            `${ex.superset_group ? `  (superset ${ex.superset_group})` : ""}`,
        );
        out.push(`    ${ex.sets} x ${ex.target_reps} @ ${w} · rest ${ex.rest_sec}s`);
        out.push(`    "${ex.coaching_note}"`);
        out.push("");
      }
    }
    out.push("═".repeat(72));
    const outPath = e.PLAN_OUT;
    if (outPath) {
      writeFileSync(outPath, JSON.stringify({ result, notes: e.PLAN_NOTES ?? null }, null, 2));
      console.log(`\nwrote ${outPath}`);
    }
    console.log(out.join("\n"));
    expect(result.plan.week_note.length).toBeGreaterThan(20);
  });
});
