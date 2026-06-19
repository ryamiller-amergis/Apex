-- Per-route page screenshots for design prototype generation.
-- Stored by normalized route so they are reusable across PRDs.
-- When a reviewer uploads a screenshot of an existing MaxView page,
-- it is sent as a vision input to Bedrock so the prototype skeleton
-- matches the real page layout.

CREATE TABLE page_screenshots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route         TEXT NOT NULL UNIQUE,
  display_url   TEXT,
  image_base64  TEXT NOT NULL,
  media_type    TEXT NOT NULL DEFAULT 'image/png',
  width         INTEGER,
  height        INTEGER,
  uploaded_by   TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
