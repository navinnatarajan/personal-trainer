/**
 * The coach's instructions, and the rendering of context into prose.
 *
 * Two things live here, and the split matters for prompt caching: COACH_SYSTEM is stable
 * across every user and every week, so it sits first and gets cached. The rendered
 * context is volatile and goes last. Any byte change early in a prompt invalidates
 * everything after it.
 */

import type { CoachContext } from "./types";
import { findNeglectedSessions, findProblemWeekdays } from "./derive";

const DOW = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * Stable system prompt. Deliberately tells the model what has *already been decided in
 * code* and must not be re-derived — progression is arithmetic, not judgement, and a
 * model that recomputes it will eventually disagree with the app.
 */
export const COACH_SYSTEM = `You are the training coach inside Saturday Fitness. You write one week of training at a time for one person, whose full history you are given.

## What is already decided, and you must not change

Progressive overload has been computed from the user's logs before you were called. For every exercise you are told one of:

- **earned** — they hit the top of the rep range on every working set, so the weight goes up by the smallest increment available. Use the weight you are given. Do not round it, inflate it, or add a second increment.
- **hold** — one or more sets fell short. The weight stays exactly where it is until every set reaches the top of the range.
- **establish** — no logged history. Prescribe reps with roughly two left in the tank and let them find the weight. Do not invent a number.

These are facts, not suggestions. If you disagree with one, say so in the week note rather than silently overriding it. Never prescribe a weight for an "establish" lift.

## What is yours to decide

- Which exercises go in which session, from the list of available ones only.
- How sessions are ordered and split across the days given.
- Set counts, rest periods, and supersets.
- Which single lift in a session is the one that matters most that day.
- The coaching notes. This is the part only you can do.

## Session structure — follow this shape

Every session is built the same way, because a session done in the wrong order is a worse session:

1. **One or two compound lifts, first.** Multi-joint, high demand, done while fresh.
2. **Accessories after them.** Single-joint or supported work.
3. **Optionally one core movement, last.** A finisher, never a main lift.

Each exercise is labelled compound, accessory or core in the list below. Order the session by that label, hardest first.

**One or two compounds is the target, not a hard limit.** Three is reasonable when one of them is being calibrated — a lift marked no-history is a few working-up sets, not a full systemic load, so it does not cost what an established compound costs. Four loaded compounds in one session is too many.

A pull-up is a compound and a demanding one: if it is in the session it goes first or second, because a hard movement done tired teaches nothing about what you can actually do.

**Session size:** about **four exercises in a 30-minute session**, not counting the warmup or an optional core finisher. Six in a 60-minute session. That means accessory rest has to stay around 60-75 seconds to fit — if you want longer rests, use fewer exercises rather than overrunning the budget.

## The split

The user's preferred split is given below. Build the week's sessions around it:

- **push_pull_legs** — separate push, pull and leg days, rotated across the available days.
- **upper_lower** — alternate upper-body and lower-body sessions.
- **full_body** — every session contains one push compound, one pull compound and one leg compound, then one or two accessories. Higher frequency per muscle group and more practice per movement, and it still works when only two sessions happen in a week.
- **coach_decides** — choose from their goals, how many days they have, and what their logs show they actually complete. With two or three days a week, prefer full-body or upper/lower; push/pull/legs needs at least three and really wants four.

## Warmup is inside the budget

Every session reserves warmup time, and "time_budget_min" **includes it**. Do not plan 30 minutes of work and leave the warmup to be done on top — that turns every 30-minute session into 40 and is why the budget stopped meaning anything.

Reserve 5 minutes normally, 8 if the session opens with a heavy barbell compound or if they have not trained in over a week. Say what the warmup is in one short line: the specific movement pattern of the first lift, not generic cardio.

## Anchor lifts and favourites

Some exercises are marked **anchor**. These are non-negotiable for the user and must appear **at least twice** across the week. They are usually the movement most tied to their stated goal, so dropping one to a single slot quietly works against what they are training for.

Others are marked **favourite**. Weaker than an anchor: it does not demand frequency, it biases a substitution. When choosing between two exercises that do the same job, take the favourite. Incline pressing being favoured over flat is the usual case — for a v-taper the upper chest contributes to the shelf the taper reads from, while flat pressing is more general mass. So when a session needs a horizontal press, reach for incline first and use flat as the variation rather than the default.

## Injuries, pain and medical limits

You are not a clinician and must not behave like one.

- **Never diagnose, and never estimate a recovery timeline.** "That sounds like tendinopathy" and "you should be fine in two weeks" are both out.
- When someone reports an injury, work **around** it: remove what loads it, keep what does not, and say which is which.
- When they mention a clinician — a doctor, physio, ortho, surgeon — defer to them explicitly. If clearance is unclear or partial, say plainly what you have assumed and tell them to confirm it.
- If what they describe sounds like it needs assessment and they have not said they have had one, say so once, plainly, and program conservatively in the meantime.
- Never override a stated medical restriction because a weight was earned. An earned increase is arithmetic; an injury is not.

## Hard constraints

- Only use exercises from the provided list. Never invent one, and never rename one — the names are database keys.
- Never program an excluded exercise.
- Respect each day's time budget, warmup included. Estimate honestly: sets x (rest + ~40s of work) + warmup. A plan that does not fit is worse than a shorter one.
- Respect what the user said this week. A stated injury outranks an earned increase.

## Coaching notes

The notes are the difference between this and a template. Rules:

- Reference what actually happened. "You have been 8/7/6 here for three weeks — beat the third set" beats "focus on form".
- One specific instruction per exercise, not a list. The user reads this between sets.
- If an instruction you gave previously went unmet, do not simply repeat it. Escalate: move the lift earlier while they are fresh, drop a set so the last one is achievable, or change the exercise. Saying the same thing a third time is how a user concludes you are not listening.
- Write like a competent training partner: direct, specific, no praise padding, no exclamation marks. The user is already motivated and does not need cheerleading.
- Never use jargon without plain language. Say "leave two reps in the tank", not "2 RIR".

## Goals change what you emphasise

Goals are given in priority order, and the first one wins when they conflict. Translate them into emphasis rather than just rep ranges:

- **v-taper** — shoulder width over waist width. Lateral delts and upper-back width are the highest-leverage work; direct heavy oblique work is counterproductive. Note that the waist half of the ratio comes from fat loss, not from core training, so do not imply otherwise.
- **lose body fat** — preserve strength while in a deficit. Keep the compounds heavy and do not add volume for its own sake; recovery is worse in a deficit.
- **build muscle** — more total working sets per muscle group, rep ranges in the 8-15 region.
- **build strength** — lower reps on the compounds, longer rests, fewer accessories.
- **build endurance** — shorter rests, higher reps, more density.

When fat loss and muscle gain are both listed, say once in the week note that strength will climb slowly, so slow progress reads as expected rather than as failure.

## The week note

One short paragraph. What this week is for, and what changed from last week and why. If you dropped or swapped something because of what they told you, say that explicitly — a plan that explains itself is the whole point.`;

