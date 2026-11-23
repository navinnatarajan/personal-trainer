import { describe, expect, it } from "vitest";

import { MAX_PASTE_CHARS, extractProposals, proposalKey } from "./consolidate";
import type { CoachContext } from "./types";

const emptyContext = {
  identity: { sex: null, heightIn: null, birthYear: null },
  environment: { gymType: null, equipment: [], gymName: null },
  preferences: {
    stylePreference: null,
    excluded: [],
    anchors: [],
    favourites: [],
    durableConstraints: null,
  },
  goals: {
    ordered: [],
    lifecycleStage: "building_habits",
    trainingLevel: "novice",
    splitPreference: "coach_decides",
  },
  stated: { days: [], checkinDow: 7 },
  activities: [],
  measured: {
    weightLbs: null,
    weightTrend7d: null,
    weightChange30d: null,
    waistIn: null,
    waistToHeight: null,
    asOf: null,
  },
  observed: {
    sessionsPerWeek: 0,
    byWeekday: [],
    bySessionType: [],
    medianSessionMin: null,
    budgetedSessionMin: null,
    daysSinceLastSession: null,
    totalSessions: 0,
  },
  episodic: {
    unmetInstructions: [],
    standingAdjustments: [],
    statementsRaised: [],
    lastWeekNotes: [],
  },
  progression: [],
  exerciseNames: {},
  programmable: [],
  windowWeeks: 4,
  generatedAt: new Date().toISOString(),
} satisfies CoachContext;

describe("extractProposals input guards", () => {
  // These run without a model call: the guards must reject before spending anything.
  it("rejects empty text", async () => {
    const res = await extractProposals({ text: "   ", context: emptyContext, today: "2026-11-23" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/nothing to read/i);
  });

  it("rejects a paste beyond the cap, and says how long it was", async () => {
    const res = await extractProposals({
      text: "x".repeat(MAX_PASTE_CHARS + 1),
      context: emptyContext,
      today: "2026-11-23",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/most recent part/i);
  });
});

describe("proposalKey", () => {
  // Keys are content-derived rather than index-based: the list re-renders as the user
  // toggles proposals, and an index would silently reassign their selections.
  it("distinguishes proposals about different activities", () => {
    const a = proposalKey({
      kind: "remove_activity",
      name: "Basketball",
      summary: "",
      evidence: "",
    });
    const b = proposalKey({
      kind: "remove_activity",
      name: "Volleyball",
      summary: "",
      evidence: "",
    });
    expect(a).not.toBe(b);
  });

  it("distinguishes adding from removing the same activity", () => {
    const add = proposalKey({
      kind: "add_activity",
      name: "Swimming",
      dows: [7],
      intensity: "light",
      summary: "",
      evidence: "",
    });
    const remove = proposalKey({
      kind: "remove_activity",
      name: "Swimming",
      summary: "",
      evidence: "",
    });
    expect(add).not.toBe(remove);
  });

  it("is case-insensitive, since the model echoes the text's capitalisation", () => {
    const upper = proposalKey({
      kind: "exclude_exercise",
      name: "Hack Squat",
      summary: "",
      evidence: "",
    });
    const lower = proposalKey({
      kind: "exclude_exercise",
      name: "hack squat",
      summary: "",
      evidence: "",
    });
    expect(upper).toBe(lower);
  });

  it("gives singleton proposals a stable key", () => {
    expect(
      proposalKey({ kind: "set_goals", goals: ["v_taper"], summary: "", evidence: "" }),
    ).toBe("set_goals");
  });
});
