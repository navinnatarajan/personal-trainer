-- Core schema for the personal trainer app.
--
-- Ported from the sheets of Navin_Training_Tracker.xlsx, which is the validated
-- domain model:
--   Dashboard    -> exercises, exercise_targets
--   Week Plan    -> week_plans, planned_sessions, planned_exercises
--   Workout Log  -> sessions, set_logs
--   Body Metrics -> body_metrics
--   Meal Log / Nutrition -> deferred to Phase 3
--
-- Every user-owned table carries user_id and an RLS policy restricting access to
-- auth.uid(). RLS is enabled unconditionally: a table without it is readable by anyone
-- holding the anon key, which is published to the browser by design.

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------

create type lifecycle_stage as enum (
  'building_habits',
  'train_and_grow',
  'maintenance'
);

create table profiles (
  id                uuid primary key references auth.users on delete cascade,
  display_name      text,
  goals             text[] not null default '{}',
  lifecycle_stage   lifecycle_stage not null default 'building_habits',
  height_in         numeric(4,1),
  weight_lbs        numeric(5,1),
  sex               text,
  bodyfat_pct_est   numeric(4,1),
  -- ISO weekday numbers (1 = Monday .. 7 = Sunday) the user can train.
  days_available    smallint[] not null default '{}',
  session_budget_min smallint,
  equipment         text[] not null default '{}',
  gym_name          text,
  timezone          text not null default 'America/Chicago',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Exercise library
-- ---------------------------------------------------------------------------

create type weight_unit as enum ('lb', '/side', 'BW');

create table exercises (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users on delete cascade,
  name          text not null,
  muscle_group  text not null,
  equipment     text,
  unit          weight_unit not null default 'lb',
  -- Smallest available jump: dumbbells 2.5, barbell 5, machines vary.
  -- 0 for bodyweight movements, where progression is reps rather than load.
  increment_lbs numeric(4,1) not null default 5,
  notes         text,
  created_at    timestamptz not null default now(),
  unique (user_id, name)
);

-- The Dashboard sheet. Only baseline and next_target are stored; everything else on
-- that sheet (best weight, best 1RM, last trained, total volume) is derived from
-- set_logs and belongs in a view, not a column.
create table exercise_targets (
  user_id         uuid not null references auth.users on delete cascade,
  exercise_id     uuid not null references exercises on delete cascade,
  baseline_weight numeric(6,2),
  next_target     numeric(6,2),
  updated_at      timestamptz not null default now(),
  primary key (user_id, exercise_id)
);

-- ---------------------------------------------------------------------------
-- Week plans
-- ---------------------------------------------------------------------------

create type week_plan_status as enum ('draft', 'active', 'completed', 'superseded');

create table week_plans (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  week_number integer not null,
  starts_on   date not null,
  ends_on     date not null,
  headline    text,
  notes       text,
  status      week_plan_status not null default 'draft',
  model_used  text,
  -- Exactly what the model returned. Kept as the audit trail for a plan that looks
  -- wrong, and as a replayable fixture when debugging prompt regressions.
  raw_plan    jsonb,
  created_at  timestamptz not null default now(),
  unique (user_id, week_number),
  constraint week_plans_date_order check (ends_on >= starts_on)
);

create table planned_sessions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users on delete cascade,
  week_plan_id    uuid not null references week_plans on delete cascade,
  date            date not null,
  dow             text not null,
  session_name    text not null,
  time_budget_min smallint,
  headline        text,
  sort_order      smallint not null default 0
);

create table planned_exercises (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users on delete cascade,
  planned_session_id  uuid not null references planned_sessions on delete cascade,
  exercise_id         uuid not null references exercises on delete restrict,
  sort_order          smallint not null default 0,
  sets                smallint not null,
  target_weight       numeric(6,2),
  unit                weight_unit not null default 'lb',
  -- Free text by design: "8", "6-8", "10+" all occur. Parsed by lib/progression.ts.
  target_reps         text not null,
  rest_sec            smallint,
  -- Exercises sharing a group within a session are supersetted.
  superset_group      text,
  tag                 text,
  coaching_note       text
);

-- ---------------------------------------------------------------------------
-- Sessions — explicit start/stop, because inferred timing was wrong
-- ---------------------------------------------------------------------------
--
-- The original HTML tracker inferred duration from set ticks: start was the first set
-- ticked, end was overwritten on every subsequent tick. That excluded warmup, ended at
-- the last tick rather than when the user left, and ballooned silently if a set went
-- unlogged. Timestamps here are set by the database (now()), never the browser, so a
-- wrong phone clock or a timezone change cannot corrupt them.

create type session_status as enum ('active', 'paused', 'completed', 'abandoned');

