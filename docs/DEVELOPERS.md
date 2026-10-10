# Developer guide

Everything needed to be productive on Saturday Fitness. Read this first, then
[`PRODUCT.md`](PRODUCT.md) for *why* the thing is built this way and
[`DECISIONS.md`](DECISIONS.md) for the reasoning behind individual calls.

---

## Getting running

```bash
git clone https://github.com/navinnatarajan/personal-trainer.git
cd personal-trainer
npm install
cp .env.example .env.local      # then fill in — see below
npm run check:env               # validates without printing secrets
npm run dev                     # http://localhost:3000
```

### What goes in `.env.local`

| Variable | Where from | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Settings → API | Public |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | same | Public by design; RLS is what protects data |
| `SUPABASE_SERVICE_ROLE_KEY` | same | **Bypasses RLS.** Server only |
| `ANTHROPIC_API_KEY` | console.anthropic.com | Billed separately from a Claude.ai plan |
| `GOOGLE_CLIENT_ID` / `_SECRET` | Google Cloud → Credentials | Only needed for Calendar scopes |
| `HEALTH_INGEST_SECRET` | you invent it | Phase 2 |

> **The one mistake gitignore cannot save you from:** any variable named
> `NEXT_PUBLIC_*` is compiled into the browser bundle and visible to every visitor.
> That is intentional for the Supabase URL and anon key. `SUPABASE_SERVICE_ROLE_KEY`
> must **never** be renamed with that prefix. `npm run check:env` asserts this.

### Commands

| Command | Does |
|---|---|
| `npm run dev` | Dev server (Turbopack) |
| `npm test` | Vitest, 86 tests, no network or database needed |
| `npm run test:integration` (plan) | Makes a real API call, ~$0.15, and prints the generated week |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run check:env` | Validates `.env.local` shape without printing values |
| `npm run test:integration` | Hits the live Supabase project and prints the assembled coach context |
| `./scripts/verify-schema.sh` | Applies migrations to a throwaway local Postgres and asserts behaviour |
| `node scripts/import-xlsx.mjs` | Dry-run import of the training spreadsheet |
| `node scripts/classify-exercises.mjs` | Classifies movement types, sets anchors, seeds core |

---

## Stack, and the one surprise

- **Next.js 16** · App Router · TypeScript · Tailwind v4
- **Supabase** — Postgres 17, Auth (Google), row-level security on every table
- **Anthropic API** — `claude-opus-5`
- **Vitest** for unit tests, **psql** for schema tests
- **Vercel** for hosting

> **Next.js 16 renamed Middleware to Proxy.** Session refresh lives in **`proxy.ts`**, not
> `middleware.ts`. A file named `middleware.ts` is simply never invoked. Every
> Supabase-plus-Next tutorial online still says middleware, and so will most model output.
> The scaffold's own `AGENTS.md` tells you to read `node_modules/next/dist/docs/` before
> writing code; those docs are bundled locally and are the authority over anything recalled.

Also note: `cookies()` is async (`await cookies()`), and `params` / `searchParams` are
Promises. Route types are generated — run `npx next typegen` after adding a route or
`PageProps<"/your-route">` will not typecheck.

---

## Layout

```
app/
  page.tsx              placeholder home; proves auth + the signup trigger
  login/                sign-in page + Google OAuth button (client component)
  auth/callback/        OAuth code exchange
  auth/actions.ts       sign-out server action
  globals.css           design tokens (see PRODUCT.md for the palette)
proxy.ts                session refresh + optimistic redirects
lib/
  types.ts              shared domain types
  progression.ts        the double-progression rule — pure, tested
  session/lifecycle.ts  start / pause / resume / finish — pure, tested
  coach/types.ts        the contract for "what the coach knows"
  coach/derive.ts       derived facts (observed behaviour, unmet instructions)
  coach/assemble.ts     queries the database and composes the context
  coach/prompts.ts      system prompt + context rendering (cache boundary lives here)
  coach/generate-plan.ts the one model call, with a deterministic fallback
  supabase/{client,server,env}.ts
  health/               Phase 2, empty
