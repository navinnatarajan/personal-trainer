-- Makes session structure and anchor lifts enforceable rather than hoped for.
--
-- The existing pattern: anything deterministic is computed and checked in code, and the
-- model only does what needs judgement. Session shape ("one or two compounds first, then
-- accessories") is a rule, so it becomes data the validator can assert against instead of
-- prose the model may quietly ignore.

-- ---------------------------------------------------------------------------
-- Movement type
-- ---------------------------------------------------------------------------
--
-- compound  — multi-joint, high systemic demand. Goes early, while fresh.
-- accessory — single-joint or supported. Fills out the session.
-- core      — trunk work. Finisher only; see the note below.
--
-- Worth recording why core is never a compound here: a pull-up is a compound even though
-- it loads the trunk hard, and treating trunk work as a main lift would push the actual
-- compounds later in the session, which is the opposite of the intent.
create type movement_type as enum ('compound', 'accessory', 'core');

alter table exercises
  add column movement_type movement_type not null default 'accessory';

comment on column exercises.movement_type is
  'drives session ordering: compounds go first while fresh, core is a finisher';

-- ---------------------------------------------------------------------------
-- Anchor lifts
-- ---------------------------------------------------------------------------
--
-- 'favourite' existed but nothing was ever set to it, and the prompt treated it as a weak
-- tiebreaker. An anchor is stronger: a lift the user considers non-negotiable, which must
-- appear at least twice a week. Lateral Raise is the real example — 28 logged sets, the
-- most-trained lift in the library by half again, and the highest-leverage movement for a
-- v-taper goal. The first generated plan gave it one slot.
alter type exercise_preference add value if not exists 'anchor';

comment on column exercises.preference is
  'anchor = non-negotiable, must appear at least twice a week; excluded = never programmed but keeps its history';

-- ---------------------------------------------------------------------------
-- Warmup is part of the budget, not extra
-- ---------------------------------------------------------------------------
--
-- Previously the plan never mentioned a warmup, so the user did one on top of the stated
-- 30 minutes — making every session 35-40 minutes in practice. The time budget is now
-- explicitly inclusive, and the plan has to say what the warmup is.
alter table planned_sessions
  add column warmup_min smallint not null default 5
    constraint planned_sessions_warmup_range check (warmup_min between 0 and 30),
  add column warmup_note text;

comment on column planned_sessions.warmup_min is
  'counted inside time_budget_min, never added to it';
