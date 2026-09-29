# personal-trainer

Repo to manage my build of the custom personal trainer app.

An AI personal trainer that collapses a weekly training loop into one app: it generates
a custom week plan from your actual lifting history, lets you log sets at the rack, and
progresses your weights so you don't plateau.

Replaces a workflow previously spread across a Claude chat, a hand-written HTML tracker,
and an Excel file moved between them by copy-paste.

## Status

Phase 0 — foundation. See [`docs/PLAN.md`](docs/PLAN.md) for the build plan,
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how the pieces fit, and
[`docs/DECISIONS.md`](docs/DECISIONS.md) for why things are the way they are.

## Stack

- **Next.js 16** (App Router) + TypeScript + Tailwind
- **Supabase** — Postgres + Auth (Google), row-level security on every table
- **Anthropic API** — `claude-opus-5` for week-plan generation and the coach chat
- **Vercel** — push to `main` deploys; branches get preview URLs

## Getting started

```bash
npm install
cp .env.example .env.local   # then fill in the values
npm run dev
```

`.env.local` is gitignored and must stay that way — it holds the Anthropic key and the
Supabase `service_role` key, which bypasses row-level security.

## Layout

```
app/                  routes (App Router)
lib/progression.ts    double-progression rule — pure, unit-tested
lib/coach/            week-plan generation + coach chat
lib/session/          session start/pause/resume/finish lifecycle
lib/health/           steps/sleep adapters (manual, iOS Shortcuts, Google Health)
supabase/migrations/  schema + RLS as versioned SQL
scripts/              one-off tooling (history import from the old spreadsheet)
docs/                 plan and decision log
```

## Branching

One branch per phase (`phase-0-foundation`, `phase-1-loop`, `phase-2-health`), merged to
`main` once that phase's verification in `docs/PLAN.md` passes.
