-- Fix: Cursor SDK returns run IDs like "run-<uuid>" which are not valid UUIDs.
-- Change the id column from UUID to TEXT to accept any ID format.
ALTER TABLE agent_runs ALTER COLUMN id SET DATA TYPE TEXT;
ALTER TABLE agent_runs ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
