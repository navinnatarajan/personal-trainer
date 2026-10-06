-- Types the fields that feed the plan-generation prompt, and adds age.
--
-- Free text is fine for things a human reads. It is a liability for anything the model
-- keys off: "lose fat", "cut", and "get lean" are one goal written three ways, and the
-- prompt would treat them as three.

-- ---------------------------------------------------------------------------
-- Goals
-- ---------------------------------------------------------------------------
-- Vocabulary taken from the original brief: body fat, strength, endurance, v-taper.
-- Distinct from lifecycle_stage, which is *where* someone is in their journey
-- (building habits / train and grow / maintenance) rather than what they want.
create type training_goal as enum (
  'lose_body_fat',
  'build_strength',
  'build_muscle',
  'build_endurance',
  'v_taper'
);

alter table profiles
  add column goals_typed training_goal[] not null default '{}';

comment on column profiles.goals_typed is
  'ordered by priority — the first entry is what the plan optimises for when goals conflict';

-- Nothing has been entered through the app yet, so there is no free text to migrate;
-- the old column goes rather than lingering as a second source of truth.
alter table profiles drop column goals;
alter table profiles rename column goals_typed to goals;

-- ---------------------------------------------------------------------------
-- Sex and age
-- ---------------------------------------------------------------------------
-- Both optional. Sex informs body-composition targets; age informs recovery capacity
-- and volume tolerance. Neither should block someone from using the app.
create type biological_sex as enum ('male', 'female', 'prefer_not_to_say');

alter table profiles
  add column sex_typed biological_sex;
alter table profiles drop column sex;
alter table profiles rename column sex_typed to sex;

-- Stored as a birth year rather than an age, so it does not silently go stale.
alter table profiles
  add column birth_year smallint
    constraint profiles_birth_year_range check (
      birth_year is null or birth_year between 1920 and 2020
    );

-- ---------------------------------------------------------------------------
-- Remove the superseded single time budget
-- ---------------------------------------------------------------------------
-- day_preferences.duration_min replaced this: a long Saturday is one user's
-- constraint, not a single number for the whole week.
alter table profiles drop column session_budget_min;

-- days_available is likewise superseded by day_preferences.can_train.
alter table profiles drop column days_available;