supabase/
  migrations/           schema as versioned SQL — the source of truth
  test/                 auth stub + behavioural schema assertions
scripts/
  check-env.mjs         env validation
  import-xlsx.mjs       one-time spreadsheet import
  verify-schema.sh      local schema verification harness
docs/                   this guide, PRODUCT, ARCHITECTURE, DECISIONS, PLAN, design/
```

---

## The database

13 tables, all with `user_id` and an RLS policy of `user_id = auth.uid()`.

```
profiles           identity, goals (ordered enum[]), training level, check-in day,
                   split + style preference, durable constraints
exercises          per-user library; `movement_type` drives session order,
                   `preference` includes anchor (must appear 2x/week) and excluded
exercise_targets   baseline and next target per exercise
day_preferences    per-day can_train + duration; `usual_time` only for calendar sync
week_plans         generated weeks; `raw_plan` keeps the exact model output
planned_sessions   a day within a week plan; warmup_min is inside time_budget_min
planned_exercises  a prescription within a session
sessions           an actual training session — see the status model below
set_logs           the spine: every set ever logged
body_metrics       weight, body fat, waist
health_daily       steps/sleep per (user, date, provider) — Phase 2
checkins           what the user said each week
chat_messages      coach conversation
```

### Things the schema does that will surprise you

**Generated columns do the arithmetic.** `set_logs.volume` and `set_logs.est_1rm` (Epley)
are computed by Postgres, never by application code, so they cannot drift between code
paths. `sessions.active_ms` subtracts `paused_ms` from the wall-clock span.

**`sessions.status` has five values and the distinctions matter.**

| Status | Meaning | Duration |
|---|---|---|
| `active` | In progress | null until it ends |
| `paused` | Interrupted; `paused_at` set | null |
| `completed` | Finished properly | computed |
| `missed` | Planned, never started | null — **this is signal, not absence** |
| `abandoned` | Started and forgotten | **null on purpose** |

A session running >4h with no recent set is auto-abandoned. `abandoned` and `missed` both
report **null** duration: an unknown duration must stay unknown rather than become a
misleading number that drags averages. Imported history is `completed` with null
timestamps for the same reason.

**One in-flight session per user**, enforced by a partial unique index on
`status in ('active','paused')`. Double-tapping Start cannot open two clocks.

**Excluding an exercise never deletes its history.** `preference = 'excluded'` stops it
being programmed; the logged sets remain and still count toward volume and PRs. Asserted
in `supabase/test/verify_schema.sql`.

**`reps` is nullable.** The source data contains "set done but rep count not reported", and
`lib/progression.ts` treats unreported reps as *not* clearing the range — so incomplete
logging can never earn a weight increase.

### Migrations

Schema lives in `supabase/migrations/*.sql` and is applied with the CLI:

```bash
npx supabase login                       # one-off, needs a real TTY
npx supabase link --project-ref <ref>
npx supabase db push --dry-run           # see what would apply
npx supabase db push
npx supabase migration list              # local vs remote
```

**Always run `./scripts/verify-schema.sh` before pushing.** It rebuilds a throwaway local
database from empty, applies every migration, and asserts behaviour — generated-column
arithmetic, the one-active-session rule, and that RLS actually denies a second user. The
RLS test runs as a non-superuser on purpose: Postgres bypasses RLS for table owners, so a
naive test passes vacuously.

Requires `brew install postgresql@17`. Production is hosted Supabase; the local database
exists only to catch schema bugs before they reach it.

---

## Where the real logic is

### `lib/progression.ts` — the rule, in code

> Hit the top of the rep range on **every** working set → add the smallest increment.
> Until then, add reps, not weight.

This is deterministic, so it lives in code where it is unit-tested and the model cannot
silently get it wrong. Claude receives the *result* as fact.

Two behaviours worth knowing:
- A set with missing or zero reps counts as **not** clearing. Failing to progress costs
  one session; progressing on unconfirmed data means loading a bar you have not earned.
- Bodyweight exercises (`unit = 'BW'`) never get weight added — progression is reps.

### `lib/session/lifecycle.ts` — timing

Pure state machine. `now` is always passed in, never read from the clock, so production
can pass the *database's* time: a wrong phone clock or a mid-session timezone change must
not be able to corrupt a duration.

`activeMs` returns **null** for abandoned and never-started sessions, deliberately
mirroring the `sessions.active_ms` generated column. **These two must agree** — otherwise
a figure computed in the app silently disagrees with the same figure computed in SQL.

### `lib/coach/` — what the coach knows

The Claude API is **stateless**. It remembers nothing between calls. Everything that makes
the coach feel like it knows a user is assembled per call, here. `types.ts` is the
contract: a fact absent from those types cannot be acted on, whatever the database holds.

`derive.ts` computes what a coach would *notice*:

- **Observed vs stated behaviour.** The user says four days a week; the logs say 2.2. The
  gap is the information. Trusting the stated figure means agreeing with a self-image.
- **Problem weekdays.** Planned four times, completed once → the day is wrong, not the
  person. Move the session.
- **Neglected session types.** A different diagnosis: skipped wherever it lands points at
  the session, not the slot.
- **Unmet instructions** — the highest-value line in the context. Only an *unbroken* run
  of failures counts; an instruction met since is resolved however often it failed before.
- **Median** session length, not mean, so one 88-minute Saturday does not redefine a
  30-minute norm.
- **Waist-to-height**, not BMI, which penalises height and muscle.

`assemble.ts` is the only impure part: it queries, then hands everything to the pure
functions. Two traps live here.

**Never compute a date with `toISOString()`.** That is UTC, and between local midnight and
UTC midnight it returns tomorrow — which shifts the history window and changes which day
"today" is. Use `todayInTimezone(profile.timezone)`. This bug shipped once and reported 11
sessions as 10; both the code and its test shared the same wrong clock, so they agreed.

**Exercise classification trusts data over names.** `unit = 'BW'` is decided by whether a
non-zero weight has ever been logged, *then* by a word-anchored name pattern. A substring
regex once matched "ma-CHIN-e" and marked every machine exercise bodyweight, which stops
progression from ever adding weight to them. A zero baseline means "not measured", never
"bodyweight".

**Rep targets are inferred for imported history**, since logs record what was achieved
rather than what was prescribed. The inference biases toward "earned" and stops being used
once plans come from the app and `planned_exercises.target_reps` is populated.

---

## Conventions

**Rules in code, judgement in the model.** Anything deterministic — progression, session
timing, adherence maths — is computed and tested. The model does only what needs
judgement: exercise selection under constraints, fitting a time budget, coaching notes.

**Derived over raw.** Never send 155 set rows to the model. "Lat Pulldown stuck at 120 for
three weeks" is one line and is the whole insight.

**Everything carries a date.** A constraint raised a month ago and never repeated is weaker
evidence than one raised this week, and the model can only weigh that if told when.

**Nothing is deleted to tidy up.** Excluded exercises keep their sets; the importer's
`--prune` refuses to drop anything with logged history. Losing training data to
housekeeping is worse than a stale name.

**`getUser()`, never `getSession()`, on the server.** `getSession()` decodes the cookie
without validating it, so a forged or stale one would be trusted. Authorization uses the
revalidated call. `proxy.ts` is a convenience redirect, not the authorization boundary —
pages verify, and RLS backstops.

**Pure functions get unit tests; the schema gets behavioural tests.** If something can be
tested without a network, it is.

---

## Keeping the docs honest

**Every commit that changes behaviour updates the relevant document in the same commit.**

| Changed | Update |
|---|---|
| Schema, scripts, structure, conventions | `DEVELOPERS.md` |
| Features, flows, product reasoning | `PRODUCT.md` |
| A non-obvious decision, or one reversed | `DECISIONS.md` |
| Build sequence or phase scope | `PLAN.md` |
| System boundaries or vendor choice | `ARCHITECTURE.md` |

Docs written a week later are reconstructions. The point of `DECISIONS.md` in particular is
to capture the reasoning *while it is still true*, including the mistakes — there are two
corrections recorded in it, and both are more useful than a clean history would have been.