create table sessions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users on delete cascade,
  -- Nullable: unplanned gym visits happen, and historical imports have no plan.
  planned_session_id uuid references planned_sessions on delete set null,
  date               date not null,
  session_name       text,
  status             session_status not null default 'active',
  started_at         timestamptz,
  ended_at           timestamptz,
  -- Accumulated paused time. Sessions get interrupted; without this, users either
  -- accept wrong numbers or stop trusting them.
  paused_ms          bigint not null default 0,
  -- Set when a pause begins, cleared on resume. Non-null means currently paused.
  paused_at          timestamptz,
  notes              text,
  created_at         timestamptz not null default now(),

  -- Null until the session ends, so unfinished sessions never pollute averages.
  -- Historical imports leave started_at/ended_at null rather than inventing durations.
  active_ms bigint generated always as (
    case
      when started_at is not null and ended_at is not null
        then greatest(
          0,
          (extract(epoch from (ended_at - started_at)) * 1000)::bigint - paused_ms
        )
    end
  ) stored,

  constraint sessions_time_order check (ended_at is null or ended_at >= started_at),
  constraint sessions_paused_ms_non_negative check (paused_ms >= 0)
);

-- One in-flight session per user: prevents double-tapping Start from opening two clocks.
create unique index sessions_one_active_per_user
  on sessions (user_id)
  where status in ('active', 'paused');

create index sessions_user_date on sessions (user_id, date desc);

-- ---------------------------------------------------------------------------
-- Set logs — the spine of the whole app
-- ---------------------------------------------------------------------------

create table set_logs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  session_id  uuid not null references sessions on delete cascade,
  exercise_id uuid not null references exercises on delete restrict,
  set_number  smallint not null,
  weight_lbs  numeric(6,2) not null,
  -- Nullable on purpose. The source data contains "set 3 done but rep count not
  -- reported"; lib/progression.ts treats unreported reps as not clearing the range,
  -- so incomplete logging can never earn a weight increase.
  reps        smallint,
  rir         smallint,
  notes       text,
  -- Per-set timestamp gives real rest intervals and set tempo for free.
  logged_at   timestamptz not null default now(),

  volume numeric(10,2) generated always as (weight_lbs * coalesce(reps, 0)) stored,
  -- Epley, matching the original spreadsheet exactly (115 lb x 8 -> 145.7).
  est_1rm numeric(10,2) generated always as (
    weight_lbs * (1 + coalesce(reps, 0) / 30.0)
  ) stored,

  unique (session_id, exercise_id, set_number)
);

create index set_logs_user_exercise on set_logs (user_id, exercise_id, logged_at desc);

-- ---------------------------------------------------------------------------
-- Body metrics and health
-- ---------------------------------------------------------------------------

create table body_metrics (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users on delete cascade,
  date         date not null,
  weight_lbs   numeric(5,1),
  bodyfat_pct  numeric(4,1),
  waist_in     numeric(4,1),
  notes        text,
  unique (user_id, date)
);

-- Provider is part of the key rather than a single row per day: a user may have both an
-- iOS Shortcuts feed and Google Health, and overwriting one with the other loses data.
create table health_daily (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users on delete cascade,
  date          date not null,
  provider      text not null,
  steps         integer,
  sleep_minutes integer,
  active_kcal   integer,
  resting_hr    smallint,
  synced_at     timestamptz not null default now(),
  unique (user_id, date, provider)
);

-- ---------------------------------------------------------------------------
-- Check-ins and coach chat
-- ---------------------------------------------------------------------------

create table checkins (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users on delete cascade,
  week_number       integer not null,
  -- Availability, time budget, niggles as captured by the check-in form.
  user_constraints  jsonb not null default '{}',
  -- Calendar events and anything else affecting the week (basketball, travel).
  events            jsonb not null default '[]',
  ai_summary        text,
  created_at        timestamptz not null default now(),
  unique (user_id, week_number)
);

create table chat_messages (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade,
  thread_id  uuid not null,
  role       text not null,
  -- Anthropic content blocks, stored verbatim so tool calls survive a round trip.
  content    jsonb not null,
  created_at timestamptz not null default now()
);

create index chat_messages_thread on chat_messages (user_id, thread_id, created_at);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table profiles           enable row level security;
alter table exercises          enable row level security;
alter table exercise_targets   enable row level security;
alter table week_plans         enable row level security;
alter table planned_sessions   enable row level security;
alter table planned_exercises  enable row level security;
alter table sessions           enable row level security;
alter table set_logs           enable row level security;
alter table body_metrics       enable row level security;
alter table health_daily       enable row level security;
alter table checkins           enable row level security;
alter table chat_messages      enable row level security;

create policy profiles_owner on profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

-- Same shape for every user-owned table. Written out rather than generated so the
-- policy on each table is greppable and reviewable on its own.
create policy exercises_owner on exercises
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy exercise_targets_owner on exercise_targets
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy week_plans_owner on week_plans
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy planned_sessions_owner on planned_sessions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy planned_exercises_owner on planned_exercises
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy sessions_owner on sessions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy set_logs_owner on set_logs
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy body_metrics_owner on body_metrics
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy health_daily_owner on health_daily
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy checkins_owner on checkins
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy chat_messages_owner on chat_messages
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Create a profile row automatically on signup
-- ---------------------------------------------------------------------------

create function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, new.raw_user_meta_data->>'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
