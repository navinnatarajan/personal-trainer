-- Behavioural checks against a throwaway database. Verifies the things that are easy to
-- get silently wrong: generated-column arithmetic, the one-active-session guarantee, and
-- that row-level security actually denies another user.
--
-- Run via scripts/verify-schema.sh. Any failure raises and aborts.

\set ON_ERROR_STOP on

begin;

-- Two users, so RLS has something to deny.
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'navin@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'someone-else@example.com');

do $$
declare
  navin uuid := '11111111-1111-1111-1111-111111111111';
  ex_id uuid;
  sess_id uuid;
  got_volume numeric;
  got_1rm numeric;
  got_active_ms bigint;
  got_null_active bigint;
  cnt integer;
begin
  -- The signup trigger should have created profiles automatically.
  select count(*) into cnt from profiles where id = navin;
  if cnt <> 1 then
    raise exception 'FAIL: signup trigger did not create a profile (got % rows)', cnt;
  end if;

  insert into exercises (user_id, name, muscle_group, unit, increment_lbs)
  values (navin, 'Incline Bench (BB)', 'Chest', 'lb', 5)
  returning id into ex_id;

  -- A session that ran 30 minutes wall-clock with 5 minutes paused.
  insert into sessions (user_id, date, session_name, status, started_at, ended_at, paused_ms)
  values (
    navin, '2026-08-24', 'Push', 'completed',
    '2026-08-24 07:00:00+00', '2026-08-24 07:30:00+00',
    5 * 60 * 1000
  ) returning id into sess_id;

  select active_ms into got_active_ms from sessions where id = sess_id;
  if got_active_ms <> 25 * 60 * 1000 then
    raise exception 'FAIL: active_ms should exclude paused time. Expected %, got %',
      25 * 60 * 1000, got_active_ms;
  end if;

  -- Sets from the Workout Log sheet: 115 lb x 8/8/8/7.
  insert into set_logs (user_id, session_id, exercise_id, set_number, weight_lbs, reps, rir)
  values
    (navin, sess_id, ex_id, 1, 115, 8, 1),
    (navin, sess_id, ex_id, 2, 115, 8, 1),
    (navin, sess_id, ex_id, 3, 115, 8, 0),
    (navin, sess_id, ex_id, 4, 115, 7, 0);

  select volume, est_1rm into got_volume, got_1rm
  from set_logs where session_id = sess_id and set_number = 1;

  if got_volume <> 920 then
    raise exception 'FAIL: volume for 115x8 should be 920, got %', got_volume;
  end if;
  -- Sheet displays 145.7 at one decimal; stored at two.
  if round(got_1rm, 1) <> 145.7 then
    raise exception 'FAIL: est_1rm for 115x8 should round to 145.7, got %', got_1rm;
  end if;

  -- Unreported reps must not blow up the generated columns.
  insert into set_logs (user_id, session_id, exercise_id, set_number, weight_lbs, reps)
  values (navin, sess_id, ex_id, 5, 45, null);
  select volume into got_volume from set_logs where session_id = sess_id and set_number = 5;
  if got_volume <> 0 then
    raise exception 'FAIL: volume with null reps should be 0, got %', got_volume;
  end if;

  -- An unfinished session must report no duration rather than a bogus one, so it
  -- cannot pollute averages.
  insert into sessions (user_id, date, session_name, status, started_at)
  values (navin, '2026-08-26', 'Pull', 'active', now())
  returning active_ms into got_null_active;
  if got_null_active is not null then
    raise exception 'FAIL: in-flight session should have null active_ms, got %', got_null_active;
  end if;

  -- An abandoned session must also report no duration: its real end time was never
  -- recorded. lib/session/lifecycle.ts mirrors this, and the two must agree so a figure
  -- computed in the app matches the same figure computed in SQL.
  insert into sessions (user_id, date, session_name, status, started_at)
  values (navin, '2026-08-25', 'Legs', 'abandoned', now() - interval '9 hours')
  returning active_ms into got_null_active;
  if got_null_active is not null then
    raise exception 'FAIL: abandoned session should have null active_ms, got %',
      got_null_active;
  end if;

  -- Only one in-flight session per user.
  begin
    insert into sessions (user_id, date, session_name, status, started_at)
    values (navin, '2026-08-26', 'Legs', 'active', now());
    raise exception 'FAIL: a second active session was allowed';
  exception when unique_violation then
    null; -- expected
  end;

  -- Completed sessions are not restricted, so a normal training week works.
  insert into sessions (user_id, date, session_name, status, started_at, ended_at)
  values (navin, '2026-08-27', 'Push', 'completed', now() - interval '1 hour', now());

  -- ended_at before started_at must be rejected.
  begin
    insert into sessions (user_id, date, status, started_at, ended_at)
    values (navin, '2026-08-28', 'completed', now(), now() - interval '1 hour');
    raise exception 'FAIL: reversed start/end timestamps were allowed';
  exception when check_violation then
    null; -- expected
  end;

  -- A planned session that never happened is recorded, not absent: repeatedly missing
  -- a day is signal for plan generation.
  insert into sessions (user_id, date, session_name, status)
  values (navin, '2026-08-29', 'Legs', 'missed');
  select count(*) into cnt from sessions where user_id = navin and status = 'missed';
  if cnt <> 1 then
    raise exception 'FAIL: missed session was not recorded (got %)', cnt;
  end if;

  -- Excluding a lift must never destroy its history. This is the same rule the
  -- importer's --prune guard enforces: stop programming it, keep the data.
  update exercises set preference = 'excluded' where id = ex_id;
  select count(*) into cnt from set_logs where exercise_id = ex_id;
  if cnt <> 5 then
    raise exception 'FAIL: excluding an exercise lost its logged sets (% remain)', cnt;
  end if;

  -- ...and an excluded lift drops out of the programmable set.
  select count(*) into cnt
  from exercises where user_id = navin and preference <> 'excluded';
  if cnt <> 0 then
    raise exception 'FAIL: excluded exercise still counted as programmable (%)', cnt;
  end if;
  update exercises set preference = 'neutral' where id = ex_id;

  -- Check-in day must be a valid ISO weekday.
  begin
    update profiles set checkin_dow = 8 where id = navin;
    raise exception 'FAIL: checkin_dow 8 was accepted';
  exception when check_violation then
    null; -- expected
  end;

  -- Per-day duration, with usual_time left null until calendar sync is opted into.
  insert into day_preferences (user_id, dow, can_train, duration_min)
  values (navin, 6, true, 90);
  select count(*) into cnt
  from day_preferences where user_id = navin and dow = 6 and usual_time is null;
  if cnt <> 1 then
    raise exception 'FAIL: day_preferences row not stored as expected';
  end if;

  raise notice 'PASS: generated columns and constraints behave correctly';
