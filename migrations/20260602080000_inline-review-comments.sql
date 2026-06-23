-- Up Migration
CREATE TABLE review_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL,
  document_type TEXT NOT NULL,
  section_key TEXT NOT NULL,
  author_user_id TEXT NOT NULL REFERENCES app_users(oid) ON DELETE CASCADE,
  body TEXT NOT NULL,
  selector_exact TEXT NOT NULL,
  selector_prefix TEXT NOT NULL DEFAULT '',
  selector_suffix TEXT NOT NULL DEFAULT '',
  selector_start INTEGER NOT NULL,
  selector_end INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, document_type, section_key, selector_exact, selector_start, author_user_id)
);

CREATE INDEX idx_review_comments_doc_status
  ON review_comments (document_id, document_type, status);

CREATE TABLE review_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id UUID NOT NULL REFERENCES review_comments(id) ON DELETE CASCADE,
  author_user_id TEXT NOT NULL REFERENCES app_users(oid) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_review_replies_comment_created
  ON review_replies (comment_id, created_at ASC);

-- Down Migration
DROP TABLE IF EXISTS review_replies;
DROP TABLE IF EXISTS review_comments;
