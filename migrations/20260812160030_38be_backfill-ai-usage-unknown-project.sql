-- Backfill ai_usage_events.project when it was incorrectly stored as 'unknown'.
-- Resolves project from entity/thread/run links first, then feature-specific
-- time proximity for design-prototype / design-plan generations that never
-- recorded entity_id (pre-attribution-fix callers).

-- Up Migration

-- 1) entity_type = design_prototype → PRD project
UPDATE ai_usage_events AS u
SET project = p.project
FROM design_prototypes AS dp
JOIN prds AS p ON p.id = dp.prd_id
WHERE lower(u.project) = 'unknown'
  AND u.entity_type = 'design_prototype'
  AND u.entity_id IS NOT NULL
  AND u.entity_id = dp.id::text
  AND nullif(btrim(p.project), '') IS NOT NULL
  AND lower(btrim(p.project)) <> 'unknown';

-- 2) entity_type = prd → PRD project
UPDATE ai_usage_events AS u
SET project = p.project
FROM prds AS p
WHERE lower(u.project) = 'unknown'
  AND u.entity_type = 'prd'
  AND u.entity_id IS NOT NULL
  AND u.entity_id = p.id::text
  AND nullif(btrim(p.project), '') IS NOT NULL
  AND lower(btrim(p.project)) <> 'unknown';

-- 3) entity_type = design_doc → design doc project
UPDATE ai_usage_events AS u
SET project = d.project
FROM design_docs AS d
WHERE lower(u.project) = 'unknown'
  AND u.entity_type = 'design_doc'
  AND u.entity_id IS NOT NULL
  AND u.entity_id = d.id::text
  AND nullif(btrim(d.project), '') IS NOT NULL
  AND lower(btrim(d.project)) <> 'unknown';

-- 4) entity_type = adr → ADR project
UPDATE ai_usage_events AS u
SET project = a.project
FROM adrs AS a
WHERE lower(u.project) = 'unknown'
  AND u.entity_type = 'adr'
  AND u.entity_id IS NOT NULL
  AND u.entity_id = a.id::text
  AND nullif(btrim(a.project), '') IS NOT NULL
  AND lower(btrim(a.project)) <> 'unknown';

-- 5) chat thread kickoff.project
UPDATE ai_usage_events AS u
SET project = btrim(ct.kickoff->>'project')
FROM chat_threads AS ct
WHERE lower(u.project) = 'unknown'
  AND u.thread_id IS NOT NULL
  AND u.thread_id = ct.id::text
  AND nullif(btrim(ct.kickoff->>'project'), '') IS NOT NULL
  AND lower(btrim(ct.kickoff->>'project')) <> 'unknown';

-- 6) agent run project_id
UPDATE ai_usage_events AS u
SET project = btrim(ar.project_id)
FROM agent_runs AS ar
WHERE lower(u.project) = 'unknown'
  AND u.run_id IS NOT NULL
  AND u.run_id = ar.id
  AND nullif(btrim(ar.project_id), '') IS NOT NULL
  AND lower(btrim(ar.project_id)) <> 'unknown';

-- 7) design-prototype generations without entity_id: closest prototype update
--    within a 20-minute window (generation can lag a few minutes from the usage row).
UPDATE ai_usage_events AS u
SET project = resolved.project
FROM (
  SELECT DISTINCT ON (u2.id)
    u2.id AS usage_id,
    btrim(p.project) AS project
  FROM ai_usage_events AS u2
  JOIN design_prototypes AS dp
    ON dp.updated_at BETWEEN (u2.created_at - INTERVAL '15 minutes')
                        AND (u2.created_at + INTERVAL '5 minutes')
  JOIN prds AS p ON p.id = dp.prd_id
  WHERE lower(u2.project) = 'unknown'
    AND u2.feature = 'design-prototype'
    AND nullif(btrim(p.project), '') IS NOT NULL
    AND lower(btrim(p.project)) <> 'unknown'
  ORDER BY
    u2.id,
    abs(extract(epoch FROM (dp.updated_at - u2.created_at))) ASC,
    dp.updated_at DESC
) AS resolved
WHERE u.id = resolved.usage_id
  AND lower(u.project) = 'unknown';

