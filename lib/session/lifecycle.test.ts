import { describe, expect, it } from "vitest";

import {
  NO_ACTIVITY_MS,
  SessionTransitionError,
  STALE_AFTER_MS,
  abandon,
  activeMs,
  applyTimeEdit,
  finish,
  isOverBudget,
  pause,
  resume,
  shouldAbandon,
  start,
  type SessionRecord,
} from "./lifecycle";

const T0 = new Date("2026-08-24T07:00:00Z");
const min = (n: number) => n * 60 * 1000;
const at = (msAfterT0: number) => new Date(T0.getTime() + msAfterT0);

describe("start", () => {
  it("opens an active session with a clean slate", () => {
    const s = start(T0);
    expect(s).toEqual({
      status: "active",
      startedAt: T0,
      endedAt: null,
      pausedMs: 0,
      pausedAt: null,
    });
  });
});

describe("activeMs", () => {
  it("counts wall-clock time for an uninterrupted session", () => {
    const s = start(T0);
    expect(activeMs(s, at(min(30)))).toBe(min(30));
  });

  it("stops counting once the session is finished", () => {
    const done = finish(start(T0), at(min(30)));
    // An hour later, the number must not have moved.
    expect(activeMs(done, at(min(90)))).toBe(min(30));
  });

  it("excludes an open pause while it is still running", () => {
    let s = start(T0);
    s = pause(s, at(min(10)));
    // 20 minutes of wall clock, but 10 of them paused.
    expect(activeMs(s, at(min(20)))).toBe(min(10));
  });

  it("excludes banked pauses after resuming", () => {
    let s = start(T0);
    s = pause(s, at(min(10)));
    s = resume(s, at(min(15))); // 5 min paused
    expect(activeMs(s, at(min(30)))).toBe(min(25));
  });

  it("handles several pauses in one session", () => {
    let s = start(T0);
    s = pause(s, at(min(10)));
    s = resume(s, at(min(12))); // 2 min
    s = pause(s, at(min(20)));
    s = resume(s, at(min(25))); // 5 min
    s = finish(s, at(min(40)));
    expect(activeMs(s, at(min(60)))).toBe(min(33));
  });

  it("returns null when the session never started, rather than a misleading zero", () => {
    // How imported history arrives: the sets are known, the duration is not.
    const imported: SessionRecord = {
      status: "completed",
      startedAt: null,
      endedAt: null,
      pausedMs: 0,
      pausedAt: null,
    };
    expect(activeMs(imported, at(min(60)))).toBeNull();
  });

  it("never returns a negative duration", () => {
    const weird: SessionRecord = {
      status: "completed",
      startedAt: T0,
      endedAt: at(min(10)),
      pausedMs: min(999), // more paused time than wall clock
      pausedAt: null,
    };
    expect(activeMs(weird, at(min(20)))).toBe(0);
  });
});

describe("pause and resume", () => {
  it("banks the pause duration on resume", () => {
    let s = start(T0);
    s = pause(s, at(min(10)));
    s = resume(s, at(min(17)));
    expect(s.pausedMs).toBe(min(7));
    expect(s.pausedAt).toBeNull();
    expect(s.status).toBe("active");
  });

  it("refuses to pause a session that is not active", () => {
    const paused = pause(start(T0), at(min(5)));
    expect(() => pause(paused, at(min(6)))).toThrow(SessionTransitionError);
  });

  it("refuses to resume a session that is not paused", () => {
    expect(() => resume(start(T0), at(min(5)))).toThrow(SessionTransitionError);
  });
});

describe("finish", () => {
  it("banks an open pause so walking out while paused is not counted as training", () => {
    let s = start(T0);
    s = pause(s, at(min(20)));
    // Paused, then finished 40 minutes later without resuming.
    s = finish(s, at(min(60)));
    expect(s.status).toBe("completed");
    expect(activeMs(s, at(min(90)))).toBe(min(20));
  });

  it("refuses to finish an already-completed session", () => {
    const done = finish(start(T0), at(min(30)));
    expect(() => finish(done, at(min(40)))).toThrow(SessionTransitionError);
  });
});

describe("isOverBudget", () => {
  it("is false inside the budget", () => {
    expect(isOverBudget(start(T0), 30, at(min(29)))).toBe(false);
  });

  it("is true past the budget", () => {
    expect(isOverBudget(start(T0), 30, at(min(31)))).toBe(true);
  });

  it("ignores paused time, so a long break is not counted against the budget", () => {
    let s = start(T0);
    s = pause(s, at(min(10)));
    s = resume(s, at(min(40))); // 30 minutes paused
    expect(isOverBudget(s, 30, at(min(45)))).toBe(false);
  });

  it("is false when there is no budget", () => {
    expect(isOverBudget(start(T0), null, at(min(600)))).toBe(false);
  });
});

