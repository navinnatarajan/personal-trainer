/**
 * Turns an assembled CoachContext into a validated week plan.
 *
 * The only model call in the weekly loop. Structured output rather than prose parsing:
 * a plan is data, and "parse a schedule out of paragraphs" is a failure mode waiting to
 * happen on a Sunday evening.
 *
 * Every failure path ends in a usable week. A plain-but-correct plan built from
 * progression.ts beats an error message when someone is trying to train tomorrow.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import type { CoachContext } from "./types";
import { COACH_SYSTEM, renderContext } from "./prompts";

export const MODEL = "claude-opus-5";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const PlannedExerciseSchema = z.object({
  /** Must match an exercise name from the context exactly — these are database keys. */
  name: z.string(),
  sets: z.number().int().min(1).max(10),
  /**
   * Null for an establish-baseline lift: the user finds the weight. A number here would
   * be invented, which is the thing the calibration week exists to avoid.
   */
  target_weight: z.number().nullable(),
  target_reps: z.string(),
  rest_sec: z.number().int().min(0).max(600),
  /** Exercises sharing a group within a session are supersetted. */
  superset_group: z.string().nullable(),
  /** A short flag like "THE TEST" or "PR ATTEMPT". At most one per session. */
  tag: z.string().nullable(),
  coaching_note: z.string(),
});

const PlannedSessionSchema = z.object({
  dow: z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]),
  date: z.string(),
  session_name: z.string(),
  /** Inclusive of warmup. Previously the warmup happened on top, so 30 became 40. */
  time_budget_min: z.number().int().min(5).max(300),
  warmup_min: z.number().int().min(0).max(30),
  /** One line, specific to the first lift's movement pattern — not generic cardio. */
  warmup_note: z.string(),
  headline: z.string(),
  exercises: z.array(PlannedExerciseSchema).min(1),
});

export const WeekPlanSchema = z.object({
  headline: z.string(),
  /** What this week is for and what changed from last week. */
  week_note: z.string(),
  sessions: z.array(PlannedSessionSchema).min(1),
});

export type WeekPlan = z.infer<typeof WeekPlanSchema>;
export type PlannedSession = z.infer<typeof PlannedSessionSchema>;
export type PlannedExercise = z.infer<typeof PlannedExerciseSchema>;

export interface GenerateResult {
  plan: WeekPlan;
  /** How it was produced. `fallback` means the model call failed and code built the week. */
  source: "model" | "fallback";
  /** Why the fallback ran, when it did. Surfaced to the user, not swallowed. */
  fallbackReason?: string;
  usage?: { inputTokens: number; outputTokens: number };
  /** Problems found by validation. Non-empty does not mean unusable. */
  warnings: string[];
}

export interface GenerateOptions {
  context: CoachContext;
  weekStart: string;
  weekNumber: number;
  /** What the user typed at this check-in. Outranks everything derived. */
  thisWeekNotes?: string | null;
  client?: Anthropic;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export async function generateWeekPlan(opts: GenerateOptions): Promise<GenerateResult> {
  const { context, weekStart, weekNumber, thisWeekNotes = null } = opts;
  const client = opts.client ?? new Anthropic();

  const userMessage = renderContext(context, weekStart, weekNumber, thisWeekNotes);

  try {
    const res = await client.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      // Programming a week around competing constraints is exactly the case for it.
      thinking: { type: "adaptive" },
      output_config: {
        effort: "high",
        format: zodOutputFormat(WeekPlanSchema),
      },
      system: [
        {
          type: "text",
          text: COACH_SYSTEM,
          // Stable across every user and week, so it caches. Volatile context goes last:
          // any byte change early in a prompt invalidates everything after it.
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userMessage }],
    });

    // Safety classifiers can decline with HTTP 200. Check before reading content.
    if (res.stop_reason === "refusal") {
      return fallbackResult(
        context,
        weekStart,
        `The model declined to answer (${res.stop_details?.category ?? "unknown"}).`,
      );
    }

    if (!res.parsed_output) {
      return fallbackResult(context, weekStart, "The model's reply did not match the schema.");
    }

