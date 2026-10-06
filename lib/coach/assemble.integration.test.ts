/**
 * Hits the live Supabase project. Excluded from `npm test`; run with
 * `npm run test:integration`.
 *
 * This exists because the assembler is the one part of lib/coach that cannot be judged by
 * unit tests: the question is not "does the code run" but "is what the coach sees actually
 * useful". So it asserts the shape, then prints the assembled context for a human to read.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

import { assembleCoachContext } from "./assemble";
import { findNeglectedSessions, findProblemWeekdays } from "./derive";
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

describe("assembleCoachContext against the live database", () => {
  let ctx: CoachContext;

  beforeAll(async () => {
    const db = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
    // `today` deliberately omitted: it is derived from the profile's timezone, which is
    // what production does. Passing a UTC date here is what hid a day-boundary bug.
    ctx = await assembleCoachContext(db, {
      userId: USER_ID,
      currentWeek: 7,
      windowWeeks: 6,
    });
  }, 60_000);

  it("loads the profile", () => {
    expect(ctx.goals).toBeDefined();
    expect(ctx.stated.checkinDow).toBeGreaterThanOrEqual(1);
    expect(ctx.stated.checkinDow).toBeLessThanOrEqual(7);
  });

  it("derives observed behaviour from real sessions", () => {
    expect(ctx.observed.totalSessions).toBeGreaterThan(0);
    expect(Number.isFinite(ctx.observed.sessionsPerWeek)).toBe(true);
  });

  it("computes progression for every exercise in the library", () => {
    expect(ctx.progression.length).toBeGreaterThan(0);
    for (const p of ctx.progression) {
      expect(["add_weight", "add_reps", "establish_baseline"]).toContain(p.action);
      expect(p.nextWeight).toBeGreaterThanOrEqual(0);
    }
  });

  it("never proposes a weight increase for an exercise with no history", () => {
    // The guard that matters: an unseen lift must be calibrated, never progressed.
    const noHistory = new Set(
      ctx.programmable.filter((p) => !p.hasHistory).map((p) => p.name),
    );
    const byId = new Map(ctx.programmable.map((p) => [p.name, p]));
    for (const p of ctx.progression) {
      const name = [...byId.keys()].find((n) => byId.get(n));
      if (name && noHistory.has(name)) {
        expect(p.action).not.toBe("add_weight");
      }
    }
  });

  it("excludes nothing the user has ruled out from the programmable set", () => {
    for (const name of ctx.preferences.excluded) {
      expect(ctx.programmable.map((p) => p.name)).not.toContain(name);
    }
  });

  it("prints what the coach would see", () => {
    const earned = ctx.progression.filter((p) => p.action === "add_weight");
    const holding = ctx.progression.filter((p) => p.action === "add_reps");
    const toEstablish = ctx.progression.filter((p) => p.action === "establish_baseline");

    const lines = [
      "",
      "═══ WHAT THE COACH SEES ═══",
      "",
      `GOALS            ${ctx.goals.ordered.join(" > ") || "(none set)"}`,
      `LEVEL            ${ctx.goals.trainingLevel} · ${ctx.goals.lifecycleStage}`,
      `EXCLUDED         ${ctx.preferences.excluded.join(", ") || "(none)"}`,
      "",
      `MEASURED         ${ctx.measured.weightLbs ?? "—"} lbs` +
        (ctx.measured.weightTrend7d ? ` · 7d avg ${ctx.measured.weightTrend7d}` : "") +
        (ctx.measured.waistToHeight ? ` · waist/height ${ctx.measured.waistToHeight}` : ""),
      "",
      `OBSERVED         ${ctx.observed.totalSessions} sessions over ${ctx.windowWeeks}w` +
        ` = ${ctx.observed.sessionsPerWeek}/week`,
      `                 last session ${ctx.observed.daysSinceLastSession ?? "—"} days ago`,
      `                 median ${ctx.observed.medianSessionMin ?? "untimed"} min` +
        ` vs budget ${ctx.observed.budgetedSessionMin ?? "—"} min`,
      ...ctx.observed.bySessionType.map(
        (s) => `                 ${s.name.padEnd(8)} ${s.completed}/${s.planned} completed`,
      ),
      "",
      `PROBLEM DAYS     ${
        findProblemWeekdays(ctx.observed)
          .map((d) => `dow ${d.dow} (${d.completed}/${d.planned})`)
          .join(", ") || "(none)"
      }`,
      `NEGLECTED        ${
        findNeglectedSessions(ctx.observed)
          .map((s) => `${s.name} (${s.completed}/${s.planned})`)
          .join(", ") || "(none)"
      }`,
      "",
      `EARNED (${earned.length})`,
      ...earned.slice(0, 8).map((p) => `                 → ${p.nextWeight}  ${p.reason}`),
      "",
      `HOLDING (${holding.length})`,
      ...holding.slice(0, 8).map((p) => `                 = ${p.nextWeight}  ${p.reason}`),
      "",
      `TO ESTABLISH     ${toEstablish.length} lifts with no history`,
      "",
      `UNMET            ${ctx.episodic.unmetInstructions.length} outstanding instructions`,
      ...ctx.episodic.unmetInstructions.map(
        (u) => `                 ${u.exercise}: ${u.weeksOutstanding}w — ${u.outcome}`,
      ),
      `SAID BEFORE      ${ctx.episodic.statementsRaised.length} statements`,
      ...ctx.episodic.statementsRaised.map(
        (s) => `                 ${s.weeksAgo}w ago${s.stillCurrent ? "" : " (stale)"}: ${s.text}`,
      ),
      `LAST WEEK NOTES  ${ctx.episodic.lastWeekNotes.length}`,
      "",
      `PROGRAMMABLE     ${ctx.programmable.length} exercises` +
        ` (${ctx.programmable.filter((p) => p.hasHistory).length} with history)`,
      "",
    ];
    console.log(lines.join("\n"));
    expect(ctx.progression.length).toBeGreaterThan(0);
  });
});
