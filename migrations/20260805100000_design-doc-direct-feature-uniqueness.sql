-- Enforce one direct-from-PRD design document per PRD feature.
-- Keep the most advanced/recent document if historical generation races
-- already created duplicates, and remove dependent review records first.

CREATE TEMP TABLE duplicate_direct_design_docs ON COMMIT DROP AS
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY prd_id, feature_index
      ORDER BY
        CASE status
          WHEN 'approved' THEN 8
          WHEN 'reviewer_approved' THEN 7
          WHEN 'pending_review' THEN 6
          WHEN 'revision_requested' THEN 5
          WHEN 'draft' THEN 4
          WHEN 'validating' THEN 3
          WHEN 'generating' THEN 2
          WHEN 'generation_failed' THEN 1
          ELSE 0
        END DESC,
        updated_at DESC,
        created_at DESC,
        id DESC
    ) AS duplicate_rank
  FROM design_docs
  WHERE design_prototype_id IS NULL
    AND feature_index IS NOT NULL
)
SELECT id
FROM ranked
WHERE duplicate_rank > 1;

DELETE FROM document_approver_assignments
WHERE document_type = 'design_doc'
  AND document_id IN (SELECT id FROM duplicate_direct_design_docs);

DELETE FROM review_comments
WHERE document_type = 'design_doc'
  AND document_id IN (SELECT id FROM duplicate_direct_design_docs);

DELETE FROM design_docs
WHERE id IN (SELECT id FROM duplicate_direct_design_docs);

CREATE UNIQUE INDEX IF NOT EXISTS uq_design_docs_prd_direct_feature
  ON design_docs (prd_id, feature_index)
  WHERE design_prototype_id IS NULL
    AND feature_index IS NOT NULL;
