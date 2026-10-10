-- The two onboarding answers that had nowhere to land.
--
-- lib/coach/assemble.ts was hardcoding both to null with a TODO, so the gym question and
-- the lifting-style lean could be asked but not stored.

-- How much equipment is available. Drives whether onboarding bothers showing the
-- equipment checklist at all: a full-gym user ticking eight boxes conveys nothing, and
-- most people cannot recall their gym's inventory from memory anyway.
create type gym_type as enum ('full', 'limited', 'home_basics');

-- A lean, deliberately not a filter. Equipment is the hard gate — unloadable means never
-- programmed. This only biases selection: "mostly machines" should tilt the choice, not
-- delete every free-weight lift, which is what a filter would do and no coach would.
create type lifting_style as enum ('machines', 'mix', 'free_weights');

alter table profiles
  add column gym_type gym_type,
  add column style_preference lifting_style not null default 'mix';

comment on column profiles.style_preference is
  'biases exercise selection; never excludes a modality — equipment does the gating';
