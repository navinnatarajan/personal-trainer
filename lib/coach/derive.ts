/**
 * The derivations that turn logged rows into the facts a coach would notice.
 *
 * Pure functions over plain data: no database, no clock, no API. Everything here is the
 * part of "knowing the user" that must be *computed* rather than asked or inferred by a
 * model — which is why it is unit-tested rather than trusted.
 *
 * The guiding distinction: stated behaviour is what someone tells you, observed
 * behaviour is what the logs say, and the gap between them is the useful information.
 */

import type {
  DatedStatement,
  MeasuredState,
  ObservedBehaviour,
  UnmetInstruction,
} from "./types";

export interface SessionRow {
  date: string;
  sessionName: string | null;
  /** 'completed' | 'missed' | 'abandoned' | 'active' | 'paused' */
  status: string;
  activeMs: number | null;
  plannedDurationMin: number | null;
}

export interface BodyMetricRow {
  date: string;
  weightLbs: number | null;
  bodyfatPct: number | null;
  waistIn: number | null;
}

const DAY_MS = 86_400_000;

const toDate = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`);

/** ISO weekday, 1 = Monday .. 7 = Sunday. */
export function isoDow(iso: string): number {
  const d = toDate(iso).getUTCDay();
  return d === 0 ? 7 : d;
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((toDate(toIso).getTime() - toDate(fromIso).getTime()) / DAY_MS);
}

/** A session counts as attempted-and-done only when it was completed. */
const isCompleted = (s: SessionRow) => s.status === "completed";
/** Planned and never started. Signal that the plan was wrong, not that the user failed. */
const isMissed = (s: SessionRow) => s.status === "missed";
/** Everything that was on the plan, however it ended. */
const wasPlanned = (s: SessionRow) =>
  isCompleted(s) || isMissed(s) || s.status === "abandoned";

/**
 * What the logs say about how someone actually trains.
 *
 * `today` is passed rather than read from the clock so this stays pure and testable.
 */
export function deriveObservedBehaviour(
  sessions: ReadonlyArray<SessionRow>,
  today: string,
  windowWeeks: number,
  budgetedSessionMin: number | null,
): ObservedBehaviour {
  const cutoff = windowWeeks * 7;
  const inWindow = sessions.filter((s) => daysBetween(s.date, today) <= cutoff);

  const completed = inWindow.filter(isCompleted);

  // Per weekday: where does the plan survive contact with the week?
  const byWeekday = Array.from({ length: 7 }, (_, i) => {
    const dow = i + 1;
    const onDay = inWindow.filter((s) => isoDow(s.date) === dow);
    return {
      dow,
      planned: onDay.filter(wasPlanned).length,
      completed: onDay.filter(isCompleted).length,
      missed: onDay.filter(isMissed).length,
    };
  }).filter((d) => d.planned > 0);

  // Per session type: which session is systematically skipped?
  const names = [...new Set(inWindow.map((s) => s.sessionName).filter(Boolean))] as string[];
  const bySessionType = names
    .map((name) => {
      const of = inWindow.filter((s) => s.sessionName === name);
      return {
        name,
        planned: of.filter(wasPlanned).length,
        completed: of.filter(isCompleted).length,
      };
    })
    .sort((a, b) => b.planned - a.planned);

  // Median, not mean: one four-hour Saturday should not move the typical session.
  const durations = completed
    .map((s) => s.activeMs)
    .filter((ms): ms is number => typeof ms === "number" && ms > 0)
    .sort((a, b) => a - b);
  const medianSessionMin =
    durations.length === 0
      ? null
      : Math.round(durations[Math.floor(durations.length / 2)] / 60_000);

  const lastCompleted = completed
    .map((s) => s.date)
    .sort()
    .at(-1);

  return {
    // Guard the divisor so a zero-week window cannot produce Infinity.
    sessionsPerWeek:
      windowWeeks > 0
        ? Math.round((completed.length / windowWeeks) * 10) / 10
        : 0,
    byWeekday,
    bySessionType,
    medianSessionMin,
    budgetedSessionMin,
    daysSinceLastSession: lastCompleted ? daysBetween(lastCompleted, today) : null,
    totalSessions: completed.length,
  };
}

/**
 * Body metrics, trended.
 *
 * The 7-day average is what gets surfaced rather than the latest reading: daily weight
 * moves with water and salt, and reacting to it is noise-chasing. Waist-to-height
 * replaces BMI, which penalises height and muscle — exactly the two things a tall person
 * pursuing a v-taper has.
 */
export function deriveMeasuredState(
  rows: ReadonlyArray<BodyMetricRow>,
  today: string,
  heightIn: number | null,
): MeasuredState {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const latest = sorted.at(-1) ?? null;

  const weighed = sorted.filter(
    (r): r is BodyMetricRow & { weightLbs: number } => r.weightLbs !== null,
  );

  const within = (days: number) =>
    weighed.filter((r) => daysBetween(r.date, today) <= days);

  const mean = (xs: number[]) =>
    xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null;

  const last7 = within(7).map((r) => r.weightLbs);
  const trend7d = mean(last7);

  // Change over 30 days: compare the recent average against the oldest reading in range,
  // so a single odd weigh-in at either end does not invent a trend.
  const last30 = within(30);
  const change30d =
    last30.length >= 2 && trend7d !== null
      ? Math.round((trend7d - last30[0].weightLbs) * 10) / 10
      : null;

  const waistIn = sorted.filter((r) => r.waistIn !== null).at(-1)?.waistIn ?? null;

  return {
    weightLbs: latest?.weightLbs ?? null,
    weightTrend7d: trend7d,
    weightChange30d: change30d,
    waistIn,
    waistToHeight:
      waistIn !== null && heightIn !== null && heightIn > 0
        ? Math.round((waistIn / heightIn) * 1000) / 1000
        : null,
    asOf: latest?.date ?? null,
  };
}

/**
 * Decays statements that have not been repeated.
 *
 * Four silent weeks about a shoulder probably means it healed. But decay is never
 * allowed to be silent — a statement going stale is what *prompts the check-in to ask*,
 * not licence to quietly ignore it. That is the consolidation pass's job.
 */
export function markStatementRecency(
  statements: ReadonlyArray<{ weekNumber: number; text: string }>,
  currentWeek: number,
  staleAfterWeeks = 3,
): DatedStatement[] {
  return statements
    .map((s) => {
      const weeksAgo = currentWeek - s.weekNumber;
      return {
        weekNumber: s.weekNumber,
        weeksAgo,
        text: s.text,
        stillCurrent: weeksAgo <= staleAfterWeeks,
      };
    })
    .sort((a, b) => a.weeksAgo - b.weeksAgo);
}

export interface PriorInstruction {
  weekNumber: number;
  exercise: string;
  instruction: string;
  /** True when the logs show the instruction was satisfied that week. */
  met: boolean;
  outcome: string;
}

/**
 * Instructions the coach gave that the logs show went unmet, oldest grievance first.
 *
 * This is the highest-value thing in the context. A coach that cannot see its own unmet
 * instruction writes it a third time — and that third repetition is the precise moment a
 * user concludes the app is not listening. Surfacing it forces escalation: change the
 * lift, drop a set, move it earlier while they are fresh.
 */
export function deriveUnmetInstructions(
  history: ReadonlyArray<PriorInstruction>,
  currentWeek: number,
): UnmetInstruction[] {
  const byExercise = new Map<string, PriorInstruction[]>();
  for (const h of history) {
    const list = byExercise.get(h.exercise) ?? [];
    list.push(h);
    byExercise.set(h.exercise, list);
  }

  const unmet: UnmetInstruction[] = [];

  for (const [exercise, entries] of byExercise) {
    const ordered = [...entries].sort((a, b) => a.weekNumber - b.weekNumber);

    // Only an unbroken run of failures up to now counts. An instruction met at any point
    // since is resolved, however many times it failed before that.
    let streak = 0;
    for (let i = ordered.length - 1; i >= 0; i--) {
      if (ordered[i].met) break;
      streak++;
    }
    if (streak === 0) continue;

    const outstanding = ordered.slice(ordered.length - streak);
    const latest = outstanding.at(-1)!;

    unmet.push({
      exercise,
      instruction: latest.instruction,
      weeksOutstanding: currentWeek - outstanding[0].weekNumber + 1,
      outcome: outstanding.map((o) => o.outcome).join("; "),
    });
  }

  return unmet.sort((a, b) => b.weeksOutstanding - a.weeksOutstanding);
}

/**
 * Weekdays where the plan keeps failing.
 *
 * A day planned repeatedly and completed rarely is the wrong day, not a discipline
 * problem — and the fix is to move the session, not to try harder.
 */
export function findProblemWeekdays(
  observed: ObservedBehaviour,
  minPlanned = 3,
): Array<{ dow: number; planned: number; completed: number }> {
  return observed.byWeekday
    .filter((d) => d.planned >= minPlanned && d.completed / d.planned < 0.5)
    .map(({ dow, planned, completed }) => ({ dow, planned, completed }));
}

/**
 * Session types completed materially less often than they are planned.
 *
 * Distinct from a problem weekday: this is "Push keeps getting skipped wherever it
 * lands", which points at the session rather than the slot.
 */
export function findNeglectedSessions(
  observed: ObservedBehaviour,
  minPlanned = 3,
): Array<{ name: string; planned: number; completed: number }> {
  return observed.bySessionType.filter(
    (s) => s.planned >= minPlanned && s.completed / s.planned < 0.6,
  );
}
