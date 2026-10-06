-- Minimal stand-in for the parts of Supabase's `auth` schema that the migrations
-- reference. Supabase provides these in a real project; this exists only so the
-- migrations can be applied to a throwaway local Postgres to verify they parse, that
-- generated columns compute correctly, and that the importer works — before pointing
-- anything at the real database.
--
-- Not used in production. See scripts/verify-schema.sh.

create schema if not exists auth;

create table auth.users (
  id                  uuid primary key default gen_random_uuid(),
  email               text unique,
  raw_user_meta_data  jsonb not null default '{}',
  created_at          timestamptz not null default now()
);

-- Supabase derives this from the request JWT. Locally it reads a session GUC so tests
-- can impersonate a user: select set_config('request.jwt.claim.sub', '<uuid>', false);
create function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
