/**
 * Turns free text into proposed profile changes.
 *
 * Two entry points use this: pasting a conversation during onboarding to skip filling in
 * a form, and pasting one later to correct a profile that has gone stale. Both run the
 * same extraction, because they are the same problem — a human has described themselves
 * somewhere else and should not have to retype it.
 *
 * **Nothing here ever writes.** It proposes; the user confirms. That is not timidity, it
 * is the design: a silent rewrite of someone's profile from an offhand remark is how an
 * assistant ends up confidently knowing you wrong, which is worse than not knowing you at
 * all. The confirmation step is also the moment the memory becomes visible, and visible
 * recall is what makes an assistant feel like it is paying attention.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import type { CoachContext } from "./types";

export const CONSOLIDATE_MODEL = "claude-opus-5";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const DowArray = z.array(z.number().int().min(1).max(7)).max(7);

/**
 * One proposed change, as a discriminated union.
 *
 * A union rather than a loose `{ field, value: unknown }`: the model fills a typed shape
 * far more reliably than a free-form value, and a malformed proposal is caught by the
 * schema rather than at write time.
 */
const ProposalSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("add_activity"),
    name: z.string().min(1).max(60),
    dows: DowArray,
    intensity: z.enum(["light", "moderate", "hard"]),
    summary: z.string(),
    evidence: z.string(),
  }),
  z.object({
    kind: z.literal("remove_activity"),
    name: z.string().min(1).max(60),
    summary: z.string(),
    evidence: z.string(),
  }),
  z.object({
    kind: z.literal("update_activity"),
    name: z.string().min(1).max(60),
    dows: DowArray,
    intensity: z.enum(["light", "moderate", "hard"]),
    summary: z.string(),
    evidence: z.string(),
  }),
  z.object({
    kind: z.literal("set_training_days"),
    /** Every trainable day with its budget. Days omitted become rest days. */
    days: z
      .array(
        z.object({
          dow: z.number().int().min(1).max(7),
          durationMin: z.number().int().min(5).max(300),
        }),
      )
      .max(7),
    summary: z.string(),
    evidence: z.string(),
  }),
  z.object({
    kind: z.literal("set_durable_constraints"),
    /** Null clears it — used when a restriction has expired. */
    text: z.string().max(2000).nullable(),
    summary: z.string(),
    evidence: z.string(),
  }),
  z.object({
    kind: z.literal("exclude_exercise"),
    name: z.string().min(1).max(80),
    summary: z.string(),
    evidence: z.string(),
  }),
  z.object({
    kind: z.literal("unexclude_exercise"),
    name: z.string().min(1).max(80),
    summary: z.string(),
    evidence: z.string(),
  }),
  z.object({
    kind: z.literal("set_goals"),
    goals: z
      .array(
        z.enum([
          "lose_body_fat",
          "v_taper",
          "build_muscle",
          "build_strength",
          "build_endurance",
        ]),
      )
      .min(1)
      .max(3),
    summary: z.string(),
    evidence: z.string(),
  }),
  z.object({
    kind: z.literal("set_split_preference"),
    split: z.enum(["push_pull_legs", "upper_lower", "full_body", "coach_decides"]),
    summary: z.string(),
    evidence: z.string(),
  }),
  z.object({
    kind: z.literal("set_measurements"),
    weightLbs: z.number().min(50).max(700).nullable(),
    waistIn: z.number().min(15).max(80).nullable(),
    summary: z.string(),
    evidence: z.string(),
  }),
]);

export const ConsolidationSchema = z.object({
  /** One line on what the text appeared to be. Shown so the user can tell it read right. */
  interpretation: z.string(),
  proposals: z.array(ProposalSchema).max(20),
  /** Things that looked relevant but were too ambiguous to propose. Surfaced, not hidden. */
  unclear: z.array(z.string()).max(10),
});

export type Proposal = z.infer<typeof ProposalSchema>;
export type Consolidation = z.infer<typeof ConsolidationSchema>;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const CONSOLIDATE_SYSTEM = `You read text a person has written or pasted — a conversation with an AI assistant, notes, a message to a coach — and extract what it says about how they train.

You produce **proposals**, never changes. A human reviews everything you return. That means you should propose anything you have real evidence for, but never invent.

## Rules

- **Every proposal needs evidence**, and the evidence must be a short quote from the text, not your inference from it. If you cannot quote it, do not propose it.
- **Only propose what changed.** You are given the profile as it currently stands. If the text confirms something already true, say nothing about it — a list full of no-op confirmations buries the real changes.
- **Prefer removal when something has clearly stopped.** "I don't play basketball any more" and "my Tuesday league ended" are both removals. So is a dated restriction whose date has passed.
- **Never guess at days or numbers.** If someone says they train "a few times a week" without saying which days, that goes in \`unclear\`, not into a proposal with days you made up.
- **Exercise names must match the user's library exactly** when proposing to exclude or re-include something. The names are database keys. If the text mentions a lift that is not in their library, put it in \`unclear\` instead.
- **Flag anything ambiguous** in \`unclear\` rather than resolving it yourself. A short note the user can act on is more useful than a confident wrong answer.

## On expired constraints

Pay attention to dates. A restriction written weeks ago saying "for the next month" may have lapsed. If the text gives you reason to believe a stored constraint no longer applies, propose clearing or replacing it and quote what tells you so.

## Tone of summaries

Each \`summary\` is shown to the user as the thing they are agreeing to. Write it as a plain statement of the change: "Remove Basketball — no longer playing Tuesdays", not "The user indicated that basketball participation has ceased."`;

