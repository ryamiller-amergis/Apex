-- Phase 1 auto-open: catalog-owned opener anchors for modal/menu/tab reveal.

ALTER TABLE walkthrough_anchor_registry
  ADD COLUMN IF NOT EXISTS opener_anchor_keys JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN walkthrough_anchor_registry.opener_anchor_keys IS
  'Ordered catalog anchor_key list clicked at playback to reveal this target before coachmark resolve.';
