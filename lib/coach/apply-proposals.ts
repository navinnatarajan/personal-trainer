/**
 * Writes proposals the user has confirmed.
 *
 * Separate from extraction on purpose: extraction is a model call that can be wrong, this
 * is a database write that must not be. Nothing here calls a model, and every write is
 * scoped to one user.
 *
 * Applied independently rather than in a transaction. Partial success is the right
 * behaviour here — if removing an activity works and excluding an exercise fails because
 * the name does not resolve, keeping the first is better than discarding both and asking
 * the user to start over.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Proposal } from "./consolidate";

export interface ApplyResult {
  applied: number;
  failures: Array<{ summary: string; reason: string }>;
}

export async function applyProposals(
  db: SupabaseClient,
  userId: string,
  proposals: ReadonlyArray<Proposal>,
): Promise<ApplyResult> {
  const failures: ApplyResult["failures"] = [];
  let applied = 0;

  for (const p of proposals) {
    try {
      await applyOne(db, userId, p);
      applied++;
    } catch (err) {
      failures.push({
        summary: p.summary,
        reason: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return { applied, failures };
}

async function applyOne(
  db: SupabaseClient,
  userId: string,
  p: Proposal,
): Promise<void> {
  switch (p.kind) {
    case "add_activity":
    case "update_activity": {
      const { error } = await db.from("user_activities").upsert(
        { user_id: userId, name: p.name, dows: p.dows, intensity: p.intensity },
        { onConflict: "user_id,name" },
      );
      if (error) throw error;
      return;
    }

    case "remove_activity": {
      // Case-insensitive: the model echoes the name from the text, which may not match
      // the stored capitalisation.
      const { error } = await db
        .from("user_activities")
        .delete()
        .eq("user_id", userId)
        .ilike("name", p.name);
      if (error) throw error;
      return;
    }

    case "set_training_days": {
      const byDow = new Map(p.days.map((d) => [d.dow, d.durationMin]));
      // All seven are written, so a day absent from the proposal becomes a rest day
      // rather than silently keeping an old value.
      const rows = Array.from({ length: 7 }, (_, i) => {
        const dow = i + 1;
        const duration = byDow.get(dow);
        return {
          user_id: userId,
          dow,
          can_train: duration !== undefined,
          duration_min: duration ?? null,
        };
      });
      const { error } = await db
        .from("day_preferences")
        .upsert(rows, { onConflict: "user_id,dow" });
      if (error) throw error;
      return;
    }

    case "set_durable_constraints": {
      const { error } = await db
        .from("profiles")
        .update({ durable_constraints: p.text, updated_at: new Date().toISOString() })
        .eq("id", userId);
      if (error) throw error;
      return;
    }

    case "exclude_exercise":
    case "unexclude_exercise": {
      // Resolve first so an unmatched name fails loudly rather than updating nothing and
      // reporting success.
      const { data: match, error: findError } = await db
        .from("exercises")
        .select("id, name")
        .eq("user_id", userId)
        .ilike("name", p.name)
        .maybeSingle();
      if (findError) throw findError;
      if (!match) {
        throw new Error(`"${p.name}" is not in your exercise library.`);
      }

      const { error } = await db
        .from("exercises")
        .update({ preference: p.kind === "exclude_exercise" ? "excluded" : "neutral" })
        .eq("id", match.id);
      if (error) throw error;
      return;
    }

    case "set_goals": {
      const { error } = await db
        .from("profiles")
        .update({ goals: p.goals, updated_at: new Date().toISOString() })
        .eq("id", userId);
      if (error) throw error;
      return;
    }

    case "set_split_preference": {
      const { error } = await db
        .from("profiles")
        .update({ split_preference: p.split, updated_at: new Date().toISOString() })
        .eq("id", userId);
      if (error) throw error;
      return;
    }

    case "set_measurements": {
      if (p.weightLbs === null && p.waistIn === null) return;
      // body_metrics is the source of truth for anything measured over time; the profile
      // copy is only what was given at setup.
      const today = new Date().toISOString().slice(0, 10);
      const { error } = await db.from("body_metrics").upsert(
        {
          user_id: userId,
          date: today,
          weight_lbs: p.weightLbs,
          waist_in: p.waistIn,
        },
        { onConflict: "user_id,date" },
      );
      if (error) throw error;

      if (p.weightLbs !== null) {
        const { error: profileError } = await db
          .from("profiles")
          .update({ weight_lbs: p.weightLbs, updated_at: new Date().toISOString() })
          .eq("id", userId);
        if (profileError) throw profileError;
      }
      return;
    }
  }
}

/** Plain-language label for a proposal kind, for grouping in the UI. */
export function proposalCategory(p: Proposal): string {
  switch (p.kind) {
    case "add_activity":
    case "remove_activity":
    case "update_activity":
      return "Activities";
    case "set_training_days":
      return "Your week";
    case "set_durable_constraints":
      return "Constraints";
    case "exclude_exercise":
    case "unexclude_exercise":
      return "Exercises";
    case "set_goals":
    case "set_split_preference":
      return "Goals";
    case "set_measurements":
      return "Measurements";
  }
}