-- 8) design-plan generations without entity_id: closest plan update window
UPDATE ai_usage_events AS u
SET project = resolved.project
FROM (
  SELECT DISTINCT ON (u2.id)
    u2.id AS usage_id,
    btrim(p.project) AS project
  FROM ai_usage_events AS u2
  JOIN design_plans AS dp
    ON dp.updated_at BETWEEN (u2.created_at - INTERVAL '15 minutes')
                        AND (u2.created_at + INTERVAL '5 minutes')
  JOIN prds AS p ON p.id = dp.prd_id
  WHERE lower(u2.project) = 'unknown'
    AND u2.feature = 'design-plan'
    AND nullif(btrim(p.project), '') IS NOT NULL
    AND lower(btrim(p.project)) <> 'unknown'
  ORDER BY
    u2.id,
    abs(extract(epoch FROM (dp.updated_at - u2.created_at))) ASC,
    dp.updated_at DESC
) AS resolved
WHERE u.id = resolved.usage_id
  AND lower(u.project) = 'unknown';

-- 9) prd-review / design-doc without entity: closest PRD / design-doc activity
UPDATE ai_usage_events AS u
SET project = resolved.project
FROM (
  SELECT DISTINCT ON (u2.id)
    u2.id AS usage_id,
    btrim(p.project) AS project
  FROM ai_usage_events AS u2
  JOIN prds AS p
    ON p.updated_at BETWEEN (u2.created_at - INTERVAL '15 minutes')
                       AND (u2.created_at + INTERVAL '5 minutes')
  WHERE lower(u2.project) = 'unknown'
    AND u2.feature IN ('prd-review', 'prd')
    AND nullif(btrim(p.project), '') IS NOT NULL
    AND lower(btrim(p.project)) <> 'unknown'
  ORDER BY
    u2.id,
    abs(extract(epoch FROM (p.updated_at - u2.created_at))) ASC,
    p.updated_at DESC
) AS resolved
WHERE u.id = resolved.usage_id
  AND lower(u.project) = 'unknown';

UPDATE ai_usage_events AS u
SET project = resolved.project
FROM (
  SELECT DISTINCT ON (u2.id)
    u2.id AS usage_id,
    btrim(d.project) AS project
  FROM ai_usage_events AS u2
  JOIN design_docs AS d
    ON d.updated_at BETWEEN (u2.created_at - INTERVAL '15 minutes')
                       AND (u2.created_at + INTERVAL '5 minutes')
  WHERE lower(u2.project) = 'unknown'
    AND u2.feature IN ('design-doc', 'design-doc-validation')
    AND nullif(btrim(d.project), '') IS NOT NULL
    AND lower(btrim(d.project)) <> 'unknown'
  ORDER BY
    u2.id,
    abs(extract(epoch FROM (d.updated_at - u2.created_at))) ASC,
    d.updated_at DESC
) AS resolved
WHERE u.id = resolved.usage_id
  AND lower(u.project) = 'unknown';

-- 10) ui-lab without project: prefer the user's most common non-unknown project
UPDATE ai_usage_events AS u
SET project = resolved.project
FROM (
  SELECT DISTINCT ON (u2.id)
    u2.id AS usage_id,
    btrim(pref.project) AS project
  FROM ai_usage_events AS u2
  JOIN LATERAL (
    SELECT o.project, COUNT(*) AS cnt
    FROM ai_usage_events AS o
    WHERE o.user_id = u2.user_id
      AND nullif(btrim(o.project), '') IS NOT NULL
      AND lower(btrim(o.project)) <> 'unknown'
    GROUP BY o.project
    ORDER BY COUNT(*) DESC, o.project ASC
    LIMIT 1
  ) AS pref ON TRUE
  WHERE lower(u2.project) = 'unknown'
    AND u2.feature = 'ui-lab'
    AND u2.user_id IS NOT NULL
) AS resolved
WHERE u.id = resolved.usage_id
  AND lower(u.project) = 'unknown';

-- Down Migration
-- Intentionally irreversible: restoring 'unknown' would undo correct attribution.
SELECT 1;