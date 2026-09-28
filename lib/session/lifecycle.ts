/**
 * Session timing: start, pause, resume, finish.
 *
 * The original HTML tracker inferred duration from set ticks — start was the first set
 * ticked, end was overwritten on every subsequent tick. A "22 min session" therefore
 * meant "time between the first and last logged set": no warmup, ending at the last tick
 * rather than when you left, and ballooning silently if a set went unlogged.
 *
 * This module is the state machine only — pure functions over a session record, no I/O
 * and no implicit clock. Callers pass `now` explicitly so the behaviour is testable and
 * so production can pass the *database's* time rather than the browser's. A phone with a
 * wrong clock or a mid-session timezone change must not be able to corrupt a duration.
 */

import type { SessionStatus } from "../types";

export interface SessionRecord {
  status: SessionStatus;
  startedAt: Date | null;
  endedAt: Date | null;
  /** Paused time already banked by completed pauses. */
  pausedMs: number;
  /** Set while currently paused; the current pause is not yet in `pausedMs`. */
  pausedAt: Date | null;
}

/** A session running this long is presumed forgotten rather than genuinely ongoing. */
export const STALE_AFTER_MS = 4 * 60 * 60 * 1000;

/** ...and with no set logged this recently. */
export const NO_ACTIVITY_MS = 60 * 60 * 1000;

export class SessionTransitionError extends Error {}

const MS = {
  between: (from: Date, to: Date) => to.getTime() - from.getTime(),
};

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export function isInFlight(s: SessionRecord): boolean {
  return s.status === "active" || s.status === "paused";
}

export function canPause(s: SessionRecord): boolean {
  return s.status === "active";
}

export function canResume(s: SessionRecord): boolean {
  return s.status === "paused";
}

export function canFinish(s: SessionRecord): boolean {
  return isInFlight(s);
}

// ---------------------------------------------------------------------------
// Elapsed time
// ---------------------------------------------------------------------------

/**
 * Active (unpaused) milliseconds so far.
 *
 * Returns null whenever the duration is genuinely unknown: no start time (imported
 * history), or an abandoned session whose real end time was never recorded. An unknown
 * duration must stay unknown rather than become a misleading number, so it cannot skew
 * averages.
 *
 * This deliberately mirrors the `sessions.active_ms` generated column, which is null
 * unless both `started_at` and `ended_at` are set. The two must agree — otherwise a
 * figure computed in the app disagrees with the same figure computed in SQL.
 */
export function activeMs(s: SessionRecord, now: Date): number | null {
  if (!s.startedAt) return null;
  // Abandoned sessions have no end time by design; counting up to `now` would report an
  // ever-growing duration for a session that stopped hours ago.
  if (s.status === "abandoned") return null;

  const end = s.endedAt ?? now;
  const wall = MS.between(s.startedAt, end);

  // Time inside the pause that is still open, and so not yet banked in pausedMs.
  const openPause = s.pausedAt ? MS.between(s.pausedAt, end) : 0;

  return Math.max(0, wall - s.pausedMs - openPause);
}

/** True once active time exceeds the planned budget. Drives the tracker's red clock. */
export function isOverBudget(
  s: SessionRecord,
  budgetMin: number | null,
  now: Date,
): boolean {
  if (!budgetMin) return false;
  const active = activeMs(s, now);
  if (active === null) return false;
  return active > budgetMin * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Fields to persist for a new session. `now` should be the database clock
 * (`now()`), not the browser's.
 */
export function start(now: Date): SessionRecord {
  return {
    status: "active",
    startedAt: now,
    endedAt: null,
    pausedMs: 0,
    pausedAt: null,
  };
}

export function pause(s: SessionRecord, now: Date): SessionRecord {
  if (!canPause(s)) {
    throw new SessionTransitionError(`Cannot pause a session that is ${s.status}`);
  }
  return { ...s, status: "paused", pausedAt: now };
}

/** Banks the elapsed pause into `pausedMs` and clears the open pause. */
export function resume(s: SessionRecord, now: Date): SessionRecord {
  if (!canResume(s)) {
    throw new SessionTransitionError(`Cannot resume a session that is ${s.status}`);
  }
  const banked = s.pausedAt ? Math.max(0, MS.between(s.pausedAt, now)) : 0;
  return { ...s, status: "active", pausedMs: s.pausedMs + banked, pausedAt: null };
}

/**
 * Ends the session. Finishing while paused banks the open pause first, so pausing and
 * walking out doesn't silently count as active training time.
 */
export function finish(s: SessionRecord, now: Date): SessionRecord {
  if (!canFinish(s)) {
    throw new SessionTransitionError(`Cannot finish a session that is ${s.status}`);
  }
  const settled = s.status === "paused" ? resume(s, now) : s;
  return { ...settled, status: "completed", endedAt: now };
}

// ---------------------------------------------------------------------------
// Forgotten sessions
// ---------------------------------------------------------------------------

/**
 * True when a session looks forgotten rather than ongoing: in flight for longer than
 * STALE_AFTER_MS with no set logged within NO_ACTIVITY_MS.
 *
 * Without this, one session left running overnight permanently skews every duration
 * average. Abandoned sessions keep their logged sets — the sets happened; only the
 * duration is untrustworthy.
 */
export function shouldAbandon(
  s: SessionRecord,
  now: Date,
  lastSetLoggedAt: Date | null,
): boolean {
  if (!isInFlight(s) || !s.startedAt) return false;
  if (MS.between(s.startedAt, now) <= STALE_AFTER_MS) return false;

  const lastActivity = lastSetLoggedAt ?? s.startedAt;
  return MS.between(lastActivity, now) > NO_ACTIVITY_MS;
}

export function abandon(s: SessionRecord): SessionRecord {
  if (!isInFlight(s)) {
    throw new SessionTransitionError(`Cannot abandon a session that is ${s.status}`);
  }
  // endedAt deliberately stays null: the real end time is unknown, and guessing it
  // would reintroduce exactly the bad data this module exists to remove.
  return { ...s, status: "abandoned", pausedAt: null };
}

// ---------------------------------------------------------------------------
// Manual correction
// ---------------------------------------------------------------------------

export interface TimeEdit {
  startedAt: Date;
  endedAt: Date;
}

/**
 * Applies a user correction to a finished session. People forget to hit start, so the
 * times have to stay editable — a design that assumes otherwise just reintroduces bad
 * data by another route.
 *
 * Banked pause time is dropped: once the window is restated by hand, the recorded pauses
 * no longer describe it, and silently subtracting them would understate the duration.
 */
export function applyTimeEdit(
  s: SessionRecord,
  edit: TimeEdit,
  now: Date,
): SessionRecord {
  if (edit.endedAt.getTime() < edit.startedAt.getTime()) {
    throw new SessionTransitionError("Session cannot end before it starts");
  }
  if (edit.startedAt.getTime() > now.getTime()) {
    throw new SessionTransitionError("Session cannot start in the future");
  }
  if (edit.endedAt.getTime() > now.getTime()) {
    throw new SessionTransitionError("Session cannot end in the future");
  }
  return {
    ...s,
    status: "completed",
    startedAt: edit.startedAt,
    endedAt: edit.endedAt,
    pausedMs: 0,
    pausedAt: null,
  };
}
