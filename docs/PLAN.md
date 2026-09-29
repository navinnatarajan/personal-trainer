# saturday-fitness — MVP Build Plan

## Context

Navin has a working AI personal-trainer workflow that already solves the hard part (progressive overload that doesn't plateau), but it's stitched across three surfaces: a Claude chat, a hand-generated HTML tracker, and an Excel file passed back and forth by copy-paste. Health data (steps, sleep) lives in a fourth place entirely.

The goal is **not** to invent a training methodology — that already exists and works. It's to collapse the existing loop into one web app so the friction disappears. Concretely, the app must kill three manual steps:

1. Claude hand-writing an HTML file each week → app generates the week plan into the DB.
2. "Copy for Claude" → paste into chat → app writes logs directly.
3. Checking Google Health separately → app pulls steps/sleep automatically.

Target users: Navin + 3 others. Explicitly **not** a scale problem. Success = "I stopped opening the spreadsheet."

### Source material already on disk

`~/Desktop/Projects/Claude/Personal Trainer/` contains the two artifacts that define the domain model. Do not redesign these — port them.

- **`Navin_Week1_Tracker.html`** (715 lines) — the `PLAN` array at line 319 is effectively the week-plan API contract. Per-day: `{id, dow, date, session, budget, head, ex[], checklist[]}`. Per-exercise: `{n, w, u, r, sets, rest, ss, tag, note}`. Logging state persists to `localStorage` (line 436); `recapText()` at line 652 is the copy-paste format being eliminated.
- **`Navin_Training_Tracker.xlsx`** — 7 sheets: `Start Here` (the double-progression rule), `Week Plan`, `Workout Log` (155 logged sets across 11 sessions, behind ~1000 rows of dragged-down formulas), `Body Metrics`, `Meal Log`, `Nutrition`, `Dashboard` (per-exercise baseline → next target → status).

Two formulas verified against the sheet's own numbers, so encode them as-is:
- `volume = weight × reps` (115 × 8 = 920 ✓)
- `est_1rm = weight × (1 + reps / 30)` — Epley (115 lbs × 8 → 145.7 ✓; 45 × 8 → 57.0 ✓)

The progression rule from `Start Here`, verbatim: *hit the TOP of the rep range on EVERY working set → add the smallest increment next session. Until then, add reps, not weight.*

---

## ⚠️ Time-critical finding: the Fitbit Web API dies in 3 days

Today is **2026-09-27**. The legacy **Fitbit Web API is decommissioned 2026-09-30**, replaced by the **Google Health API** (new endpoints, new source types, Google OAuth 2.0 — existing Fitbit tokens do not transfer). **Build against `developers.google.com/health` from the start.** Any tutorial or LLM-recalled snippet using `api.fitbit.com/1/user/-/...` is dead code.

Related constraints that shape the health-data design:
- **Health Connect has no cloud API** — it's an on-device Android SDK. A web app cannot read it. Same for Apple HealthKit (on-device iOS only).
- **Google Fit REST API** shuts down end of 2026. Sign-ups closed 2024-05-01. Not an option.
- Aggregators that paper over all this (Terra, Junction/Vital) start at **$300–400/mo**. Not justifiable for 4 users.

**Therefore health data is an adapter interface with three cheap implementations, not one integration** (details in Phase 2).

---

## Stack

| Layer | Choice |
|---|---|
| App | Next.js 15 App Router, TypeScript, Server Actions |
| Styling | Tailwind — mobile-first, since this is used standing at a squat rack |
| DB / Auth | Supabase Postgres + Auth (Google provider), RLS on every table |
| Hosting | Vercel |
| AI | `@anthropic-ai/sdk`, model `claude-opus-5` |

Google sign-in does double duty: it's the auth provider *and* the consent flow for Calendar + Google Health scopes. Request the extra scopes incrementally (at the point of connecting), not on first login.

---

# Setup — accounts, keys, and repo

You have: `git 2.47.1`, `node v25.2.1`, `npm 11.6.2`, Homebrew 5.0.8, a GitHub account (`navinnatarajan`) already pushing over HTTPS with the macOS keychain helper, and git identity configured. You do **not** have `gh`, the Supabase CLI, or Docker — and you won't need Docker at all.

## 1. Git repo

The project gets its own directory — **not** `Test Project`, which stays as a scratch pad:

```bash
mkdir -p ~/Desktop/Projects/Claude/saturday-fitness
cd ~/Desktop/Projects/Claude/saturday-fitness
git init -b main
```

`.gitignore` before the first commit — this matters, see the warning below:

```
node_modules/
.next/
.env
.env.local
.vercel
*.log
.DS_Store
```

> **Never commit `.env.local`.** It will hold your Anthropic API key and the Supabase `service_role` key, which bypasses all row-level security. Secrets in git history are effectively permanent and must be rotated, not deleted. If `git status` ever shows `.env.local`, stop and fix `.gitignore` first.

**Push to GitHub.** Installing `gh` is the shortest path and worth it (it authenticates in the browser and creates the remote in one step):

```bash
brew install gh
gh auth login          # choose GitHub.com → HTTPS → login with browser
gh repo create saturday-fitness --private --source=. --remote=origin
```

Without `gh`: create an empty private repo named `saturday-fitness` at github.com/new, then `git remote add origin https://github.com/navinnatarajan/saturday-fitness.git`. Your keychain already has working credentials from `leetcode-150`, so `git push` won't prompt for anything new.

## 2. Plan and execution live in the repo

This is the point of the request — the plan stops being a chat artifact and becomes a tracked file:

- **`docs/PLAN.md`** — this document, committed. Edit it as decisions change; the diff history becomes the decision log.
- **`docs/DECISIONS.md`** — one short entry per non-obvious call and why (e.g. "manual health entry before Google Health, because the API surface is days old"). Cheap to write, saves re-deriving later.
- **`supabase/migrations/`** — schema as versioned SQL files. The database stops being a thing you clicked together in a dashboard and becomes reviewable code.
- **Branch per phase**: `phase-0-foundation`, `phase-1-loop`, `phase-2-health`. Merge to `main` when the phase's verification passes. You're solo, so merge directly — but open a PR when you want a diff to read before committing to something.
- **Vercel connects to the GitHub repo**, so push to `main` = deploy, and every branch gets a preview URL you can open on your phone. That's what makes the gym testing in the verification section practical.

## 3. Supabase (you have none — hosted, no Docker)

1. Sign up at **supabase.com** with Google. Create a project named `saturday-fitness`, region US (closest to you), and **save the database password it generates** — it's shown once.
2. From **Project Settings → API**, copy three values into `.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=...        # safe in the browser; RLS constrains it
SUPABASE_SERVICE_ROLE_KEY=...            # server-only. Bypasses RLS. Never ship to the client.
ANTHROPIC_API_KEY=...                    # see step 5
```

3. Migrations via `npx` — no global install, no Docker, because you're running against the hosted DB rather than a local one:

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push        # applies supabase/migrations/*.sql
```

4. **Google auth provider** — the fiddliest step, budget 20 minutes. In Google Cloud Console create an OAuth 2.0 Client ID (type: Web application), paste its client ID + secret into Supabase → Authentication → Providers → Google, and add the callback URL Supabase shows you (`https://xxxx.supabase.co/auth/v1/callback`) to Google's *Authorized redirect URIs*. A mismatch here is the single most common setup failure, and the error message is unhelpful — copy the URL, don't retype it.

Free tier is comfortable for 4 users. Free projects pause after 7 days of *no* activity, which active use won't trigger.

## 4. Vercel

Sign in with GitHub, import the repo, and paste the same env vars into Project Settings → Environment Variables. First deploy can happen on an empty scaffold — get the pipeline working before there's anything to break.

## 5. Anthropic API key

From **console.anthropic.com** → API Keys. This is **billed separately from your Claude subscription** — a Claude.ai plan does not include API credits. Load a small amount; see the cost estimate below (~$5/mo for 4 users).

---

## Data model

Ported from the Excel sheets. All tables carry `user_id uuid references auth.users` + RLS policy `user_id = auth.uid()`.

```
profiles          goals[], lifecycle_stage, height_in, weight_lbs, sex,
                  bodyfat_pct_est, days_available[], session_budget_min,
                  equipment[], gym_name
exercises         name, muscle_group, equipment, unit ('lb'|'/side'|'BW'),
                  increment_lbs        -- smallest jump: DB 2.5, BB 5, machine varies
exercise_targets  exercise_id, baseline_weight, next_target, status
week_plans        week_number, starts_on, ends_on, headline, notes,
                  status, model_used, raw_plan jsonb
planned_sessions  week_plan_id, date, dow, session_name, time_budget_min, headline
planned_exercises session_id, exercise_id, sort_order, sets, target_weight, unit,
                  target_reps, rest_sec, superset_group, tag, coaching_note

sessions          planned_session_id (NULLABLE - unplanned gym visits happen),
                  date, status ('active'|'paused'|'completed'|'abandoned'),
                  started_at timestamptz, ended_at timestamptz,
                  paused_ms bigint default 0,
                  active_ms GENERATED ALWAYS AS
                    (EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000 - paused_ms)

set_logs          session_id references sessions(id),   -- not date-keyed
                  exercise_id, set_number, weight_lbs, reps, rir, notes,
                  logged_at timestamptz default now(),  -- per-set timestamp
                  volume  GENERATED ALWAYS AS (weight_lbs * reps),
                  est_1rm GENERATED ALWAYS AS (weight_lbs * (1 + reps/30.0))
body_metrics      date, weight_lbs, bodyfat_pct, waist_in, notes
health_daily      date, provider, steps, sleep_minutes, active_kcal, resting_hr
                  UNIQUE (user_id, date, provider)
checkins          week_number, user_constraints jsonb, events jsonb, ai_summary
chat_messages     thread_id, role, content jsonb, created_at
```

`set_logs` is the spine — everything else is either input to plan generation or a projection of it. Keep `week_plans.raw_plan` as the exact JSON Claude returned: it's the audit trail when a plan looks wrong, and what you replay to debug prompt regressions.

Phase 3 adds `meals` + `nutrition_daily` (already specced by the `Meal Log` / `Nutrition` sheets — don't build them yet).

---

## The core loop

### 1. Onboarding interview (`/onboarding`)
Multi-step form, not a chat — deterministic, resumable, cheap. Captures everything in `profiles` plus an optional photo for a body-fat estimate. Ends on a short "here's how this works" screen covering the Sunday check-in, daily logging, and the two optional connections. Educating the user here is load-bearing: the weekly rhythm *is* the product.

### 2. Sunday check-in (`/checkin`)
1. **Review** — last week computed server-side: sets logged vs planned, per-lift PRs, targets hit, **actual session durations vs budget**, sleep/step averages if connected.
2. **Input** — next week's availability per day, time budget, events (basketball/volleyball/travel), niggles. Pre-filled from Google Calendar when connected, so the common case is confirming rather than typing.
3. **Generate** — the AI call below, then a review screen where the plan can be edited before it's committed.

### 3. Plan generation — the one real AI call

**Split the work: rules in code, judgment in the model.** Compute per-exercise progression state deterministically before prompting:

```ts
// lib/progression.ts
// Encodes the Start Here rule. Do NOT let the model decide this.
function progressionState(logs: SetLog[], target: ExerciseTarget) {
  const lastSession = mostRecentSessionFor(target.exercise_id, logs);
  const [, top] = parseRepRange(lastSession.target_reps);   // "6-8" -> [6, 8]
  const hitTopOnEverySet = lastSession.sets.every(s => s.reps >= top);
  return hitTopOnEverySet
    ? { action: "add_weight", next: lastSession.weight + target.increment_lbs }
    : { action: "add_reps",   next: lastSession.weight };
}
```

Pass the *result* to Claude as fact, and let it do what only it can: exercise selection within constraints, session splits that fit the time budget, supersets, which lift gets the `THE TEST` / `PR ATTEMPT` tag, and the coaching notes — genuinely the best part of the current setup, because they carry history: *"You've been 8/7/6 here for weeks. Beat the third set."*

Use structured outputs so the plan is always well-formed — never parse prose into a schedule:

```ts
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const PlannedExercise = z.object({
  name: z.string(), sets: z.number(), target_weight: z.number(),
  unit: z.enum(["lb", "/side", "BW"]), target_reps: z.string(),
  rest_sec: z.number(), superset_group: z.string().nullable(),
  tag: z.string().nullable(), coaching_note: z.string(),
});
const WeekPlan = z.object({
  headline: z.string(),
  sessions: z.array(z.object({
    dow: z.enum(["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]),
    date: z.string(), session_name: z.string(),
    time_budget_min: z.number(), headline: z.string(),
    exercises: z.array(PlannedExercise),
  })),
  checklist: z.array(z.object({ title: z.string(), detail: z.string() })),
});

const res = await client.messages.stream({
  model: "claude-opus-5",
  max_tokens: 64000,
  thinking: { type: "adaptive" },
  output_config: { effort: "high", format: zodOutputFormat(WeekPlan) },
  system: [
    { type: "text", text: COACH_SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" } },   // stable prefix
    { type: "text", text: exerciseLibraryBlock,
      cache_control: { type: "ephemeral" } },
  ],
  messages: [{ role: "user", content: weeklyContextBlock }],  // volatile, last
}).then(s => s.finalMessage());
// res.parsed_output is null on a parse failure - guard, don't assert
```

Streaming because `max_tokens` is large; adaptive thinking because programming a week around constraints is exactly that case. Cache breakpoints on the system prompt and exercise library, volatile weekly context last — render order is `tools → system → messages`, so any byte change early invalidates everything after it.

**Cost:** ~20K in / ~8K out at $5/$25 per MTok ≈ **$0.30/user/week** → ~$5/mo for 4 users. Cost is not a design constraint; don't contort the architecture to save pennies.

### 4. Session logger (`/session/[date]`) — the screen that matters most

A faithful port of `Navin_Week1_Tracker.html`, which is already well-designed for use mid-workout. Keep the day rail, pre-filled weight/rep inputs, big tap-target set ticks, the rest timer driven by per-exercise `rest_sec`, superset pairing, and the end-of-day recap.

#### Explicit session start/stop

The current timing is inferred, and wrong. At lines 569–570 the HTML does:

```js
if(!st.start) st.start = Date.now();   // start = first set you tick
st.end = Date.now();                   // end = last set you tick, overwritten each time
```

So "22 min session" actually means *time between first and last logged set*. It excludes warmup and the walk in, ends at your last tick rather than when you left, silently balloons if you forget to log a set for half an hour, and is unrecoverable if you log something the next morning. There's no pause and no way to correct it.

This isn't a vanity stat — the entire program is built on time budgets (30 min weekdays, 90 Saturday, 60 Sunday). If actual duration is unknown, neither you nor Claude can tell whether a 30-minute plan is actually a 30-minute plan. Accurate timing closes that feedback loop.

Replace it with an explicit, server-authoritative lifecycle:

- **Start** — a single prominent button creates a `sessions` row with `started_at = now()` **set by Postgres, not the browser**, so a wrong phone clock or a timezone change can't corrupt it. Status `active`.
- **Pause / Resume** — accumulates into `paused_ms`. Real sessions get interrupted; without pause, people either accept bad numbers or stop trusting them.
- **Finish** — sets `ended_at = now()`, status `completed`, and shows the recap. Confirm the tap, since it's the one action that ends the clock.
- **Resume across reloads** — because the session lives in the DB, reopening the page (or switching phone → laptop) picks the clock back up. This is the concrete win over `localStorage`, which loses everything if the tab dies.
- **Auto-abandon** — a sweep marks sessions `active` for >4h with no set logged in the last hour as `abandoned`, excluded from all stats. Without this, one forgotten session poisons your averages forever.
- **Editable after the fact** — correct `started_at` / `ended_at` on the recap screen. You *will* forget to hit start sometimes; a plan that assumes otherwise just reintroduces bad data.
- **`set_logs.logged_at`** gives real rest intervals and set tempo for free, which feeds back as a genuine coaching input: *"your 30-minute sessions are averaging 41 minutes — rest is running 2× the plan."*

Client renders an optimistic local clock against `time_budget_min` (keeping the existing over-budget red state at `.clock.over`), but the database is the source of truth and the recap uses `active_ms`.

#### Two other changes
- Writes go to `set_logs` via Server Actions, with **`localStorage` kept as a write-through cache** — gym wifi is unreliable and losing a logged set mid-session is the one unforgivable bug. Queue failed writes, flush on reconnect.
- **Delete "Copy for Claude."** That button is the friction this project exists to remove.

### 5. Chat escape hatch (`/coach`)
Streaming chat on `claude-opus-5` with tools via the beta tool runner (`client.beta.messages.toolRunner`): `swapExercise`, `adjustSession`, `logSet`, `explainProgression`. This is where "my shoulder hurts, change today" gets handled without regenerating the week. Scope it to the current week — don't feed it full history.

### 6. Dashboard (`/`)
Today's session (or rest day), the week at a glance, per-lift progression status from `exercise_targets`, body-weight trend, average session duration vs budget, and steps/sleep when connected.

---

## Phasing

### Phase 0 — Foundation (`phase-0-foundation`)
Everything in **Setup** above, then: Next.js + Supabase scaffold, Google auth working end to end, schema + RLS migrations, `exercises` seeded from the `Dashboard` sheet's lift list, first Vercel deploy green.

**Write the Excel importer here** (`scripts/import-xlsx.mjs`, done). It imports the
Dashboard's 32-lift library plus 155 logged sets across 11 sessions (24 Aug – 21 Sep), so
progressive overload has real history from day one: 21 of 32 exercises carry logged sets.

Notes for anyone re-reading this. The workbook exists in two places and the importer must
report which it read — it silently imported a five-week-old copy once (see
`DECISIONS.md`). Cells arrive as `{formula, result}` objects, so every read takes the
computed value. `increment_lbs` is derived from the sheet's own baseline→target delta
where that delta is ≤5, falling back to an equipment heuristic for legs, whose targets
are aspirational. `--prune` removes exercises dropped from the Dashboard, but never ones
with logged sets. Historical sessions keep `started_at`/`ended_at` null with status
`completed` — those durations are genuinely unknown, and inventing them is the bad data
the explicit timer exists to prevent.

### Phase 1 — The loop (this is the MVP) (`phase-1-loop`)
Onboarding → check-in → plan generation → session logger with start/stop → dashboard → coach chat. **Ship and use this for two weeks before touching Phase 2.** If the loop works, the product is proven; if it doesn't, health data wouldn't have saved it.

### Phase 2 — Health data (`phase-2-health`)
Implement `HealthProvider { fetchDaily(userId, dateRange): HealthDaily[] }` writing to `health_daily` keyed by `(user, date, provider)`. Three adapters, cheapest first:

1. **Manual** — steps/sleep fields on the check-in form. Ugly, free, unblocks everything, and is the fallback when any sync breaks. Build it first.
2. **iOS Shortcuts → webhook** — a Shortcuts automation reads Apple Health and POSTs JSON to `/api/health/ingest` on a daily trigger. No native app, no App Store review, no aggregator fee. Best value-per-hour integration in the project.
3. **Google Health API** — server-to-server OAuth for Fitbit/Pixel data; the only true cloud sync of the three. Build against `developers.google.com/health` (see the deadline warning).

Android/Health Connect users not on Google Health cloud fall back to #1 until there's a native companion app. Tell those users explicitly rather than letting sync silently do nothing.

### Phase 3 — Calorie tracking (explicitly deferred)
Photo + description → Claude vision → `meals` / `nutrition_daily`. The `Meal Log` sheet shows the right output shape, including the honest `Assumptions / notes` column — preserve that.

---

## Critical files

```
docs/PLAN.md                this document, tracked
docs/DECISIONS.md           one entry per non-obvious call
supabase/migrations/        schema + RLS as versioned SQL
lib/progression.ts          double progression; pure + unit-tested
lib/session/lifecycle.ts    start/pause/resume/finish; server-authoritative time
lib/coach/generate-plan.ts  the structured-output call
lib/coach/prompts.ts        COACH_SYSTEM_PROMPT (cached prefix)
lib/coach/context.ts        assembles weeklyContextBlock from logs + health + calendar
lib/health/provider.ts      HealthProvider interface
lib/health/{manual,shortcuts,google-health}.ts
app/session/[date]/page.tsx port of Navin_Week1_Tracker.html
app/checkin/page.tsx        the Sunday flow
scripts/import-xlsx.ts      one-time history migration
```

---

## Verification

**Progression logic — unit tests, no API calls.** The one piece where a silent bug destroys trust in the app.
- `8/8/8` on a `6-8` range at 45 lb → `add_weight`, next 47.5 (the sheet's own worked example).
- `8/7/6` on `6-8` → `add_reps`, weight stays 45. Must **not** progress.
- Epley: `115 × 8 → 145.7`, `45 × 8 → 57.0`.

**Session timing** — the new surface, so test it deliberately:
- Start → wait → finish: `active_ms` matches wall clock within a second or two.
- Start → pause 5 min → resume → finish: paused time is excluded.
- Start a session, hard-kill the browser tab, reopen: the clock resumes rather than restarting or vanishing.
- A session left `active` overnight is marked `abandoned` and does **not** appear in average-duration stats.
- Editing `started_at` on the recap recomputes `active_ms`.

**Importer** — `set_logs` row count and total volume must match the `Workout Log` sheet; the script asserts both and exits non-zero on a mismatch (verified: 155 rows, 120,285 lbs). Re-running must not duplicate (verified). Spot-check Mon Week 1 Incline Bench (115 lb × 8/8/8/7 → volume 920, est 1RM 145.67).

**Plan generation** — run against imported history with a fixed check-in input. Assert `parsed_output` is non-null; every session fits its `time_budget_min` (sets × (rest + ~30s)); no exercise needs unavailable equipment; every lift flagged `add_weight` actually went up. Then read the coaching notes — they should reference real history. If they're generic, the context block is wrong, not the model.

**Session logger — test on a phone, in the gym, not in a desktop browser.** Use the Vercel preview URL for the branch. Airplane-mode mid-session, log three sets, reconnect, confirm nothing was lost. Then do a real workout with it; that's the actual acceptance test.

**Health adapters** — manual first. For Shortcuts, `curl` a sample payload at the ingest route before building the automation. Verify the Google Health OAuth round-trip against a live account, since the API surface is days old.

**End-to-end** — run one complete Sunday→Saturday cycle yourself before inviting the other 3 users.
