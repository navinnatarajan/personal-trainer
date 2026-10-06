# Architecture

How the pieces fit, and why these pieces rather than others. For the build sequence see
[`PLAN.md`](PLAN.md); for individual judgement calls see [`DECISIONS.md`](DECISIONS.md).

## Shape

```
┌──────────────────────────────────────────────────────┐
│  Browser — mobile-first, used standing at the rack   │
│  React Server Components, with client islands only   │
│  where state is genuinely local: set ticks, rest     │
│  timer, session clock                                │
└────────────────────┬─────────────────────────────────┘
                     │  Server Actions
                     ▼
┌──────────────────────────────────────────────────────┐
│  Next.js on Vercel — the only thing deployed         │
│                                                      │
│  Server Actions = the API layer (no separate backend)│
│                                                      │
│  lib/progression.ts   deterministic overload rules   │
│  lib/session/         timing state machine           │
│  lib/coach/           week-plan generation, chat     │
│  lib/health/          provider adapters              │
└──────┬────────────────────┬───────────────┬──────────┘
       │                    │               │
       ▼                    ▼               ▼
┌─────────────┐   ┌──────────────┐  ┌───────────────┐
│  Supabase   │   │  Anthropic   │  │  Google APIs  │
│  Postgres   │   │  claude-opus-5│ │  Calendar     │
│  Auth       │   │              │  │  Health       │
│  RLS        │   └──────────────┘  └───────────────┘
└─────────────┘
```

## Three properties that matter more than the vendors

### One deployable

There is no separate backend service. Server Actions are the API. Every additional
deployable is another thing to configure, secure, monitor, and debug — for four users
that cost buys nothing.

### Authorization lives in the database

Every user-owned table has row-level security: `user_id = auth.uid()`. A query that
forgets its `where user_id = ...` returns nothing rather than another user's data. The
database refuses; it isn't relying on application code being correct.

This is verifiable rather than aspirational — `scripts/verify-schema.sh` asserts that a
second user sees zero of the first user's rows, tested as a non-superuser (Postgres
bypasses RLS for table owners, so a naive test passes vacuously).

### Rules in code, judgement in the model

Progressive overload is a deterministic rule, so it lives in `lib/progression.ts`, is
unit-tested, and cannot be silently misapplied. Claude receives the computed result as
fact and does only what needs judgement: exercise selection under constraints, fitting
sessions into a time budget, choosing which lift to flag, and writing coaching notes that
reference real history.

The same split shows up in session timing: durations come from explicit user actions and
database timestamps, not from the model or from inference.

## Request flow: a logged set

1. User taps a set tick. A client component updates immediately (optimistic).
2. A Server Action writes to `set_logs`, using a Supabase client carrying the user's
   session, so RLS applies.
3. On failure the write is queued in `localStorage` and flushed on reconnect. Gym wifi is
   unreliable and losing a logged set mid-session is the one unforgivable bug.
4. `volume` and `est_1rm` are generated columns — computed by Postgres, never by the app,
   so they cannot drift between code paths.

## Request flow: generating a week

1. Sunday check-in collects availability, events, and constraints (pre-filled from
   Calendar when connected).
2. `lib/progression.ts` computes, per exercise, whether the top of the rep range was hit
   on every set — and therefore whether weight goes up. **This happens before any model
   call.**
3. `lib/coach/generate-plan.ts` sends that computed state plus history and constraints to
   `claude-opus-5`, with a Zod schema via `output_config.format`, so the response is a
   validated plan object rather than prose to be parsed.
4. The plan is written to `week_plans` / `planned_sessions` / `planned_exercises`, with
   the raw model response kept in `week_plans.raw_plan` as an audit trail and a replayable
   fixture for debugging prompt regressions.

Prompt caching puts the stable system prompt and exercise library first, with volatile
weekly context last, since any byte change early in the prefix invalidates everything
after it.

## Why Supabase rather than the GCP stack

Not because Supabase is better in the abstract. Because the binding constraint here is
time-to-a-working-loop with four users — not scale, and not ecosystem depth.

| | Supabase | GCP equivalent |
|---|---|---|
| Database | Postgres, provisioned in minutes | Cloud SQL + VPC connector |
| Auth | Built in, wired to RLS | Firebase Auth / Identity Platform |
| Browser → DB | Safe directly; RLS enforces | Not possible — needs a service in front |
| Deployables | 1 | 2+ (app plus Cloud Run backend) |
| Cost at 4 users | $0 on the free tier | ~$8/mo shared-core, ~$30/mo dedicated-core Cloud SQL, billed continuously |

Four structural reasons:

1. **Cloud SQL cannot be exposed to a browser**, so GCP forces a backend tier between
   client and database. RLS removes the need for that tier entirely. This is the largest
   architectural difference, not the cost.
2. **Cloud SQL bills continuously.** Cloud Run scales to zero; the database does not.
   There is no free tier.
3. **Serverless plus Cloud SQL has a connection-pooling problem.** Each invocation wants
   its own connection against a hard Postgres limit, so it needs Cloud SQL Proxy or
   PgBouncer configured correctly. Supabase ships a pooler. This is the kind of trap that
   bites after shipping, not before.
4. **The data is deeply relational** — sets inside sessions inside planned weeks, with
   aggregations like total volume per lift over eight weeks. That is SQL's home turf, and
   generated columns already carry part of the model. Reaching for Firestore, the tempting
   GCP default, would mean heavy denormalisation and computing those aggregations in
   application code.

### Where GCP would genuinely be better

- Calendar, Health, and sign-in are all Google. Firebase Auth or Identity Platform would
  mean one identity system and arguably tidier handling of long-lived OAuth refresh
  tokens. This is the strongest argument against the current choice. It is narrower than
  it looks — Supabase's Google provider does surface provider tokens — but it is real.
- One vendor and one bill, if GCP is already being paid for.
- Headroom that isn't needed now: Cloud Scheduler, Pub/Sub, BigQuery, Vertex AI.
- Fewer vendors is a genuine architectural virtue, and Supabase adds one.

### Why the decision is low-risk

Supabase is plain Postgres, not a proprietary datastore. Moving to Cloud SQL later means
`pg_dump` / `pg_restore`; the schema, RLS policies, generated columns, and every line of
SQL here port essentially unchanged. `lib/` is plain TypeScript with no vendor-specific
business logic.

What would not port is Supabase Auth and the `auth.uid()` plumbing RLS depends on — a
bounded cost, roughly a week, not a rewrite.

Supabase's auto-generated client-side REST API is deliberately unused. Going through
Server Actions keeps secrets server-side and keeps the coupling close to "auth plus a
connection string", which is what keeps the exit cheap.

## Known trade-offs

- **Free-tier Supabase projects pause after 7 days of inactivity.** Four active users
  won't trigger it, but a quiet fortnight means a cold start and a manual un-pause.
- **`NEXT_PUBLIC_*` variables are compiled into the browser bundle.** That is intended for
  the Supabase URL and anon key, whose safety rests on RLS. `SUPABASE_SERVICE_ROLE_KEY`
  bypasses RLS entirely and must never be renamed with that prefix — gitignore would not
  save you, since the value would ship to every visitor.
- **Vercel and Supabase are separate vendors**, so an outage in either takes the app down.
  Acceptable at this size; worth revisiting if this ever becomes something people pay for.
