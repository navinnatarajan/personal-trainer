import { describe, expect, it } from "vitest";

import {
  epley1RM,
  hitTopOfRange,
  mostRecentSession,
  parseRepRange,
  progressionState,
  volume,
} from "./progression";
import type { Exercise, ExerciseSession, ExerciseTarget } from "./types";

/** DB shoulder press — the exercise the `Start Here` sheet uses as its worked example. */
const shoulderPress: Exercise = {
  id: "ex-shoulder-press",
  name: "DB Shoulder Press",
  muscleGroup: "Shoulders",
  equipment: "dumbbell",
  unit: "lb",
  incrementLbs: 2.5,
};

const pullup: Exercise = {
  id: "ex-pullup",
  name: "Pull-up",
  muscleGroup: "Back",
  equipment: "bodyweight",
  unit: "BW",
  incrementLbs: 0,
};

const noTarget: ExerciseTarget = {
  exerciseId: shoulderPress.id,
  baselineWeight: 45,
  nextTarget: null,
};

function session(
  reps: number[],
  weightLbs = 45,
  targetReps = "6-8",
  date = new Date("2026-08-24"),
  exerciseId = shoulderPress.id,
): ExerciseSession {
  return {
    exerciseId,
    date,
    targetReps,
    sets: reps.map((r, i) => ({
      setNumber: i + 1,
      weightLbs,
      reps: r,
      rir: null,
    })),
  };
}

describe("parseRepRange", () => {
  it("parses a range", () => {
    expect(parseRepRange("6-8")).toEqual({ bottom: 6, top: 8, openEnded: false });
  });

  it("parses an exact count", () => {
    expect(parseRepRange("8")).toEqual({ bottom: 8, top: 8, openEnded: false });
  });

  it("parses an open-ended target, treating the number as the bar to clear", () => {
    expect(parseRepRange("10+")).toEqual({ bottom: 10, top: 10, openEnded: true });
  });

  it("tolerates whitespace", () => {
    expect(parseRepRange(" 6 - 8 ")).toEqual({ bottom: 6, top: 8, openEnded: false });
  });

  it("throws rather than guess at a malformed range", () => {
    expect(() => parseRepRange("eight")).toThrow(/Unrecognised rep range/);
    expect(() => parseRepRange("")).toThrow(/Unrecognised rep range/);
  });

  it("throws on reversed bounds", () => {
    expect(() => parseRepRange("8-6")).toThrow(/bounds reversed/);
  });
});

describe("spreadsheet formulas", () => {
  // Both asserted against values the original spreadsheet computed itself.
  it("matches the sheet's Est 1RM (Epley)", () => {
    expect(epley1RM(115, 8)).toBeCloseTo(145.7, 1);
    expect(epley1RM(45, 8)).toBeCloseTo(57.0, 1);
    expect(epley1RM(115, 7)).toBeCloseTo(141.8, 1);
  });

  it("matches the sheet's volume", () => {
    expect(volume(115, 8)).toBe(920);
    expect(volume(115, 7)).toBe(805);
    expect(volume(45, 8)).toBe(360);
  });
});

describe("hitTopOfRange", () => {
  it("is true when every set reached the top", () => {
    expect(hitTopOfRange([{ reps: 8 }, { reps: 8 }, { reps: 8 }], 8)).toBe(true);
  });

  it("is true when sets exceeded the top", () => {
    expect(hitTopOfRange([{ reps: 9 }, { reps: 8 }], 8)).toBe(true);
  });

  it("is false when any single set fell short", () => {
    expect(hitTopOfRange([{ reps: 8 }, { reps: 8 }, { reps: 7 }], 8)).toBe(false);
  });

  it("is false for unreported reps, so incomplete logging never earns a jump", () => {
    expect(hitTopOfRange([{ reps: 8 }, { reps: 8 }, { reps: null }], 8)).toBe(false);
  });

  it("is false with no sets at all", () => {
    expect(hitTopOfRange([], 8)).toBe(false);
  });
});

