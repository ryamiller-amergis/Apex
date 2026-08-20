-- Up Migration
-- Work Board walkthrough anchors: seed the three curated Work Board catalog
-- entries as approved/active so they are coachable out of the box. These mirror
-- the DOM markers in src/shared/walkthroughAnchors.ts and the baseline seeds in
-- src/shared/types/walkthroughAnchorRegistry.ts.
--
-- Idempotent: ON CONFLICT against the partial unique index (live rows) so
-- re-running or applying after a manual add is a no-op and never duplicates.

INSERT INTO walkthrough_anchor_registry (
  anchor_key,
  test_id,
  label,
  suggested_route,
  approved_route,
  allowed_placements,
  smart_tags,
  source_kind,
  source_locations,
  source_hash,
  review_status,
  is_active,
  created_by,
  updated_by
) VALUES
(
  'work-board-view',
  'work-board-view',
  'Work Board — root view',
  NULL,
  '/work-board',
  '["bottom","top","left","right"]'::jsonb,
  '["work-board","board","root-view","navigation"]'::jsonb,
  'explicit',
  '[{"filePath":"src/client/components/ApexWorkBoardView.tsx","discoveryKind":"explicit"}]'::jsonb,
  'baseline:v1:work-board-view',
  'approved',
  TRUE,
  'system',
  'system'
),
(
  'work-board-lens-toggle',
  'work-board-lens-toggle',
  'Work Board — status / release lens',
  NULL,
  '/work-board',
  '["bottom","top","left","right"]'::jsonb,
  '["work-board","lens","toggle","status","release"]'::jsonb,
  'explicit',
  '[{"filePath":"src/client/components/ApexWorkBoardView.tsx","discoveryKind":"explicit"}]'::jsonb,
  'baseline:v1:work-board-lens-toggle',
  'approved',
  TRUE,
  'system',
  'system'
),
(
  'work-board-backlog-toggle',
  'work-board-backlog-toggle',
  'Work Board — board / backlog toggle',
  NULL,
  '/work-board',
  '["bottom","top","left","right"]'::jsonb,
  '["work-board","backlog","toggle","board-view"]'::jsonb,
  'explicit',
  '[{"filePath":"src/client/components/ApexWorkBoardView.tsx","discoveryKind":"explicit"}]'::jsonb,
  'baseline:v1:work-board-backlog-toggle',
  'approved',
  TRUE,
  'system',
  'system'
)
ON CONFLICT (anchor_key) WHERE deleted_at IS NULL DO NOTHING;

-- Down Migration
DELETE FROM walkthrough_anchor_registry
WHERE anchor_key IN (
  'work-board-view',
  'work-board-lens-toggle',
  'work-board-backlog-toggle'
)
AND source_hash IN (
  'baseline:v1:work-board-view',
  'baseline:v1:work-board-lens-toggle',
  'baseline:v1:work-board-backlog-toggle'
);
