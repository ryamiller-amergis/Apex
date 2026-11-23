-- Up Migration
-- The interactive-agent step type is gone. An Agent task (cursor-agent) chats with an assignee when
-- its Skill declares skill-type: interactive. Rows and graphs saved under the old type move to the
-- new one. The config shape is a subset of the new one, so nothing else changes.

UPDATE playbook_definition_versions v
SET graph = jsonb_set(
  v.graph,
  '{nodes}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN n.node->>'stepType' = 'interactive-agent'
          THEN jsonb_set(n.node, '{stepType}', '"cursor-agent"')
        ELSE n.node
      END
      ORDER BY n.position
    )
    FROM jsonb_array_elements(v.graph->'nodes') WITH ORDINALITY AS n(node, position)
  )
)
WHERE jsonb_typeof(v.graph->'nodes') = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v.graph->'nodes') AS e(node)
    WHERE e.node->>'stepType' = 'interactive-agent'
  );

UPDATE playbook_step_runs
SET step_type = 'cursor-agent'
WHERE step_type = 'interactive-agent';

-- Down Migration
-- Not reversible. After the Up Migration an interactive step and an autonomous step share one type,
-- so there is no record of which rows to change back.
SELECT 1;
