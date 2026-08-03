-- Up Migration
-- Platform Admin → Walkthroughs → Options: persisted skill + agent model per AI process

CREATE TABLE walkthrough_ai_options (
  id                                    TEXT PRIMARY KEY DEFAULT 'default',
  walkthrough_generation_skill_path     TEXT NOT NULL
    DEFAULT '.cursor/skills/walkthrough-generation/SKILL.md',
  walkthrough_generation_model          TEXT NOT NULL DEFAULT '',
  anchor_smart_tagging_skill_path       TEXT NOT NULL
    DEFAULT '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md',
  anchor_smart_tagging_model            TEXT NOT NULL DEFAULT '',
  created_by                            TEXT NOT NULL,
  created_by_display_name               TEXT NOT NULL,
  created_at                            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by                            TEXT NOT NULL,
  updated_by_display_name               TEXT NOT NULL,
  updated_at                            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_walkthrough_ai_options_singleton
    CHECK (id = 'default'),
  CONSTRAINT chk_walkthrough_ai_options_generation_skill_path
    CHECK (walkthrough_generation_skill_path ~ '^\.cursor/skills/[^/]+/SKILL\.md$'),
  CONSTRAINT chk_walkthrough_ai_options_smart_tagging_skill_path
    CHECK (anchor_smart_tagging_skill_path ~ '^\.cursor/skills/[^/]+/SKILL\.md$')
);

INSERT INTO walkthrough_ai_options (
  id,
  created_by,
  created_by_display_name,
  updated_by,
  updated_by_display_name
) VALUES (
  'default',
  'system',
  'System',
  'system',
  'System'
)
ON CONFLICT (id) DO NOTHING;

-- Down Migration
DROP TABLE IF EXISTS walkthrough_ai_options;