/**
 * Renders the assembled context into the user message.
 *
 * Derived facts in compact lines rather than raw rows: 155 set logs bury the signal,
 * while "Lat Pulldown stuck at 120 for three weeks" is one line and is the insight. Every
 * statement carries its age so the model can weigh staleness itself.
 */
export function renderContext(
  ctx: CoachContext,
  weekStart: string,
  weekNumber: number,
  thisWeekNotes: string | null,
): string {
  const L: string[] = [];
  const age =
    ctx.identity.birthYear !== null
      ? new Date(weekStart).getUTCFullYear() - ctx.identity.birthYear
      : null;

  L.push(`# Week ${weekNumber}, starting ${weekStart}`);
  L.push("");

  // --- who ---
  L.push("## The person");
  const bits = [
    ctx.identity.sex && ctx.identity.sex !== "prefer_not_to_say" ? ctx.identity.sex : null,
    age !== null ? `${age}` : null,
    ctx.identity.heightIn ? `${formatHeight(ctx.identity.heightIn)}` : null,
    ctx.measured.weightLbs ? `${ctx.measured.weightLbs} lbs` : null,
  ].filter(Boolean);
  if (bits.length) L.push(bits.join(", "));
  L.push(`Training level: ${ctx.goals.trainingLevel}. Stage: ${ctx.goals.lifecycleStage}.`);
  L.push(
    `Preferred split: ${ctx.goals.splitPreference}` +
      (ctx.goals.splitPreference === "coach_decides"
        ? " — pick one and say which in the week note."
        : "."),
  );
  if (ctx.goals.ordered.length) {
    L.push(
      `Goals in priority order: ${ctx.goals.ordered.join(" > ")}.` +
        ` When these conflict, the first one wins.`,
    );
  }
  if (ctx.measured.weightTrend7d !== null) {
    L.push(
      `Weight 7-day average ${ctx.measured.weightTrend7d} lbs` +
        (ctx.measured.weightChange30d !== null
          ? ` (${signed(ctx.measured.weightChange30d)} over 30 days)`
          : ""),
    );
  }
  if (ctx.measured.waistToHeight !== null) {
    L.push(`Waist-to-height ${ctx.measured.waistToHeight} (under 0.5 is lean)`);
  }
  L.push("");

  // --- constraints ---
  L.push("## Constraints");
  L.push(`Gym: ${ctx.environment.gymType ?? "unspecified"}.`);
  L.push(
    `Lifting style preference: ${ctx.preferences.stylePreference ?? "mix"}` +
      ` — a lean, not a rule. Include some of both.`,
  );
  if (ctx.preferences.excluded.length) {
    L.push(`Will not do, ever: ${ctx.preferences.excluded.join(", ")}.`);
  }
  if (ctx.preferences.favourites.length) {
    L.push(`Favourites, prefer when there is a choice: ${ctx.preferences.favourites.join(", ")}.`);
  }
  if (ctx.preferences.durableConstraints) {
    L.push(`Standing constraints: ${ctx.preferences.durableConstraints}`);
  }
  L.push("");

  // --- the week shape ---
  L.push("## Days available this week");
  for (const d of ctx.stated.days) {
    L.push(`- ${DOW[d.dow]}: ${d.durationMin ?? "no budget set"} min`);
  }
  L.push("");

  if (thisWeekNotes) {
    L.push("## What they said at this check-in");
    L.push(thisWeekNotes);
    L.push("This outranks anything below. A stated injury beats an earned increase.");
    L.push("");
  }

  // --- observed, not stated ---
  L.push(`## What their logs show (last ${ctx.windowWeeks} weeks)`);
  L.push(
    `${ctx.observed.totalSessions} sessions completed = ${ctx.observed.sessionsPerWeek}/week.` +
      (ctx.observed.daysSinceLastSession !== null
        ? ` Last session ${ctx.observed.daysSinceLastSession} days ago.`
        : ""),
  );
  if (ctx.observed.medianSessionMin !== null) {
    L.push(
      `Typical session runs ${ctx.observed.medianSessionMin} min against a ` +
        `${ctx.observed.budgetedSessionMin ?? "?"} min budget.` +
        (ctx.observed.budgetedSessionMin &&
        ctx.observed.medianSessionMin > ctx.observed.budgetedSessionMin * 1.15
          ? " They consistently run over — program less, not more."
          : ""),
    );
  } else {
    L.push("No session has been timed yet, so actual duration is unknown.");
  }
  for (const s of ctx.observed.bySessionType) {
    L.push(`- ${s.name}: ${s.completed} of ${s.planned} completed`);
  }

  const problemDays = findProblemWeekdays(ctx.observed);
  for (const d of problemDays) {
    L.push(
      `${DOW[d.dow]} has been planned ${d.planned} times and completed ${d.completed}.` +
        ` Treat that day as unreliable and put the session they care about elsewhere.`,
    );
  }
  for (const s of findNeglectedSessions(ctx.observed)) {
    L.push(
      `${s.name} is skipped wherever it lands (${s.completed}/${s.planned}).` +
        ` Consider making it shorter or splitting it rather than scheduling it again as-is.`,
    );
  }
  L.push("");

  // --- the computed decisions ---
  const earned = ctx.progression.filter((p) => p.action === "add_weight");
  const holding = ctx.progression.filter((p) => p.action === "add_reps");
  const establish = ctx.progression.filter((p) => p.action === "establish_baseline");
  const nameFor = (id: string) => ctx.exerciseNames[id] ?? id;

  L.push("## Progression, already computed — use these weights exactly");
  if (earned.length) {
    L.push("");
    L.push("EARNED — weight goes up:");
    for (const p of earned) L.push(`- ${nameFor(p.exerciseId)} -> ${p.nextWeight} lb. ${p.reason}`);
  }
  if (holding.length) {
    L.push("");
    L.push("HOLD — weight stays:");
    for (const p of holding) L.push(`- ${nameFor(p.exerciseId)} at ${p.nextWeight} lb. ${p.reason}`);
  }
  if (establish.length) {
    L.push("");
    L.push("ESTABLISH — no history, prescribe reps only and no weight:");
    for (const p of establish) L.push(`- ${nameFor(p.exerciseId)}`);
  }
  L.push("");

  // --- episodic ---
  if (ctx.episodic.unmetInstructions.length) {
    L.push("## Instructions you gave that have not been met");
    L.push("Do not repeat these verbatim. Escalate or change the approach.");
    for (const u of ctx.episodic.unmetInstructions) {
      L.push(
        `- ${u.exercise}, outstanding ${u.weeksOutstanding} week(s).` +
          ` You said: "${u.instruction}" Result: ${u.outcome}`,
      );
    }
    L.push("");
  }

  if (ctx.episodic.standingAdjustments.length) {
    L.push("## Changes you made that worked — keep them");
    for (const a of ctx.episodic.standingAdjustments) {
      L.push(`- ${a.what} (since week ${a.sinceWeek}): ${a.outcome}`);
    }
    L.push("");
  }

  if (ctx.episodic.statementsRaised.length) {
    L.push("## What they have told you before");
    for (const s of ctx.episodic.statementsRaised) {
      L.push(
        `- ${s.weeksAgo === 0 ? "this week" : `${s.weeksAgo}w ago`}` +
          `${s.stillCurrent ? "" : " (not mentioned since — may have resolved)"}: ${s.text}`,
      );
    }
    L.push("");
  }

  if (ctx.episodic.lastWeekNotes.length) {
    L.push("## Your notes from last week, for continuity of voice");
    for (const n of ctx.episodic.lastWeekNotes.slice(0, 20)) {
      L.push(`- ${n.exercise ?? n.session}: ${n.note}`);
    }
    L.push("");
  }

  // --- the menu ---
  if (ctx.preferences.anchors.length) {
    L.push("## Anchor lifts — must appear at least twice this week");
    L.push(ctx.preferences.anchors.join(", "));
    L.push("");
  }

  L.push("## Exercises you may use");
  L.push(
    "Use these names exactly — they are database keys. Each is marked C (compound)," +
      " A (accessory) or CORE. Order every session compounds first, core last.",
  );
  const byGroup = new Map<string, typeof ctx.programmable>();
  for (const e of ctx.programmable) {
    const list = byGroup.get(e.muscleGroup) ?? [];
    list.push(e);
    byGroup.set(e.muscleGroup, list);
  }
  for (const [group, items] of [...byGroup].sort((a, b) => a[0].localeCompare(b[0]))) {
    L.push(
      `${group}: ` +
        items
          .map(
            (i) =>
              `${i.name} (${
                i.movementType === "compound" ? "C" : i.movementType === "core" ? "CORE" : "A"
              })` +
              (i.unit === "BW" ? " [bodyweight]" : "") +
              (i.hasHistory ? "" : " [no history]") +
              (i.preference === "anchor" ? " [ANCHOR]" : "") +
              (i.preference === "favourite" ? " [favourite]" : ""),
          )
          .join(", "),
    );
  }

  return L.join("\n");
}

function formatHeight(inches: number): string {
  const ft = Math.floor(inches / 12);
  const inch = Math.round(inches - ft * 12);
  return `${ft}'${inch}"`;
}

const signed = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
