-- RFP intake: archived status for a project removed by a platform admin.
-- The request stays in Product Requests. The project name is hidden from project selection.

-- Up Migration

ALTER TABLE rfp_requests DROP CONSTRAINT IF EXISTS rfp_requests_status_check;
ALTER TABLE rfp_requests ADD CONSTRAINT rfp_requests_status_check CHECK (
  status IN ('submitted', 'evaluating', 'evaluated', 'in-review', 'accepted', 'declined', 'on-hold', 'archived')
);

-- Down Migration

ALTER TABLE rfp_requests DROP CONSTRAINT IF EXISTS rfp_requests_status_check;
ALTER TABLE rfp_requests ADD CONSTRAINT rfp_requests_status_check CHECK (
  status IN ('submitted', 'evaluating', 'evaluated', 'in-review', 'accepted', 'declined', 'on-hold')
);
