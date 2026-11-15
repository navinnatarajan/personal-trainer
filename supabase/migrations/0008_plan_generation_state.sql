-- Adds the generation states. Separate from 0009, which uses them.
--
-- Postgres refuses to use a newly-added enum value inside the transaction that added it
-- (SQLSTATE 55P04), and `supabase db push` runs each migration file in a transaction. So
-- adding a value and referencing it must be two files.
alter type week_plan_status add value if not exists 'generating';
alter type week_plan_status add value if not exists 'failed';
