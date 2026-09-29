#!/usr/bin/env node
/**
 * One-time import of the original spreadsheet into Supabase.
 *
 * Source: Navin_Training_Tracker.xlsx
 *   Dashboard    -> exercises + exercise_targets   (the valuable part: 27 lifts)
 *   Workout Log  -> sessions + set_logs
 *   Body Metrics -> body_metrics
 *
 * Note the sheet is mostly formulas dragged down ~1000 rows with no data in them; only
 * rows with a real value are imported. Cells arrive as {formula, result} objects, so
 * every read goes through val() to take the computed value.
 *
 * Uses the service-role key to write on a user's behalf, which bypasses row-level
 * security — so the target user id is required explicitly rather than inferred silently.
 *
 * Idempotent: re-running upserts rather than duplicating.
 *
 * Usage:
 *   node scripts/import-xlsx.mjs                  # dry run, prints what it would do
 *   node scripts/import-xlsx.mjs --apply          # writes
 *   node scripts/import-xlsx.mjs --apply --user <uuid>
 */

import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { createClient } from "@supabase/supabase-js";

const XLSX_PATH =
  process.env.XLSX_PATH ??
  "/Users/navinnatarajan/Desktop/Projects/Claude/Personal Trainer/Navin_Training_Tracker.xlsx";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const userArg = args[args.indexOf("--user") + 1];
const USER_ID = args.includes("--user") ? userArg : process.env.IMPORT_USER_ID;

// --- env ---------------------------------------------------------------------

function loadEnvLocal() {
  const out = {};
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  } catch {
    /* fall through to process.env */
  }
  return out;
}
const env = { ...loadEnvLocal(), ...process.env };

// --- cell readers ------------------------------------------------------------

const val = (v) => (v && typeof v === "object" && "result" in v ? v.result : v);
const str = (v) => {
  const x = val(v);
  return typeof x === "string" ? x.trim() : x == null ? "" : String(x).trim();
};
const num = (v) => {
  const x = val(v);
  if (typeof x === "number") return x;
  if (typeof x === "string" && x.trim() !== "" && !Number.isNaN(Number(x))) return Number(x);
  return null;
};
const date = (v) => {
  const x = val(v);
  if (x instanceof Date) return x.toISOString().slice(0, 10);
  return null;
};

/**
 * Smallest weight jump for an exercise.
 *
 * Derived from the sheet's own baseline -> next-target delta when that delta is small,
 * since for most lifts the user recorded exactly one increment (45 -> 47.5, 17.5 -> 20).
 * Leg work is the exception: 230 -> 275 is an aspirational goal, not an increment, so
 * anything larger than 5 falls back to an equipment guess.
 */
function inferIncrement(name, baseline, nextTarget) {
  const delta = (nextTarget ?? 0) - (baseline ?? 0);
  if (delta > 0 && delta <= 5) return delta;

  const n = name.toLowerCase();
  if (/pull-up|dip|chin/.test(n)) return 0; // bodyweight
  if (/\(bb\)|barbell|deadlift|squat/.test(n)) return 5;
  if (/press|leg press|hack/.test(n)) return 5;
  if (/db |dumbbell|curl|raise|fly/.test(n)) return 2.5;
  return 2.5; // cables and machines mostly move in 2.5s
}

const isBodyweight = (name, baseline) =>
  /pull-up|dip|chin/i.test(name) || (baseline ?? 0) === 0;

// --- read the workbook -------------------------------------------------------

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(XLSX_PATH);

/** Dashboard rows stop at the WEEKLY ROLL-UP marker; everything after is a summary. */
function readExercises() {
  const ws = wb.getWorksheet("Dashboard");
  const rows = [];
  let stop = false;
  ws.eachRow({ includeEmpty: false }, (row, i) => {
    if (stop || i < 4) return;
    const name = str(row.values[1]);
    if (!name) return;
    if (/roll-?up/i.test(name)) {
      stop = true;
      return;
    }
    const muscleGroup = str(row.values[2]) || "Other";
    const baseline = num(row.values[3]);
    const nextTarget = num(row.values[4]);
    const bw = isBodyweight(name, baseline);
    rows.push({
      name,
      muscle_group: muscleGroup,
      unit: bw ? "BW" : "lb",
      increment_lbs: bw ? 0 : inferIncrement(name, baseline, nextTarget),
      baseline_weight: baseline,
      next_target: nextTarget,
    });
  });
  return rows;
}

