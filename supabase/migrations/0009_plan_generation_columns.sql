-- Makes plan generation observable while it runs.
--
-- Generation takes around 70 seconds. Holding a request open that long works on a laptop
-- and fails on a phone, where browsers suspend background tabs as soon as the screen locks
-- or the user switches apps — which is exactly the device this is for.
--
-- So the database is the handoff: the work writes its result here and the UI reads from
-- here, and nothing depends on one connection surviving the whole generation.

alter table week_plans
  -- Set when generation starts. Also the staleness signal: a row stuck in 'generating'
  -- long past a plausible runtime means the worker died, and the UI must say so rather
  -- than poll forever.
  add column generation_started_at timestamptz,
  add column generation_finished_at timestamptz,
  -- Null unless status is 'failed'. Shown to the user: a failure the app cannot explain
  -- is worse than one it can.
  add column generation_error text,
  -- 'model' or 'fallback'. The fallback is a usable week built from progression alone, so
  -- it must never be mistaken for the real thing.
  add column generation_source text,
  -- Validation warnings from validatePlan. Non-empty does not mean unusable — the week is
  -- still trainable — so they are surfaced alongside the plan rather than blocking it.
  add column warnings text[] not null default '{}';

comment on column week_plans.generation_started_at is
  'null until generation begins; a long-stale value with status=generating means the worker died';

-- One in-flight generation per user. Double-tapping Generate must not bill twice or race
-- two writers against the same week.
create unique index week_plans_one_generating_per_user
  on week_plans (user_id)
  where status = 'generating';
