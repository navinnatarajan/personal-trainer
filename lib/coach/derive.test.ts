import { describe, expect, it } from "vitest";

import {
  daysBetween,
  deriveMeasuredState,
  deriveObservedBehaviour,
  deriveUnmetInstructions,
  findNeglectedSessions,
  findProblemWeekdays,
  isoDow,
  markStatementRecency,
  type PriorInstruction,
  type SessionRow,
} from "./derive";

const TODAY = "2026-10-03";

function session(
  date: string,
  sessionName: string | null,
  status: string,
  activeMs: number | null = null,
): SessionRow {
  return { date, sessionName, status, activeMs, plannedDurationMin: 30 };
}

describe("date helpers", () => {
  it("returns ISO weekdays with Sunday as 7", () => {
    expect(isoDow("2026-09-28")).toBe(1); // Monday
    expect(isoDow("2026-10-03")).toBe(6); // Saturday
    expect(isoDow("2026-10-04")).toBe(7); // Sunday, not 0
  });

  it("counts whole days between dates", () => {
    expect(daysBetween("2026-09-21", "2026-10-03")).toBe(12);
    expect(daysBetween("2026-10-03", "2026-10-03")).toBe(0);
  });
});

describe("deriveObservedBehaviour", () => {
  // Navin's real shape: 11 completed sessions over five weeks.
  const real = [
    session("2026-08-24", "Push", "completed", 22 * 60_000),
    session("2026-08-25", "Pull", "completed", 31 * 60_000),
    session("2026-08-28", "Legs", "completed", 34 * 60_000),
    session("2026-08-31", "Pull", "completed", 29 * 60_000),
    session("2026-09-01", "Push", "completed", 27 * 60_000),
    session("2026-09-02", "Arms", "completed", 30 * 60_000),
    session("2026-09-05", "Legs", "completed", 88 * 60_000),
    session("2026-09-06", "Pull", "completed", 33 * 60_000),
    session("2026-09-08", "Pull", "completed", 30 * 60_000),
    session("2026-09-14", "Legs", "completed", 36 * 60_000),
    session("2026-09-21", "Pull", "completed", 35 * 60_000),
  ];

  it("reports the real training frequency, not the stated one", () => {
    // The gap between "I train 4 days a week" and this number is the useful information.
    const o = deriveObservedBehaviour(real, "2026-09-28", 5, 30);
    expect(o.totalSessions).toBe(11);
    expect(o.sessionsPerWeek).toBeCloseTo(2.2, 1);
  });

  it("uses the median session length so one long Saturday doesn't skew it", () => {
    const o = deriveObservedBehaviour(real, "2026-09-28", 5, 30);
    // An 88-minute session is present; the median must stay near the typical 30.
    expect(o.medianSessionMin).toBeLessThan(40);
    expect(o.medianSessionMin).toBeGreaterThan(25);
  });

  it("counts days since the last completed session", () => {
    const o = deriveObservedBehaviour(real, "2026-09-28", 5, 30);
    expect(o.daysSinceLastSession).toBe(7);
  });

  it("excludes sessions outside the window", () => {
    const o = deriveObservedBehaviour(real, "2026-09-28", 1, 30);
    expect(o.totalSessions).toBe(1); // only 21 Sep falls inside seven days
  });

  it("counts missed sessions as planned but not completed", () => {
    const o = deriveObservedBehaviour(
      [
        session("2026-09-28", "Legs", "missed"),
        session("2026-09-29", "Pull", "completed", 30 * 60_000),
      ],
      TODAY,
      1,
      30,
    );
    const legs = o.bySessionType.find((s) => s.name === "Legs")!;
    expect(legs.planned).toBe(1);
    expect(legs.completed).toBe(0);
    expect(o.totalSessions).toBe(1);
  });

  it("reports no median duration when nothing was timed", () => {
    // How the imported history arrives: sets known, durations never recorded.
    const untimed = [session("2026-09-21", "Pull", "completed", null)];
    const o = deriveObservedBehaviour(untimed, TODAY, 4, 30);
    expect(o.medianSessionMin).toBeNull();
  });

  it("does not divide by zero on an empty window", () => {
    const o = deriveObservedBehaviour([], TODAY, 0, 30);
    expect(o.sessionsPerWeek).toBe(0);
    expect(Number.isFinite(o.sessionsPerWeek)).toBe(true);
  });
});

