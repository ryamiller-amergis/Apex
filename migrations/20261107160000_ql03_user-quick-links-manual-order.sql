-- Up Migration
-- Personal Quick Links now list by sort_order alone, and a category shows where its first link
-- sits, so users can drag categories and links. Renumber existing rows in the order they showed
-- before (category A-Z with uncategorized last, then sort_order, then label) so nothing moves.

UPDATE user_quick_links AS q
SET sort_order = ranked.position
FROM (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, project
      ORDER BY category ASC NULLS LAST, sort_order ASC, label ASC
    ) - 1 AS position
  FROM user_quick_links
) AS ranked
WHERE q.id = ranked.id;

-- Down Migration
-- No-op: the renumbered sort_order values are still valid under the earlier category-first ordering.