/** Renders the current profile so the model proposes only differences. */
export function renderCurrentProfile(ctx: CoachContext): string {
  const DOW = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const L: string[] = ["## Profile as it stands now", ""];

  L.push(`Goals, in priority order: ${ctx.goals.ordered.join(" > ") || "(none set)"}`);
  L.push(`Split preference: ${ctx.goals.splitPreference}`);
  L.push(`Training level: ${ctx.goals.trainingLevel}`);
  L.push("");

  L.push("Training days:");
  if (ctx.stated.days.length) {
    for (const d of ctx.stated.days) {
      L.push(`- ${DOW[d.dow]}: ${d.durationMin ?? "no budget"} min`);
    }
  } else {
    L.push("- (none set)");
  }
  L.push("");

  L.push("Activities outside the gym:");
  if (ctx.activities.length) {
    for (const a of ctx.activities) {
      const when = a.dows.length ? a.dows.map((d) => DOW[d]).join(", ") : "irregular";
      L.push(`- ${a.name} (${a.intensity}) on ${when}`);
    }
  } else {
    L.push("- (none recorded)");
  }
  L.push("");

  L.push(`Standing constraints: ${ctx.preferences.durableConstraints ?? "(none)"}`);
  L.push(`Will not do: ${ctx.preferences.excluded.join(", ") || "(nothing excluded)"}`);
  L.push(
    `Measurements: ${ctx.measured.weightLbs ?? "?"} lbs` +
      (ctx.measured.waistIn ? `, waist ${ctx.measured.waistIn} in` : ", waist not recorded"),
  );
  L.push("");

  L.push("Exercise library (names are exact keys):");
  L.push(ctx.programmable.map((e) => e.name).join(", "));

  return L.join("\n");
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export interface ConsolidateResult {
  ok: boolean;
  consolidation?: Consolidation;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/** Maximum pasted text accepted. Long enough for a real conversation, bounded for cost. */
export const MAX_PASTE_CHARS = 60_000;

export async function extractProposals(opts: {
  text: string;
  context: CoachContext;
  /** Today in the user's timezone, so "for the next month" can be judged against a date. */
  today: string;
  client?: Anthropic;
}): Promise<ConsolidateResult> {
  const text = opts.text.trim();
  if (!text) return { ok: false, error: "There was nothing to read." };
  if (text.length > MAX_PASTE_CHARS) {
    return {
      ok: false,
      error: `That is ${text.length.toLocaleString()} characters. Paste up to ${MAX_PASTE_CHARS.toLocaleString()} — the most recent part is usually the useful part.`,
    };
  }

  const client = opts.client ?? new Anthropic();

  const userMessage = [
    `Today is ${opts.today}.`,
    "",
    renderCurrentProfile(opts.context),
    "",
    "## Text to read",
    "",
    // Delimited so the model can tell pasted content from instructions. Content inside is
    // data to extract from, never direction to follow.
    "<<<PASTED TEXT BEGINS>>>",
    text,
    "<<<PASTED TEXT ENDS>>>",
    "",
    "Propose only what differs from the profile above.",
  ].join("\n");

  try {
    const res = await client.messages.parse({
      model: CONSOLIDATE_MODEL,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      // Extraction is a smaller job than programming a week, and medium already proved
      // sufficient there.
      output_config: { effort: "medium", format: zodOutputFormat(ConsolidationSchema) },
      system: [
        { type: "text", text: CONSOLIDATE_SYSTEM, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: userMessage }],
    });

    if (res.stop_reason === "refusal") {
      return { ok: false, error: "The model declined to read that text." };
    }
    if (!res.parsed_output) {
      return { ok: false, error: "Could not make sense of that text. Try a shorter extract." };
    }

    return {
      ok: true,
      consolidation: res.parsed_output,
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Extraction failed." };
  }
}

/**
 * A stable identifier for a proposal, so the UI can track which are accepted.
 *
 * Derived from content rather than an index: the list is re-rendered as the user toggles
 * things, and an index would silently reassign selections.
 */
export function proposalKey(p: Proposal): string {
  switch (p.kind) {
    case "add_activity":
    case "remove_activity":
    case "update_activity":
      return `${p.kind}:${p.name.toLowerCase()}`;
    case "exclude_exercise":
    case "unexclude_exercise":
      return `${p.kind}:${p.name.toLowerCase()}`;
    default:
      return p.kind;
  }
}