describe("shouldAbandon", () => {
  it("leaves a normal in-progress session alone", () => {
    const s = start(T0);
    expect(shouldAbandon(s, at(min(45)), at(min(40)))).toBe(false);
  });

  it("flags a session running for hours with no recent sets", () => {
    const s = start(T0);
    const now = at(STALE_AFTER_MS + min(30));
    expect(shouldAbandon(s, now, at(min(20)))).toBe(true);
  });

  it("does not flag a long session that is still being logged", () => {
    // A genuine 5-hour day, still active: someone logged a set 10 minutes ago.
    const s = start(T0);
    const now = at(STALE_AFTER_MS + min(60));
    const recentSet = new Date(now.getTime() - min(10));
    expect(shouldAbandon(s, now, recentSet)).toBe(false);
  });

  it("flags a stale session that never logged a set at all", () => {
    const s = start(T0);
    expect(shouldAbandon(s, at(STALE_AFTER_MS + NO_ACTIVITY_MS + min(1)), null)).toBe(
      true,
    );
  });

  it("never flags an already-finished session", () => {
    const done = finish(start(T0), at(min(30)));
    expect(shouldAbandon(done, at(min(9999)), null)).toBe(false);
  });

  it("abandons without inventing an end time", () => {
    const s = abandon(start(T0));
    expect(s.status).toBe("abandoned");
    expect(s.endedAt).toBeNull();
  });

  it("reports an unknown duration for an abandoned session, not a growing one", () => {
    // Must match the sessions.active_ms generated column, which is null without an
    // ended_at. Counting up to `now` would report days for a session that stopped hours
    // ago, and would quietly corrupt any average computed in the app rather than in SQL.
    const s = abandon(start(T0));
    expect(activeMs(s, at(min(300)))).toBeNull();
    expect(activeMs(s, at(min(9999)))).toBeNull();
  });

  it("excludes abandoned sessions from over-budget styling", () => {
    const s = abandon(start(T0));
    expect(isOverBudget(s, 30, at(min(9999)))).toBe(false);
  });
});

describe("applyTimeEdit", () => {
  it("lets a forgotten start be corrected after the fact", () => {
    const s = finish(start(at(min(20))), at(min(50)));
    const corrected = applyTimeEdit(
      s,
      { startedAt: T0, endedAt: at(min(50)) },
      at(min(55)),
    );
    expect(activeMs(corrected, at(min(55)))).toBe(min(50));
  });

  it("discards stale pause bookkeeping when the window is restated", () => {
    let s = start(T0);
    s = pause(s, at(min(10)));
    s = resume(s, at(min(20)));
    s = finish(s, at(min(40)));
    const corrected = applyTimeEdit(
      s,
      { startedAt: T0, endedAt: at(min(40)) },
      at(min(45)),
    );
    expect(corrected.pausedMs).toBe(0);
    expect(activeMs(corrected, at(min(45)))).toBe(min(40));
  });

  it("rejects an end before the start", () => {
    const s = finish(start(T0), at(min(30)));
    expect(() =>
      applyTimeEdit(s, { startedAt: at(min(30)), endedAt: T0 }, at(min(40))),
    ).toThrow(/cannot end before it starts/i);
  });

  it("rejects times in the future", () => {
    const s = finish(start(T0), at(min(30)));
    expect(() =>
      applyTimeEdit(s, { startedAt: T0, endedAt: at(min(999)) }, at(min(40))),
    ).toThrow(/future/i);
    expect(() =>
      applyTimeEdit(s, { startedAt: at(min(500)), endedAt: at(min(600)) }, at(min(40))),
    ).toThrow(/future/i);
  });
});

describe("the bug this module replaces", () => {
  it("counts warmup, which tick-inferred timing missed entirely", () => {
    // Old behaviour: start = first set ticked. Arriving at 07:00 and first working set
    // at 07:12 recorded a 12-minute-shorter session.
    const s = finish(start(T0), at(min(42)));
    expect(activeMs(s, at(min(50)))).toBe(min(42));
  });

  it("does not balloon when a set goes unlogged for a long stretch", () => {
    // Old behaviour: end = last tick, so forgetting to log until the next morning
    // recorded an overnight session. Here the end time is an explicit action.
    const s = finish(start(T0), at(min(35)));
    expect(activeMs(s, at(min(60 * 14)))).toBe(min(35));
  });
});
