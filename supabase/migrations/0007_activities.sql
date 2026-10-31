-- Sport and cardio the user already does outside the gym.
--
-- This is load the coach was blind to. Basketball on Tuesday evening means Tuesday legs
-- competes with it and Wednesday legs lands on sore ones; someone already running three
-- times a week does not need conditioning added on top. Without it the plan treats every
-- non-gym day as full recovery, which is wrong for anyone with a sport.
--
-- A table rather than free text because the coach needs to reason per weekday, which
-- means it has to be queryable rather than prose.

create type activity_intensity as enum ('light', 'moderate', 'hard');

create table user_activities (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade,
  name       text not null,
  -- ISO weekdays this usually happens on. Empty means irregular, which is still useful:
  -- it says the activity exists without claiming to know when.
  dows       smallint[] not null default '{}',
  intensity  activity_intensity not null default 'moderate',
  notes      text,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

comment on table user_activities is
  'sport and cardio outside the gym — affects scheduling, recovery, and whether the plan adds conditioning';

alter table user_activities enable row level security;
create policy user_activities_owner on user_activities
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Marks setup as finished, so the app can send a new user to onboarding instead of a
-- dashboard with nothing in it. Nullable rather than boolean: the timestamp also records
-- when, which is useful when a profile looks stale.
alter table profiles add column onboarded_at timestamptz;

comment on column profiles.onboarded_at is
  'null means onboarding has not been completed; app routes an unonboarded user there';
