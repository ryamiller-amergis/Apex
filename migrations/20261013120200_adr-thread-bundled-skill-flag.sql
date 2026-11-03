-- Up Migration
-- ADR assistant and finalize threads created before skillPathIsAppDefault existed
-- cannot fall back to Apex's bundled skill when the project repo lacks it.
-- The fallback runs only after the project read fails, so flagging a thread
-- whose project does carry the skill changes nothing.
UPDATE chat_threads
SET kickoff = kickoff || '{"skillPathIsAppDefault": true}'::jsonb
WHERE NOT (kickoff ? 'skillPathIsAppDefault')
  AND (
    lower(kickoff->>'skillPath') LIKE '%/adr-assistant/skill.md'
    OR lower(kickoff->>'skillPath') LIKE '%/adr-finalize/skill.md'
  );

-- Down Migration
UPDATE chat_threads
SET kickoff = kickoff - 'skillPathIsAppDefault'
WHERE kickoff->>'skillPathIsAppDefault' = 'true'
  AND (
    lower(kickoff->>'skillPath') LIKE '%/adr-assistant/skill.md'
    OR lower(kickoff->>'skillPath') LIKE '%/adr-finalize/skill.md'
  );