describe("findProblemWeekdays", () => {
  it("flags a day that is planned often and completed rarely", () => {
    // Thursday: four attempts, one success. The day is wrong, not the person.
    const sessions = [
      session("2026-09-03", "Legs", "missed"),
      session("2026-09-10", "Legs", "missed"),
      session("2026-09-17", "Legs", "completed", 30 * 60_000),
      session("2026-09-24", "Legs", "missed"),
    ];
    const o = deriveObservedBehaviour(sessions, "2026-09-28", 5, 30);
    const problems = findProblemWeekdays(o);
    expect(problems).toHaveLength(1);
    expect(problems[0].dow).toBe(4); // Thursday
    expect(problems[0].completed).toBe(1);
  });

  it("does not flag a day with too little evidence", () => {
    const o = deriveObservedBehaviour([session("2026-09-24", "Legs", "missed")], "2026-09-28", 5, 30);
    expect(findProblemWeekdays(o)).toHaveLength(0);
  });

  it("does not flag a day that mostly works", () => {
    const sessions = [
      session("2026-09-03", "Legs", "completed", 30 * 60_000),
      session("2026-09-10", "Legs", "completed", 30 * 60_000),
      session("2026-09-17", "Legs", "completed", 30 * 60_000),
      session("2026-09-24", "Legs", "missed"),
    ];
    const o = deriveObservedBehaviour(sessions, "2026-09-28", 5, 30);
    expect(findProblemWeekdays(o)).toHaveLength(0);
  });
});

describe("findNeglectedSessions", () => {
  it("flags a session type that keeps getting skipped wherever it lands", () => {
    const sessions = [
      session("2026-09-01", "Push", "missed"),
      session("2026-09-08", "Push", "missed"),
      session("2026-09-16", "Push", "completed", 30 * 60_000),
      session("2026-09-02", "Pull", "completed", 30 * 60_000),
      session("2026-09-09", "Pull", "completed", 30 * 60_000),
      session("2026-09-17", "Pull", "completed", 30 * 60_000),
    ];
    const o = deriveObservedBehaviour(sessions, "2026-09-28", 5, 30);
    const neglected = findNeglectedSessions(o);
    expect(neglected.map((n) => n.name)).toEqual(["Push"]);
  });
});

describe("deriveMeasuredState", () => {
  it("surfaces the 7-day average rather than the latest reading", () => {
    // Daily weight is water and salt; 193.0 on one day must not read as a 3 lb gain.
    const m = deriveMeasuredState(
      [
        { date: "2026-09-29", weightLbs: 190.0, bodyfatPct: null, waistIn: null },
        { date: "2026-10-01", weightLbs: 189.5, bodyfatPct: null, waistIn: null },
        { date: "2026-10-03", weightLbs: 193.0, bodyfatPct: null, waistIn: null },
      ],
      TODAY,
      75,
    );
    expect(m.weightLbs).toBe(193.0);
    expect(m.weightTrend7d).toBeCloseTo(190.8, 1);
  });

  it("computes waist-to-height, which BMI would get wrong at this height", () => {
    const m = deriveMeasuredState(
      [{ date: "2026-10-03", weightLbs: 190, bodyfatPct: null, waistIn: 34 }],
      TODAY,
      75, // 6'3"
    );
    expect(m.waistToHeight).toBeCloseTo(0.453, 3);
    expect(m.waistToHeight!).toBeLessThan(0.5); // the common lean threshold
  });

  it("carries the oldest waist reading forward when the newest row omits it", () => {
    const m = deriveMeasuredState(
      [
        { date: "2026-09-01", weightLbs: 190, bodyfatPct: null, waistIn: 35 },
        { date: "2026-10-03", weightLbs: 189, bodyfatPct: null, waistIn: null },
      ],
      TODAY,
      75,
    );
    expect(m.waistIn).toBe(35);
  });

  it("reports nulls rather than zeros with no data", () => {
    const m = deriveMeasuredState([], TODAY, 75);
    expect(m.weightLbs).toBeNull();
    expect(m.weightTrend7d).toBeNull();
    expect(m.waistToHeight).toBeNull();
  });

  it("will not invent a 30-day trend from a single reading", () => {
    const m = deriveMeasuredState(
      [{ date: "2026-10-02", weightLbs: 190, bodyfatPct: null, waistIn: null }],
      TODAY,
      75,
    );
    expect(m.weightChange30d).toBeNull();
  });
});

