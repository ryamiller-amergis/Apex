-- ── UI Lab: main design sessions ─────────────────────────────────────────────
CREATE TABLE ui_lab_designs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT NOT NULL,
  author_id TEXT NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  target_route TEXT,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'generating',
  html TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  history JSONB NOT NULL DEFAULT '[]',
  generation_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ui_lab_designs_project ON ui_lab_designs (project, created_at DESC);
CREATE INDEX idx_ui_lab_designs_author ON ui_lab_designs (author_id);
CREATE INDEX idx_ui_lab_designs_status ON ui_lab_designs (status);

-- ── UI Lab: comments with canvas pins ────────────────────────────────────────
CREATE TABLE ui_lab_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  design_id UUID NOT NULL REFERENCES ui_lab_designs(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  text TEXT NOT NULL,
  pin_x REAL,
  pin_y REAL,
  version INTEGER NOT NULL,
  resolved BOOLEAN NOT NULL DEFAULT false,
  resolved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ui_lab_comments_design ON ui_lab_comments (design_id, created_at);

-- ── RBAC: ui-lab permissions ──────────────────────────────────────────────────
INSERT INTO app_permissions (key, description, category)
VALUES
  ('ui-lab:view',   'View UI Lab designs and comments',           'ui-lab'),
  ('ui-lab:manage', 'Create, edit, and delete UI Lab designs',    'ui-lab')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r
CROSS JOIN app_permissions p
WHERE r.name IN ('admin', 'member')
  AND p.key IN ('ui-lab:view', 'ui-lab:manage')
ON CONFLICT DO NOTHING;
