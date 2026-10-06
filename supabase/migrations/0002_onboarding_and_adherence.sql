-- Adds what the design review surfaced: missed sessions as signal, exercise
-- preferences, training level, a configurable check-in day, and a nullable slot for
-- calendar times.

-- ---------------------------------------------------------------------------
-- Missed sessions count
-- ---------------------------------------------------------------------------
--
-- A planned session that never happened is data, not absence. Repeatedly missing
-- Thursday means Thursday is the wrong day, and plan generation should see that rather
-- than silently re-scheduling it.
--
-- Distinct from 'abandoned', which already exists and means something different:
--   missed    -> never started. No sets. The plan was not attempted.
--   abandoned -> started and forgotten. Sets may exist; the duration is untrustworthy.
-- Both are incomplete, but they are different signals and get different treatment.
alter type session_status add value if not exists 'missed';

-- ---------------------------------------------------------------------------
-- Exercise preferences
-- ---------------------------------------------------------------------------
--
-- "I will not do RDLs" is durable information that belongs next to the exercise, not
-- retyped every week in the check-in box.
--
-- An exclusion never deletes history. The same rule as --prune in the importer: a lift
-- with logged sets keeps them, it just stops being programmed. Excluding Romanian
-- Deadlift does not erase the three sets already recorded against it.
create type exercise_preference as enum ('favourite', 'neutral', 'excluded');

alter table exercises
  add column preference exercise_preference not null default 'neutral';

comment on column exercises.preference is
  'excluded lifts are never programmed but keep their logged history; favourites are preferred when the model has a choice';

-- Partial index: plan generation always filters out exclusions, and they are rare.
create index exercises_programmable
  on exercises (user_id, muscle_group)
  where preference <> 'excluded';

-- ---------------------------------------------------------------------------
-- Profile: training level, check-in day, durable constraints
-- ---------------------------------------------------------------------------

create type training_level as enum ('beginner', 'novice', 'intermediate', 'advanced');

alter table profiles
  -- Drives starting-weight recommendations for a user with no history.
  add column training_level training_level not null default 'novice',
  -- ISO weekday (1 = Monday .. 7 = Sunday). Sunday by default, but a second user
  -- training on a different rhythm needs their own.
  add column checkin_dow smallint not null default 7
    constraint profiles_checkin_dow_range check (checkin_dow between 1 and 7),
  -- Things true until changed: equipment the gym lacks, long-standing injuries, lifts
  -- ruled out for reasons other than preference. Fed to plan generation every week so
  -- the user never retypes them.
  add column durable_constraints text;

-- ---------------------------------------------------------------------------
-- Per-day training duration
-- ---------------------------------------------------------------------------
--
-- Replaces the single profile-level session_budget_min. A long Saturday is one user's
-- constraint, not a property of the app.
create table day_preferences (
  user_id      uuid not null references auth.users on delete cascade,
  -- ISO weekday, 1 = Monday.
  dow          smallint not null check (dow between 1 and 7),
  can_train    boolean not null default false,
  duration_min smallint check (duration_min is null or duration_min between 5 and 300),
  -- Only ever populated when the user opts into calendar sync, so the check-in does not
  -- have to ask for seven times up front. Once the timer has run for a while,
  -- set_logs.logged_at can suggest a value rather than asking cold.
  usual_time   time,
  primary key (user_id, dow)
);

alter table day_preferences enable row level security;
create policy day_preferences_owner on day_preferences
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Same field on a generated session, so an adjusted week can carry its own time.
alter table planned_sessions add column planned_time time;
