-- Up Migration: API key scopes for public endpoint allow-lists
-- Admins select view/submit capabilities at create/edit time (no manage scopes).

ALTER TABLE api_keys
  ADD COLUMN scopes TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN api_keys.scopes IS
  'Public API capability allow-list (e.g. flags:evaluate, feature-requests:submit). Empty = auth-only (ping).';

-- Down Migration
-- ALTER TABLE api_keys DROP COLUMN IF EXISTS scopes;
