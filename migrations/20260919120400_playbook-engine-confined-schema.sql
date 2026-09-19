-- Up Migration: confined schema and least-privilege role for the engine's own tables (TBI-014)
--
-- TBI-014 was conditional on what FEAT-001's TBI-001 found. It found that the engine's store
-- auto-creates its tables by default (43 of them), that `disableInit: true` suppresses that
-- entirely, and that confining the store to a named schema under a restricted role works with zero
-- grants outside it. Recorded in design-docs/playbook-engine-verification.md.
--
-- So this is the real-migration branch, not the no-op: the schema is created here rather than by the
-- engine at startup, and the role that owns it can reach nothing else. Both halves matter. Without
-- the schema, the engine would create tables wherever its connection role can. Without the role, the
-- engine would hold the application role's rights across `public` — which is exactly the outcome the
-- ADR's storage-isolation branch exists to avoid, and which it names as a phase 0 failure.
--
-- The role is NOLOGIN deliberately. Giving it a password would mean putting a secret in version
-- control; granting it LOGIN, or granting membership so the application can SET ROLE into it, is a
-- deployment step that belongs with the code that first opens an engine connection (FEAT-004).
-- Phase 0 has nothing connecting as it yet, and a role that cannot log in is the safer resting state
-- for one that does not need to.
--
-- Requires CREATEROLE (or superuser). Local Postgres and Azure Flexible Server's admin both have it.

CREATE SCHEMA IF NOT EXISTS playbook_engine;

DO $$
BEGIN
  -- Postgres has no CREATE ROLE IF NOT EXISTS. Roles are cluster-wide, so a second database on the
  -- same cluster applying this migration must find the role rather than fail on it.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'playbook_engine') THEN
    CREATE ROLE playbook_engine NOLOGIN;
  END IF;
END
$$;

-- The schema stays owned by the migration role rather than being handed to the engine. Ownership
-- is not needed for the engine to create its own tables — USAGE and CREATE are — and withholding it
-- means the engine cannot drop the schema Apex made for it. Tables the engine creates inside are
-- still owned by the engine role, which is what the drop-safety and grant checks are about.
GRANT USAGE, CREATE ON SCHEMA playbook_engine TO playbook_engine;

-- Nobody else reads the engine's store directly; the wrapper is the only sanctioned path, and this
-- makes that a privilege rather than a convention.
REVOKE ALL ON SCHEMA playbook_engine FROM PUBLIC;

-- Explicitly deny the engine role everything in Apex's own schema. Postgres 15+ already removed the
-- implicit PUBLIC CREATE grant on `public`, but stating it means the guarantee does not depend on
-- which server version an environment happens to run.
REVOKE ALL ON SCHEMA public FROM playbook_engine;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM playbook_engine;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM playbook_engine;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM playbook_engine;

-- A stray unqualified CREATE TABLE cannot land in `public` if `public` is not on the search path.
ALTER ROLE playbook_engine SET search_path = playbook_engine;

-- Down Migration

DROP SCHEMA IF EXISTS playbook_engine CASCADE;

-- Dropping the schema takes the engine's tables and every grant on it with it, so by this point the
-- role holds nothing in this database. DROP OWNED BY would be the thorough way to confirm that, but
-- it requires membership of the role rather than merely admin over it, which a CREATEROLE migration
-- runner does not have.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'playbook_engine') THEN
    BEGIN
      DROP ROLE playbook_engine;
    EXCEPTION
      WHEN dependent_objects_still_exist THEN
        -- Another database on this cluster still has engine objects or grants. Leaving the role is
        -- correct: dropping it would orphan them.
        RAISE NOTICE 'Role playbook_engine is still in use elsewhere on this cluster; left in place.';
      WHEN insufficient_privilege THEN
        RAISE NOTICE 'Migration role may not drop playbook_engine; left in place.';
    END;
  END IF;
END
$$;