describe("markStatementRecency", () => {
  it("keeps recent statements current and lets old ones go stale", () => {
    const out = markStatementRecency(
      [
        { weekNumber: 7, text: "volleyball Thursday" },
        { weekNumber: 3, text: "left shoulder cranky on presses" },
      ],
      7,
    );
    expect(out[0].text).toBe("volleyball Thursday");
    expect(out[0].weeksAgo).toBe(0);
    expect(out[0].stillCurrent).toBe(true);

    const old = out.find((s) => s.weekNumber === 3)!;
    expect(old.weeksAgo).toBe(4);
    // Stale means "ask about it", never "silently ignore it".
    expect(old.stillCurrent).toBe(false);
  });

  it("orders most recent first", () => {
    const out = markStatementRecency(
      [
        { weekNumber: 2, text: "old" },
        { weekNumber: 6, text: "newer" },
        { weekNumber: 4, text: "middle" },
      ],
      7,
    );
    expect(out.map((s) => s.text)).toEqual(["newer", "middle", "old"]);
  });
});

describe("deriveUnmetInstructions", () => {
  const pulldown = (week: number, met: boolean, outcome: string): PriorInstruction => ({
    weekNumber: week,
    exercise: "Wide Grip Lat Pulldown",
    instruction: "Beat the third set — that is the entire job of this session.",
    met,
    outcome,
  });

  it("surfaces an instruction unmet two weeks running", () => {
    const unmet = deriveUnmetInstructions(
      [pulldown(5, false, "120 x 12/12/10"), pulldown(6, false, "120 x 12/12/10")],
      6,
    );
    expect(unmet).toHaveLength(1);
    expect(unmet[0].weeksOutstanding).toBe(2);
    expect(unmet[0].outcome).toContain("12/12/10");
  });

  it("treats an instruction met since as resolved, however often it failed before", () => {
    const unmet = deriveUnmetInstructions(
      [
        pulldown(4, false, "120 x 12/12/9"),
        pulldown(5, false, "120 x 12/12/10"),
        pulldown(6, true, "120 x 12/12/12"),
      ],
      6,
    );
    expect(unmet).toHaveLength(0);
  });

  it("restarts the count after a success", () => {
    const unmet = deriveUnmetInstructions(
      [
        pulldown(3, false, "fail"),
        pulldown(4, true, "cleared"),
        pulldown(5, false, "fail"),
        pulldown(6, false, "fail"),
      ],
      6,
    );
    expect(unmet[0].weeksOutstanding).toBe(2); // not 4
  });

  it("puts the longest-standing grievance first", () => {
    const unmet = deriveUnmetInstructions(
      [
        pulldown(5, false, "a"),
        pulldown(6, false, "b"),
        {
          weekNumber: 6,
          exercise: "Chest Press (Hammer)",
          instruction: "Hold 45 until all three sets reach 10.",
          met: false,
          outcome: "45 x 10/10/6",
        },
      ],
      6,
    );
    expect(unmet[0].exercise).toBe("Wide Grip Lat Pulldown");
    expect(unmet[0].weeksOutstanding).toBe(2);
    expect(unmet[1].weeksOutstanding).toBe(1);
  });

  it("returns nothing with no history", () => {
    expect(deriveUnmetInstructions([], 1)).toEqual([]);
  });
});
