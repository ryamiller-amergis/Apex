-- Up Migration
-- Smart Anchor Management Phase 1: durable walkthrough_anchor_registry catalog

CREATE TABLE walkthrough_anchor_registry (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_key          TEXT NOT NULL,
  test_id             TEXT NOT NULL,
  label               TEXT NOT NULL,
  suggested_route     TEXT,
  approved_route      TEXT,
  allowed_placements  JSONB NOT NULL DEFAULT '["bottom"]'::jsonb,
  smart_tags          JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_kind         TEXT NOT NULL,
  source_locations    JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_hash         TEXT,
  review_status       TEXT NOT NULL DEFAULT 'pending',
  is_active           BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at        TIMESTAMPTZ,
  missing_since       TIMESTAMPTZ,
  deleted_at          TIMESTAMPTZ,
  ai_provenance       JSONB,
  created_by          TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by          TEXT NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_walkthrough_anchor_registry_review_status
    CHECK (review_status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT chk_walkthrough_anchor_registry_source_kind
    CHECK (source_kind IN ('explicit', 'data_testid', 'manual')),
  CONSTRAINT chk_walkthrough_anchor_registry_allowed_placements_array
    CHECK (jsonb_typeof(allowed_placements) = 'array'),
  CONSTRAINT chk_walkthrough_anchor_registry_smart_tags_array
    CHECK (jsonb_typeof(smart_tags) = 'array'),
  CONSTRAINT chk_walkthrough_anchor_registry_source_locations_array
    CHECK (jsonb_typeof(source_locations) = 'array'),
  CONSTRAINT chk_walkthrough_anchor_registry_active_requires_approved
    CHECK (NOT is_active OR review_status = 'approved')
);

-- Soft-delete aware uniqueness: live rows keep unique keys/test IDs
CREATE UNIQUE INDEX uq_walkthrough_anchor_registry_anchor_key
  ON walkthrough_anchor_registry (anchor_key)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX uq_walkthrough_anchor_registry_test_id
  ON walkthrough_anchor_registry (test_id)
  WHERE deleted_at IS NULL;

-- Tag containment queries (smart_tags @> '["profile"]')
CREATE INDEX idx_walkthrough_anchor_registry_smart_tags
  ON walkthrough_anchor_registry USING GIN (smart_tags);

-- Runtime / admin list filters
CREATE INDEX idx_walkthrough_anchor_registry_active_route_status
  ON walkthrough_anchor_registry (is_active, approved_route, review_status)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_walkthrough_anchor_registry_review_status
  ON walkthrough_anchor_registry (review_status)
  WHERE deleted_at IS NULL;

-- Seed the seven curated REGISTRY_ENTRIES as approved/active with baseline tags
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
  'user-menu-trigger',
  'user-menu-trigger',
  'User menu',
  NULL,
  '/home',
  '["bottom","left","right","top"]'::jsonb,
  '["user-menu","avatar","header","navigation","open","button"]'::jsonb,
  'explicit',
  '[{"filePath":"src/client/components/UserMenu.tsx","discoveryKind":"explicit"}]'::jsonb,
  'baseline:v1:user-menu-trigger',
  'approved',
  TRUE,
  'system',
  'system'
),
(
  'whats-new-modal',
  'whats-new-modal',
  'What''s New modal',
  NULL,
  '/home',
  '["bottom","top","left","right"]'::jsonb,
  '["whats-new","changelog","modal","announcements","home"]'::jsonb,
  'explicit',
  '[{"filePath":"src/client/components/Changelog.tsx","discoveryKind":"explicit"}]'::jsonb,
  'baseline:v1:whats-new-modal',
  'approved',
  TRUE,
  'system',
  'system'
),
(
  'user-menu-profile',
  'user-menu-profile',
  'Profile menu item',
  NULL,
  '/home',
  '["left","right","bottom","top"]'::jsonb,
  '["user-menu","profile","menu-item","navigation","settings"]'::jsonb,
  'explicit',
  '[{"filePath":"src/client/components/UserMenu.tsx","discoveryKind":"explicit"}]'::jsonb,
  'baseline:v1:user-menu-profile',
  'approved',
  TRUE,
  'system',
  'system'
),
(
  'profile-identity',
  'profile-identity-section',
  'Profile — Identity',
  NULL,
  '/profile',
  '["bottom","top"]'::jsonb,
  '["profile","identity","avatar","settings","section"]'::jsonb,
  'explicit',
  '[{"filePath":"src/client/components/ProfilePage.tsx","discoveryKind":"explicit"}]'::jsonb,
  'baseline:v1:profile-identity',
  'approved',
  TRUE,
  'system',
  'system'
),
(
  'profile-bio',
  'profile-bio-section',
  'Profile — Bio',
  NULL,
  '/profile',
  '["bottom","top"]'::jsonb,
  '["profile","bio","settings","section","edit"]'::jsonb,
  'explicit',
  '[{"filePath":"src/client/components/ProfilePage.tsx","discoveryKind":"explicit"}]'::jsonb,
  'baseline:v1:profile-bio',
  'approved',
  TRUE,
  'system',
  'system'
),
(
  'profile-theme',
  'profile-theme-section',
  'Profile — Theme',
  NULL,
  '/profile',
  '["bottom","top"]'::jsonb,
  '["profile","theme","appearance","settings","section"]'::jsonb,
  'explicit',
  '[{"filePath":"src/client/components/ProfilePage.tsx","discoveryKind":"explicit"}]'::jsonb,
  'baseline:v1:profile-theme',
  'approved',
  TRUE,
  'system',
  'system'
),
(
  'profile-notifications',
  'profile-notification-section',
  'Profile — Notifications',
  NULL,
  '/profile',
  '["top","bottom"]'::jsonb,
  '["profile","notifications","preferences","settings","section"]'::jsonb,
  'explicit',
  '[{"filePath":"src/client/components/ProfilePage.tsx","discoveryKind":"explicit"}]'::jsonb,
  'baseline:v1:profile-notifications',
  'approved',
  TRUE,
  'system',
  'system'
);

-- Down Migration
DROP INDEX IF EXISTS idx_walkthrough_anchor_registry_review_status;
DROP INDEX IF EXISTS idx_walkthrough_anchor_registry_active_route_status;
DROP INDEX IF EXISTS idx_walkthrough_anchor_registry_smart_tags;
DROP INDEX IF EXISTS uq_walkthrough_anchor_registry_test_id;
DROP INDEX IF EXISTS uq_walkthrough_anchor_registry_anchor_key;
DROP TABLE IF EXISTS walkthrough_anchor_registry;
