CREATE TABLE design_docs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prd_id UUID NOT NULL REFERENCES prds(id) ON DELETE CASCADE,
  project TEXT NOT NULL,
  chat_thread_id UUID,
  author_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'Untitled Design Doc',
  design_content TEXT NOT NULL DEFAULT '',
  tech_spec_content TEXT NOT NULL DEFAULT '',
  assumptions_content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  reviewer_id TEXT,
  review_comment TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_design_docs_project ON design_docs (project, created_at DESC);
CREATE INDEX idx_design_docs_prd_id ON design_docs (prd_id);