function readWorkoutLog() {
  const ws = wb.getWorksheet("Workout Log");
  const sets = [];
  ws.eachRow({ includeEmpty: false }, (row, i) => {
    if (i === 1) return;
    const v = row.values;
    const exercise = str(v[5]);
    const d = date(v[1]);
    const weight = num(v[8]);
    // A row counts as data only with an exercise, a date, and a weight.
    if (!exercise || !d || weight === null) return;
    sets.push({
      date: d,
      week: num(v[2]),
      session_name: str(v[4]) || null,
      exercise,
      set_number: num(v[7]) ?? sets.length + 1,
      weight_lbs: weight,
      reps: num(v[9]),
      rir: num(v[10]),
      notes: str(v[13]) || null,
    });
  });
  return sets;
}

function readBodyMetrics() {
  const ws = wb.getWorksheet("Body Metrics");
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, i) => {
    if (i === 1) return;
    const v = row.values;
    const d = date(v[1]);
    if (!d) return;
    const weight = num(v[3]);
    const bf = num(v[5]);
    const waist = num(v[6]);
    if (weight === null && bf === null && waist === null) return;
    rows.push({
      date: d,
      weight_lbs: weight,
      bodyfat_pct: bf,
      waist_in: waist,
      notes: str(v[8]) || null,
    });
  });
  return rows;
}

const exercises = readExercises();
const setRows = readWorkoutLog();
const bodyRows = readBodyMetrics();

const sessionKeys = [...new Set(setRows.map((s) => `${s.date}|${s.session_name ?? ""}`))];
const totalVolume = setRows.reduce((a, s) => a + s.weight_lbs * (s.reps ?? 0), 0);

console.log(`Source: ${XLSX_PATH}\n`);
console.log(`  exercises      ${exercises.length}`);
console.log(`  sessions       ${sessionKeys.length}  (${sessionKeys.join(", ")})`);
console.log(`  set_logs       ${setRows.length}`);
console.log(`  body_metrics   ${bodyRows.length}`);
console.log(`  total volume   ${totalVolume} lbs`);
console.log(`  missing reps   ${setRows.filter((s) => s.reps === null).length}`);

const unknown = setRows.filter((s) => !exercises.some((e) => e.name === s.exercise));
if (unknown.length) {
  // Would violate the foreign key, so fail before writing anything.
  console.error(
    `\n✗ ${unknown.length} logged set(s) name an exercise absent from the Dashboard:`,
  );
  for (const u of [...new Set(unknown.map((s) => s.exercise))]) console.error(`  - ${u}`);
  process.exit(1);
}

if (!APPLY) {
  console.log("\nDry run. Nothing written. Re-run with --apply to import.");
  console.log("Exercises to be created:");
  for (const e of exercises) {
    console.log(
      `  ${e.name.padEnd(30)} ${e.muscle_group.padEnd(10)} unit=${e.unit.padEnd(3)} inc=${e.increment_lbs} baseline=${e.baseline_weight ?? "-"}`,
    );
  }
  process.exit(0);
}

// --- write -------------------------------------------------------------------