end $$;

-- ---------------------------------------------------------------------------
-- Row-level security, checked as a non-superuser (RLS is bypassed for owners).
-- ---------------------------------------------------------------------------

create role rls_probe nologin;
grant usage on schema public, auth to rls_probe;
grant select, insert, update, delete on all tables in schema public to rls_probe;

set local role rls_probe;

-- Impersonate the other user; they must see none of Navin's rows.
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

do $$
declare
  visible_sets integer;
  visible_sessions integer;
begin
  select count(*) into visible_sets from set_logs;
  select count(*) into visible_sessions from sessions;
  -- new table must be locked down too, not just the original ones
  perform 1 from day_preferences limit 1;
  if found then
    raise exception 'FAIL: RLS leaked day_preferences to another user';
  end if;
  if visible_sets <> 0 or visible_sessions <> 0 then
    raise exception
      'FAIL: RLS leaked another user''s data (% set_logs, % sessions visible)',
      visible_sets, visible_sessions;
  end if;
  raise notice 'PASS: RLS denies another user';
end $$;

-- Now impersonate Navin; the rows must reappear.
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);

do $$
declare
  visible_sets integer;
begin
  select count(*) into visible_sets from set_logs;
  if visible_sets <> 5 then
    raise exception 'FAIL: owner should see their own 5 sets, saw %', visible_sets;
  end if;
  raise notice 'PASS: RLS allows the owner';
end $$;

reset role;

rollback;
