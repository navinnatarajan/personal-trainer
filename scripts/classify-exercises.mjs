#!/usr/bin/env node
/**
 * Classifies the exercise library by movement type, sets anchors, and seeds core work.
 *
 * Run once after migration 0005. Idempotent: re-running re-applies the same
 * classification rather than duplicating anything.
 *
 * Usage:
 *   node scripts/classify-exercises.mjs                    # dry run
 *   node scripts/classify-exercises.mjs --apply --user <uuid>
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const USER_ID = args.includes("--user") ? args[args.indexOf("--user") + 1] : process.env.IMPORT_USER_ID;

function env() {
  const out = {};
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const i = line.indexOf("=");
      const t = line.trim();
      if (!t || t.startsWith("#") || i < 0) continue;
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  } catch { /* fall through */ }
  return { ...out, ...process.env };
}

/**
 * Compound = multi-joint and systemically demanding, so it belongs early in a session.
 *
 * Named explicitly rather than pattern-matched. A regex over exercise names is how
 * "ma-CHIN-e" got classified as bodyweight, and the cost of a wrong call here is a
 * session ordered backwards — the hardest lift done tired.
 */
const COMPOUNDS = new Set([
  // Vertical and horizontal pulls. Pull-Up first deliberately: it is the most demanding
  // pull in the library, not an accessory to put behind two others.
  "Pull-Up",
  "Wide Grip Lat Pulldown",
  "Mag Grip Pulldown",
  "Cable Row",
  // Presses.
  "Flat Bench (BB)",
  "Incline Bench (BB)",
  "Incline Press (Hammer)",
  "Chest Press (Hammer)",
  "DB Shoulder Press",
  "Close Grip Bench / Dip",
  // Lower body.
  "Leg Press",
  "Hack Squat",
  "Romanian Deadlift (DB)",
]);

/** Core work to seed. The library had six muscle groups and none of them was core. */
const CORE_EXERCISES = [
  { name: "Cable Crunch", equipment: "cables", unit: "lb", increment_lbs: 5 },
  { name: "Hanging Leg Raise", equipment: "pull-up bar", unit: "BW", increment_lbs: 0 },
  { name: "Plank", equipment: null, unit: "BW", increment_lbs: 0 },
  { name: "Ab Wheel Rollout", equipment: null, unit: "BW", increment_lbs: 0 },
  { name: "Pallof Press", equipment: "cables", unit: "lb", increment_lbs: 5 },
];

/**
 * Anchors: non-negotiable lifts that must appear at least twice a week.
 *
 * Lateral Raise is the case that motivated this. 28 logged sets — the most-trained lift
 * in the library by half again — and it is the single highest-leverage movement for a
 * v-taper, since shoulder width is the numerator. The first generated plan gave it one
 * slot out of four sessions.
 */
const ANCHORS = new Set(["Lateral Raise"]);

/**
 * Preferred over an equivalent alternative when the coach has a choice.
 *
 * Incline pressing over flat is goal-aligned rather than arbitrary: upper-chest thickness
 * contributes to the shelf a v-taper reads from, while flat bench is more general mass.
 * Weaker than an anchor — this biases a substitution, it does not demand frequency.
 */
const FAVOURITES = new Set(["Incline Bench (BB)", "Incline Press (Hammer)"]);

const e = env();

if (!APPLY) {
  console.log("Dry run — nothing written.\n");
}

const db = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

if (APPLY && !USER_ID) {
  console.error("✗ --user <uuid> is required with --apply.");
  process.exit(1);
}

const { data: existing, error } = await db
  .from("exercises")
  .select("id, name, muscle_group, preference")
  .eq("user_id", USER_ID ?? "00000000-0000-0000-0000-000000000000");
if (error) throw error;

const rows = existing ?? [];
const plan = rows.map((r) => ({
  id: r.id,
  name: r.name,
  movement_type: COMPOUNDS.has(r.name) ? "compound" : "accessory",
  preference: ANCHORS.has(r.name)
    ? "anchor"
    : FAVOURITES.has(r.name)
      ? "favourite"
      : r.preference === "excluded"
        ? "excluded"
        : "neutral",
}));

const compounds = plan.filter((p) => p.movement_type === "compound");
console.log(`${rows.length} exercises: ${compounds.length} compound, ${rows.length - compounds.length} accessory`);
console.log(`anchors: ${plan.filter((p) => p.preference === "anchor").map((p) => p.name).join(", ") || "(none)"}`);
console.log(`favourites: ${plan.filter((p) => p.preference === "favourite").map((p) => p.name).join(", ") || "(none)"}`);
console.log(`core to add: ${CORE_EXERCISES.map((c) => c.name).join(", ")}`);

// Anything in COMPOUNDS that is not in the library means the list has drifted from the
// data — surface it rather than silently classifying nothing.
const missing = [...COMPOUNDS].filter((c) => !rows.some((r) => r.name === c));
if (missing.length) {
  console.log(`\n! listed as compound but absent from the library: ${missing.join(", ")}`);
}

if (!APPLY) {
  console.log("\nRe-run with --apply --user <uuid> to write.");
  process.exit(0);
}

for (const p of plan) {
  const { error: upErr } = await db
    .from("exercises")
    .update({ movement_type: p.movement_type, preference: p.preference })
    .eq("id", p.id);
  if (upErr) throw upErr;
}
console.log(`\n  classified       ${plan.length}`);

const { data: core, error: coreErr } = await db
  .from("exercises")
  .upsert(
    CORE_EXERCISES.map((c) => ({
      user_id: USER_ID,
      name: c.name,
      muscle_group: "Core",
      equipment: c.equipment,
      unit: c.unit,
      increment_lbs: c.increment_lbs,
      movement_type: "core",
    })),
    { onConflict: "user_id,name" },
  )
  .select("id, name");
if (coreErr) throw coreErr;
console.log(`  core added       ${core.length}`);

// Core lifts have no history, so they need a target row to be programmable.
const { error: tErr } = await db.from("exercise_targets").upsert(
  core.map((c) => ({ user_id: USER_ID, exercise_id: c.id, baseline_weight: null, next_target: null })),
  { onConflict: "user_id,exercise_id" },
);
if (tErr) throw tErr;

const { count } = await db
  .from("exercises")
  .select("id", { count: "exact", head: true })
  .eq("user_id", USER_ID);
console.log(`  library total    ${count}`);
console.log("\n✓ Done.");