if (!USER_ID) {
  console.error(
    "\n✗ --user <uuid> is required with --apply (or set IMPORT_USER_ID).\n" +
      "  The service-role key bypasses row-level security, so the owner must be explicit.",
  );
  process.exit(1);
}

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("\n✗ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const db = createClient(url, serviceKey, { auth: { persistSession: false } });

const { data: profile, error: profileErr } = await db
  .from("profiles")
  .select("id, display_name")
  .eq("id", USER_ID)
  .maybeSingle();
if (profileErr) throw profileErr;
if (!profile) {
  console.error(`\n✗ No profile for ${USER_ID}. Sign in to the app first.`);
  process.exit(1);
}
console.log(`\nImporting for ${profile.display_name ?? USER_ID}`);

// exercises: unique (user_id, name), so upsert is safe to re-run.
const { data: savedExercises, error: exErr } = await db
  .from("exercises")
  .upsert(
    exercises.map((e) => ({
      user_id: USER_ID,
      name: e.name,
      muscle_group: e.muscle_group,
      unit: e.unit,
      increment_lbs: e.increment_lbs,
    })),
    { onConflict: "user_id,name" },
  )
  .select("id, name");
if (exErr) throw exErr;
const idByName = new Map(savedExercises.map((e) => [e.name, e.id]));
console.log(`  exercises      ${savedExercises.length} upserted`);

const { error: tgtErr } = await db.from("exercise_targets").upsert(
  exercises
    .filter((e) => idByName.has(e.name))
    .map((e) => ({
      user_id: USER_ID,
      exercise_id: idByName.get(e.name),
      baseline_weight: e.baseline_weight,
      next_target: e.next_target,
    })),
  { onConflict: "user_id,exercise_id" },
);
if (tgtErr) throw tgtErr;
console.log(`  targets        ${exercises.length} upserted`);

// sessions have no natural unique key, so reuse an existing row for the same
// (date, session_name) instead of inserting a duplicate on re-run.
const sessionIdByKey = new Map();
for (const key of sessionKeys) {
  const [d, name] = key.split("|");
  const sessionName = name || null;

  let query = db
    .from("sessions")
    .select("id")
    .eq("user_id", USER_ID)
    .eq("date", d)
    .limit(1);
  query = sessionName
    ? query.eq("session_name", sessionName)
    : query.is("session_name", null);
  const { data: existing, error: findErr } = await query;
  if (findErr) throw findErr;

  if (existing?.length) {
    sessionIdByKey.set(key, existing[0].id);
    continue;
  }

  const { data: created, error: insErr } = await db
    .from("sessions")
    .insert({
      user_id: USER_ID,
      date: d,
      session_name: sessionName,
      status: "completed",
      // Left null deliberately: these sessions were never timed, and inventing a
      // duration is exactly the bad data the explicit timer exists to prevent.
      started_at: null,
      ended_at: null,
    })
    .select("id")
    .single();
  if (insErr) throw insErr;
  sessionIdByKey.set(key, created.id);
}
console.log(`  sessions       ${sessionIdByKey.size} ready`);

const { error: setErr } = await db.from("set_logs").upsert(
  setRows.map((s) => ({
    user_id: USER_ID,
    session_id: sessionIdByKey.get(`${s.date}|${s.session_name ?? ""}`),
    exercise_id: idByName.get(s.exercise),
    set_number: s.set_number,
    weight_lbs: s.weight_lbs,
    reps: s.reps,
    rir: s.rir,
    notes: s.notes,
  })),
  { onConflict: "session_id,exercise_id,set_number" },
);
if (setErr) throw setErr;
console.log(`  set_logs       ${setRows.length} upserted`);

if (bodyRows.length) {
  const { error: bmErr } = await db.from("body_metrics").upsert(
    bodyRows.map((b) => ({ user_id: USER_ID, ...b })),
    { onConflict: "user_id,date" },
  );
  if (bmErr) throw bmErr;
  console.log(`  body_metrics   ${bodyRows.length} upserted`);
}

// --- verify against the source ----------------------------------------------

const { data: check, error: checkErr } = await db
  .from("set_logs")
  .select("volume, reps, weight_lbs")
  .eq("user_id", USER_ID);
if (checkErr) throw checkErr;

const dbVolume = check.reduce((a, r) => a + Number(r.volume), 0);
console.log(`\nVerification`);
console.log(`  rows    source ${setRows.length}   database ${check.length}`);
console.log(`  volume  source ${totalVolume}   database ${dbVolume}`);

if (check.length !== setRows.length || Math.abs(dbVolume - totalVolume) > 0.01) {
  console.error("\n✗ Mismatch between source and database.");
  process.exit(1);
}
console.log("\n✓ Import verified.");
