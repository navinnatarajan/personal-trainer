# Decisions

One entry per non-obvious call, with the reasoning. Newest last.

---

### Port the existing HTML tracker rather than redesign the logging UI
**2026-09-27** — `Personal Trainer/Navin_Week1_Tracker.html` is already well-tuned for use
mid-workout: big tap targets, pre-filled weights, per-exercise rest timers, superset
pairing. It has been used for real sessions. Redesigning it would risk losing properties
that were learned the hard way. The `PLAN` array in that file is treated as the week-plan
schema, not as a starting sketch.

### Progressive overload is computed in code, not decided by the model
**2026-09-27** — The double-progression rule ("hit the top of the rep range on *every*
working set, then add the smallest increment") is a deterministic rule, not a judgment
call. Encoding it in `lib/progression.ts` makes it unit-testable and impossible for the
model to silently get wrong. Claude is given the computed result as fact and does the part
only it can do: exercise selection, fitting sessions into time budgets, and writing
coaching notes that reference real history.

### Session timing gets an explicit start/stop instead of being inferred
**2026-09-27** — The HTML tracker inferred duration from set ticks
(`Navin_Week1_Tracker.html:569-570`): start was the first set ticked, end was overwritten
on every subsequent tick. So a "22 min session" really meant *time between first and last
logged set* — excluding warmup, ending at the last tick rather than when you left, and
ballooning silently if a set went unlogged for a while.

This matters beyond stats: the whole program is built on time budgets (30 min weekdays,
90 Saturday, 60 Sunday). Without real durations, neither the user nor the model can tell
whether a 30-minute plan is actually a 30-minute plan.

Timestamps are set by Postgres (`now()`), not the browser, so a wrong phone clock or a
timezone change can't corrupt them. Sessions live in the DB rather than `localStorage`, so
the clock survives a killed tab. Forgotten sessions are auto-abandoned and excluded from
averages, and start/end stay editable — people *will* forget to hit start, and a design
that assumes otherwise just reintroduces bad data.

### Health data is an adapter interface, and manual entry ships first
**2026-09-27** — A web app cannot read Apple Health or Health Connect directly: both are
on-device only (Health Connect has no cloud API). Google Fit's REST API shuts down end of
2026, and the legacy Fitbit Web API was decommissioned 2026-09-30 in favour of the Google
Health API. Aggregators that paper over all this (Terra, Junction/Vital) start at
$300–400/mo, which is not defensible for four users.

So `HealthProvider` is an interface with three implementations, cheapest first: manual
entry on the check-in form, an iOS Shortcuts automation POSTing to a webhook (free, no
native app), and Google Health OAuth. Manual ships first because it unblocks everything
and remains the fallback whenever a sync breaks.

### Build against the Google Health API, never the Fitbit Web API
**2026-09-27** — The Fitbit Web API is decommissioned 2026-09-30. Tokens do not transfer;
auth moved to Google OAuth 2.0. Any snippet using `api.fitbit.com/1/user/-/...` is dead
code, including ones an LLM may confidently produce from memory. Reference:
`developers.google.com/health`.

### Next.js 16, not 15
**2026-09-27** — The plan specified Next 15; `create-next-app@latest` installed 16.3.6.
Taking the newer version rather than pinning backwards. Note that Next 16 has breaking
changes relative to most training data — the scaffold's own `AGENTS.md` says to read
`node_modules/next/dist/docs/` before writing code, and those docs are bundled locally.

### Hosted Supabase, no Docker, migrations over `npx`
**2026-09-27** — Local Supabase requires Docker, which isn't installed and isn't worth the
setup for a four-user app. Running migrations from `supabase/migrations/` against the
hosted project via `npx supabase db push` keeps the schema in version control (the real
goal) without a local stack or a global CLI install.

### The spreadsheet's value is the exercise library, not the history
**2026-09-29** — An early reading of the workbook reported ~1000 rows in `Workout Log`
and the plan was written around importing "1000 rows of history". That was wrong. The
sheet has formulas dragged down about a thousand rows; only **14 rows hold data**, from a
single session (Mon 24 Aug, Push). `Body Metrics` has one row.

What is genuinely valuable is the `Dashboard` sheet: **27 exercises** with muscle groups,
baselines, and targets. That is the vocabulary the model programs against, and it would
otherwise have to be retyped.

Consequences: the first generated week is mostly baseline-setting rather than progression
(`lib/progression.ts` already returns `establish_baseline` for an exercise with no
history, so no code change was needed), and the earlier claim that an empty database
would make the app "strictly worse than the spreadsheet on day one" does not hold — the
spreadsheet has almost no history either.

Lesson worth keeping: counting `<row>` elements in the sheet XML counts formula rows, not
data. Presence of a cell is not presence of a value.

### `increment_lbs` is derived from the sheet, not guessed
**2026-09-29** — For most lifts the recorded `baseline → next target` delta *is* one
increment (DB Shoulder Press 45→47.5, Lateral Raise 17.5→20, Pushdown 50→52.5), so the
importer uses that delta whenever it is ≤5 lbs. Leg work is the exception — Leg Press
230→275, Hack Squat 200→240 are aspirational goals rather than increments — so anything
larger falls back to an equipment heuristic (barbell 5, dumbbell/cable 2.5, bodyweight 0).

These values should be sanity-checked against the actual gym: a cable stack that moves in
5s or 10s would make a 2.5 increment unreachable, and the progression logic would then
prescribe a weight that cannot be loaded.

### Anthropic auth: API key now, Workload Identity Federation later
**2026-09-29** — Anthropic supports Workload Identity Federation (WIF): a workload
presents a short-lived OIDC token from its platform and exchanges it for an Anthropic
bearer token, so no long-lived secret lives in the deployment. It works with Vercel, whose
functions are issued an OIDC token. We are deliberately not using it yet.

- **It adds a mechanism rather than removing one.** A laptop is not a federated workload,
  so local development still needs an API key (or an `ant auth login` OAuth profile). WIF
  on Vercel plus a key locally is two credential paths, not zero.
- **Setup is non-trivial**: admin/owner role on the Anthropic org, a service account, and a
  federation rule trusting Vercel's OIDC issuer.
- **The current blast radius is small.** The key is in a gitignored `.env.local` and
  Vercel's encrypted environment variables, never in git, and is scoped to a workspace with
  a monthly spend cap.
- **Deferring is free**, which is the deciding factor. The SDK auto-detects WIF from
  environment variables, so `new Anthropic()` is unchanged either way. Adopting it later is
  a configuration change, not a refactor.

**Switch when** any of these becomes true: users beyond the initial four (especially paying
ones), CI that calls the API, more than one person able to read the key, any compliance
requirement, or the point where rotating the key feels risky.

**Trap for that future change:** a set `ANTHROPIC_API_KEY` silently outranks WIF in the
SDK's credential resolution, and an *empty* `ANTHROPIC_API_KEY=""` still wins its
precedence slot and authenticates with an empty key. It must be genuinely unset.

### API key: 30-day expiry, inside a spend-capped workspace
**2026-09-29** — Two independent controls, because they bound different risks:

- **Workspace spend cap** (`personal-trainer` workspace, $20/month) bounds *cost*. The
  realistic way to lose money is a looping API call against Opus 5 pricing, not a stolen
  key. Adjustable at any time.
- **30-day key expiry** bounds *exposure*. Chosen over `Never` deliberately: this is a
  first deployment, and the plausible leak paths early on are a screenshot, a pasted log,
  or a stray `git add` — all of which a time-boxed key caps whether or not the leak is
  noticed. `Never` assumes the leak gets caught.

A forced rotation is also cheap practice while the stakes are near zero: better to learn
the procedure on an app with four users than to discover it under pressure later.

**The cost of this choice** is that expiry cannot be extended after creation, so the app
*will* stop working on the expiry date, and the failure looks like a bug rather than an
expiry: requests fail with a 401 and an `authentication_error`. Mitigations: note the date,
set a reminder several days ahead, and treat an unexplained 401 as "check the key expiry
first". Rotation means creating a *new* key and updating it in both `.env.local` and
Vercel's environment variables — the old key cannot be renewed.

App users never hold API keys: the server holds one and serves everyone. So the expiry
burden stays at one key in two places regardless of user count.

### Import the spreadsheet history in Phase 0, not later
**2026-09-27** — Plan generation progresses *from* history. With an empty database the app
would be strictly worse than the spreadsheet on day one, and the progression logic would
have nothing to act on. Historical sessions get `started_at`/`ended_at` left null rather
than invented, since those durations genuinely aren't known.
