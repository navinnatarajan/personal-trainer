-- How the user wants their week divided.
--
-- Shapes which sessions exist before exercise selection happens, so it belongs in the
-- profile rather than being inferred from the day count.

create type split_preference as enum (
  -- Separate push, pull and leg days. The most common intermediate split.
  'push_pull_legs',
  -- Upper body and lower body, alternating.
  'upper_lower',
  -- Every session touches one push, one pull and one leg compound plus accessories.
  -- Deliberately offered for beginners: higher frequency per muscle group, more technique
  -- practice per movement, and it still works when only two sessions happen in a week.
  'full_body',
  -- Let the coach choose from goals, available days and history.
  'coach_decides'
);

alter table profiles
  add column split_preference split_preference not null default 'coach_decides';

comment on column profiles.split_preference is
  'shapes which sessions exist; coach_decides lets goals and available days drive it';