    return {
      plan: res.parsed_output,
      source: "model",
      usage: {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
      },
      warnings: validatePlan(res.parsed_output, context),
    };
  } catch (err) {
    return fallbackResult(
      context,
      weekStart,
      err instanceof Error ? err.message : "The plan request failed.",
    );
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Checks the plan against the things the schema cannot express.
 *
 * Returns warnings rather than throwing: a week with one exercise slightly over budget is
 * still trainable, and discarding it would leave the user with nothing. The caller shows
 * these alongside the plan so a wrong one is visible rather than silently accepted.
 */
export function validatePlan(plan: WeekPlan, ctx: CoachContext): string[] {
  const warnings: string[] = [];

  const allowed = new Map(ctx.programmable.map((e) => [e.name, e]));
  const excluded = new Set(ctx.preferences.excluded);
  const prog = new Map(
    ctx.progression.map((p) => [ctx.exerciseNames[p.exerciseId] ?? p.exerciseId, p]),
  );

  for (const session of plan.sessions) {
    for (const ex of session.exercises) {
      // An invented or renamed exercise cannot be stored — the names are foreign keys.
      if (!allowed.has(ex.name)) {
        warnings.push(
          `"${ex.name}" in ${session.session_name} is not an available exercise.` +
            (excluded.has(ex.name) ? " It is on the excluded list." : ""),
        );
        continue;
      }

      const p = prog.get(ex.name);
      if (!p) continue;

      // A bodyweight movement has no weight to prescribe, so null is the correct answer
      // and 0 would be a lie. progression.ts reports nextWeight 0 for these; treat either
      // as valid rather than demanding a number that means nothing.
      const bodyweight = allowed.get(ex.name)?.unit === "BW";
      if (bodyweight) {
        if (ex.target_weight !== null && ex.target_weight !== 0) {
          warnings.push(
            `${ex.name} is bodyweight but the plan prescribes ${ex.target_weight} lb.`,
          );
        }
        continue;
      }

      // The whole point of computing progression in code is that it is not negotiable.
      if (p.action === "add_weight" && ex.target_weight !== p.nextWeight) {
        warnings.push(
          `${ex.name} earned ${p.nextWeight} lb but the plan says ` +
            `${ex.target_weight ?? "none"}.`,
        );
      }
      if (p.action === "add_reps" && ex.target_weight !== p.nextWeight) {
        warnings.push(
          `${ex.name} should hold at ${p.nextWeight} lb but the plan says ` +
            `${ex.target_weight ?? "none"}.`,
        );
      }
      if (p.action === "establish_baseline" && ex.target_weight !== null) {
        warnings.push(
          `${ex.name} has no history, so the weight should be left for the user to find,` +
            ` but the plan prescribes ${ex.target_weight} lb.`,
        );
      }
    }

    // --- session structure ---
    //
    // Enforced rather than hoped for. A session done in the wrong order is a worse
    // session: the hardest movement done last is the one that teaches you least.
    const types = session.exercises.map(
      (e) => allowed.get(e.name)?.movementType ?? "accessory",
    );
    const compoundCount = types.filter((x) => x === "compound").length;

    if (compoundCount === 0) {
      warnings.push(`${session.session_name} on ${session.dow} has no compound lift.`);
    }
    if (compoundCount > 2) {
      warnings.push(
        `${session.session_name} on ${session.dow} has ${compoundCount} compounds.` +
          ` Two is the maximum — a third means none of them gets done properly.`,
      );
    }

    // Compounds must come before accessories, and core is a finisher.
    const firstAccessory = types.indexOf("accessory");
    const lastCompound = types.lastIndexOf("compound");
    if (firstAccessory !== -1 && lastCompound > firstAccessory) {
      warnings.push(
        `${session.session_name} on ${session.dow} puts a compound after an accessory.` +
          ` Compounds go first, while fresh.`,
      );
    }
    const firstCore = types.indexOf("core");
    if (firstCore !== -1 && firstCore !== types.length - 1) {
      warnings.push(
        `${session.session_name} on ${session.dow} has core work before the end.` +
          ` Core is a finisher.`,
      );
    }

    // Exercise count against the budget. Beyond this a plan stops getting followed.
    const maxExercises = session.time_budget_min <= 35 ? 4 : session.time_budget_min <= 65 ? 6 : 7;
    if (session.exercises.length > maxExercises) {
      warnings.push(
        `${session.session_name} on ${session.dow} has ${session.exercises.length} exercises` +
          ` in ${session.time_budget_min} min. Around ${maxExercises} is the ceiling.`,
      );
    }

    // --- warmup and time ---
    if (session.warmup_min === 0) {
      warnings.push(`${session.session_name} on ${session.dow} reserves no warmup time.`);
    }
    // The budget is inclusive, so the warmup is counted here rather than added.
    const estimated = Math.round(
      session.exercises.reduce((a, e) => a + e.sets * (e.rest_sec + 40), 0) / 60 +
        session.warmup_min,
    );
    if (estimated > session.time_budget_min * 1.2) {
      warnings.push(
        `${session.session_name} on ${session.dow} needs about ${estimated} min against a ` +
          `${session.time_budget_min} min budget (including ${session.warmup_min} min warmup).`,
      );
    }
  }

  // --- anchors ---
  //
  // Non-negotiable lifts, so a single appearance across a week is a failure rather than a
  // judgement call. Lateral Raise is the case: most-trained lift in the library, the
  // highest-leverage movement for a v-taper, and the first generated plan gave it one slot.
  const appearances = new Map<string, number>();
  for (const s of plan.sessions) {
    for (const ex of s.exercises) {
      appearances.set(ex.name, (appearances.get(ex.name) ?? 0) + 1);
    }
  }
  for (const anchor of ctx.preferences.anchors) {
    const n = appearances.get(anchor) ?? 0;
    if (n < 2) {
      warnings.push(
        `${anchor} is an anchor lift and appears ${n} time(s). It needs at least twice.`,
      );
    }
  }

  // A day the user did not offer cannot be trained on.
  const availableDow = new Set(ctx.stated.days.map((d) => d.dow));
  const dowIndex: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  if (availableDow.size > 0) {
    for (const s of plan.sessions) {
      if (!availableDow.has(dowIndex[s.dow])) {
        warnings.push(`${s.session_name} is scheduled on ${s.dow}, which is not available.`);
      }
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

/**
 * A week built entirely from computed progression, with no model involvement.
 *
 * Runs when generation fails. Deliberately plain — grouped by muscle group, no coaching
 * notes, no cleverness — and labelled as a fallback so it is never mistaken for the real
 * thing. The alternative is telling someone they have no plan the night before training.
 */
export function buildFallbackPlan(
  ctx: CoachContext,
  weekStart: string,
): WeekPlan {
  const days = ctx.stated.days.length
    ? ctx.stated.days
    : [
        { dow: 1, durationMin: 30 },
        { dow: 4, durationMin: 30 },
      ];

  const progByName = new Map(
    ctx.progression.map((p) => [ctx.exerciseNames[p.exerciseId] ?? p.exerciseId, p]),
  );

  // Sessions are built around movement patterns, not muscle groups. Grouping by muscle
  // produced a "Biceps day" and a "Core day" — neither of which is a session, and the
  // latter has no compound at all.
  const pattern = (muscleGroup: string): "push" | "pull" | "legs" | "other" => {
    if (muscleGroup === "Back") return "pull";
    if (muscleGroup === "Chest" || muscleGroup === "Shoulders") return "push";
    if (muscleGroup === "Legs") return "legs";
    return "other";
  };

  const compoundsBy = (p: "push" | "pull" | "legs") =>
    ctx.programmable.filter(
      (e) => e.movementType === "compound" && pattern(e.muscleGroup) === p,
    );

  // Accessories that belong with each pattern. Arms ride along with the press/pull day
  // that trains them, which is how anyone actually splits a week.
  const accessoriesBy = (p: "push" | "pull" | "legs") =>
    ctx.programmable.filter((e) => {
      if (e.movementType !== "accessory") return false;
      const g = e.muscleGroup;
      if (p === "push") return g === "Chest" || g === "Shoulders" || g === "Triceps";
      if (p === "pull") return g === "Back" || g === "Biceps" || g === "Shoulders";
      return g === "Legs";
    });

  const coreWork = ctx.programmable.filter((e) => e.movementType === "core");
  const anchors = new Set(ctx.preferences.anchors);
  const anchorPool = ctx.programmable.filter((e) => anchors.has(e.name));

  // Only patterns that actually have a compound available can become a session.
  const rotation = (["push", "pull", "legs"] as const).filter(
    (p) => compoundsBy(p).length > 0,
  );

  const anchorUses = new Map<string, number>();

  const sessions = days.map((day, i) => {
    const budget = day.durationMin ?? 30;
    const pat = rotation.length ? rotation[i % rotation.length] : "push";
    const maxExercises = budget <= 35 ? 4 : 6;

    const chosen: typeof ctx.programmable = [];
    chosen.push(...compoundsBy(pat).slice(0, budget <= 35 ? 1 : 2));

    // Anchors come next so they are never crowded out by whatever happened to sort first.
    for (const a of anchorPool) {
      if (chosen.length >= maxExercises - 1) break;
      if ((anchorUses.get(a.name) ?? 0) >= 2) continue;
      if (chosen.some((c) => c.name === a.name)) continue;
      chosen.push(a);
      anchorUses.set(a.name, (anchorUses.get(a.name) ?? 0) + 1);
    }

    for (const acc of accessoriesBy(pat)) {
      if (chosen.length >= maxExercises - (coreWork.length ? 1 : 0)) break;
      if (chosen.some((c) => c.name === acc.name)) continue;
      chosen.push(acc);
    }

    // Core last, and only ever as a finisher.
    if (coreWork.length && chosen.length < maxExercises) {
      chosen.push(coreWork[i % coreWork.length]);
    }

    const rank = { compound: 0, accessory: 1, core: 2 } as const;
    chosen.sort((a, b) => rank[a.movementType] - rank[b.movementType]);

    return {
      dow: DOW_NAME[day.dow] ?? "Mon",
      date: addDays(weekStart, day.dow - 1),
      session_name: pat === "push" ? "Push" : pat === "pull" ? "Pull" : "Legs",
      time_budget_min: budget,
      warmup_min: 5,
      warmup_note:
        "Five minutes: light sets of the first movement, building up to the working weight.",
      headline: "Built without the coach — the weights are right, the programming is basic.",
      exercises: chosen.map((e) => {
        const p = progByName.get(e.name);
        const establishing = !p || p.action === "establish_baseline";
        const bodyweight = e.unit === "BW";
        return {
          name: e.name,
          sets: 3,
          target_weight: establishing || bodyweight ? null : p.nextWeight,
          target_reps: establishing ? "8" : p.nextTargetReps,
          rest_sec: e.movementType === "compound" ? 120 : 60,
          superset_group: null,
          tag: null,
          coaching_note: establishing
            ? "No history for this one. Work up until you could manage about two more reps, then log it."
            : p.reason,
        };
      }),
    };
  });

  return {
    headline: "Fallback week",
    week_note:
      "The coach could not be reached, so this week was built from your progression data alone." +
      " The weights are right; the exercise selection is mechanical. Regenerate when you can.",
    sessions: sessions.filter((s) => s.exercises.length > 0),
  };
}

function fallbackResult(
  ctx: CoachContext,
  weekStart: string,
  reason: string,
): GenerateResult {
  const plan = buildFallbackPlan(ctx, weekStart);
  return {
    plan,
    source: "fallback",
    fallbackReason: reason,
    warnings: validatePlan(plan, ctx),
  };
}

/** ISO weekday to label. A record rather than a 1-indexed array, so index 0 cannot leak
 *  an empty string into a field the schema requires to be a real day. */
const DOW_NAME: Record<number, PlannedSession["dow"]> = {
  1: "Mon",
  2: "Tue",
  3: "Wed",
  4: "Thu",
  5: "Fri",
  6: "Sat",
  7: "Sun",
};

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