describe("progressionState — the Start Here worked example", () => {
  // "Shoulder press 45 lbs at 8/7/6 -> stay at 45 until you get 8/8/8 -> then 47.5."
  it("holds weight at 8/7/6 and asks for reps", () => {
    const state = progressionState([session([8, 7, 6])], shoulderPress, noTarget);
    expect(state.action).toBe("add_reps");
    expect(state.nextWeight).toBe(45);
    expect(state.reason).toMatch(/8\/7\/6/);
  });

  it("adds the smallest increment at 8/8/8", () => {
    const state = progressionState([session([8, 8, 8])], shoulderPress, noTarget);
    expect(state.action).toBe("add_weight");
    expect(state.nextWeight).toBe(47.5);
  });

  it("does not progress when only the last set falls short", () => {
    const state = progressionState([session([8, 8, 7])], shoulderPress, noTarget);
    expect(state.action).toBe("add_reps");
    expect(state.nextWeight).toBe(45);
  });

  it("keeps the prescribed rep range when adding weight", () => {
    const state = progressionState([session([8, 8, 8])], shoulderPress, noTarget);
    expect(state.nextTargetReps).toBe("6-8");
  });
});

describe("progressionState — other cases", () => {
  it("establishes a baseline when there is no history", () => {
    const state = progressionState([], shoulderPress, noTarget);
    expect(state.action).toBe("establish_baseline");
    expect(state.nextWeight).toBe(45);
  });

  it("handles no history and no baseline without inventing a weight", () => {
    const state = progressionState([], shoulderPress, {
      exerciseId: shoulderPress.id,
      baselineWeight: null,
      nextTarget: null,
    });
    expect(state.action).toBe("establish_baseline");
    expect(state.nextWeight).toBe(0);
    expect(state.reason).toMatch(/reps in reserve/);
  });

  it("never adds weight to a bodyweight exercise", () => {
    const cleared = progressionState(
      [session([12, 12, 12], 0, "10+", new Date("2026-08-24"), pullup.id)],
      pullup,
      { exerciseId: pullup.id, baselineWeight: null, nextTarget: null },
    );
    expect(cleared.action).toBe("add_reps");
    expect(cleared.nextWeight).toBe(0);
    expect(cleared.reason).toMatch(/no weight to add/);
  });

  it("clears an open-ended target when every set meets the floor", () => {
    const state = progressionState(
      [session([10, 10, 10], 17.5, "10+")],
      shoulderPress,
      noTarget,
    );
    expect(state.action).toBe("add_weight");
    expect(state.nextWeight).toBe(20);
  });

  it("uses the most recent session, not the first or the best", () => {
    const history = [
      session([8, 8, 8], 45, "6-8", new Date("2026-08-17")), // older, cleared
      session([6, 6, 5], 47.5, "6-8", new Date("2026-08-24")), // newer, did not clear
    ];
    const state = progressionState(history, shoulderPress, noTarget);
    expect(state.action).toBe("add_reps");
    expect(state.nextWeight).toBe(47.5);
  });

  it("ignores other exercises' history", () => {
    const history = [
      session([8, 8, 8], 100, "6-8", new Date("2026-08-24"), "ex-something-else"),
    ];
    const state = progressionState(history, shoulderPress, noTarget);
    expect(state.action).toBe("establish_baseline");
  });
});

describe("mostRecentSession", () => {
  it("returns undefined when there is no history for the exercise", () => {
    expect(mostRecentSession([], shoulderPress.id)).toBeUndefined();
  });

  it("skips sessions with no sets logged", () => {
    const empty: ExerciseSession = {
      exerciseId: shoulderPress.id,
      date: new Date("2026-08-31"),
      targetReps: "6-8",
      sets: [],
    };
    const real = session([8, 8, 8], 45, "6-8", new Date("2026-08-24"));
    expect(mostRecentSession([empty, real], shoulderPress.id)).toBe(real);
  });
});
