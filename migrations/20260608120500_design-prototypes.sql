CREATE TABLE design_prototypes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prd_id UUID NOT NULL REFERENCES prds(id) ON DELETE CASCADE,
  feature_name TEXT NOT NULL,
  feature_index INTEGER NOT NULL,
  author_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'generating',
  mock_html TEXT,
  mock_version INTEGER NOT NULL DEFAULT 1,
  history JSONB NOT NULL DEFAULT '[]',
  reviewer_id TEXT,
  review_comment TEXT,
  reviewed_at TIMESTAMPTZ,
  generation_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_design_prototypes_prd_feature ON design_prototypes (prd_id, feature_index);
CREATE INDEX idx_design_prototypes_status ON design_prototypes (status);

CREATE TABLE design_prototype_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prototype_id UUID NOT NULL REFERENCES design_prototypes(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  text TEXT NOT NULL,
  pin_x REAL,
  pin_y REAL,
  mock_version INTEGER NOT NULL,
  resolved BOOLEAN NOT NULL DEFAULT false,
  resolved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_design_prototype_comments_prototype ON design_prototype_comments (prototype_id, created_at);

-- Seed RBAC permission for design prototype review
INSERT INTO app_permissions (key, description, category)
VALUES ('design-prototypes:review', 'Approve or reject design prototypes', 'design-prototypes')
ON CONFLICT (key) DO NOTHING;

-- Assign to admin and member roles
INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r
CROSS JOIN app_permissions p
WHERE r.name IN ('admin', 'member')
  AND p.key = 'design-prototypes:review'
ON CONFLICT DO NOTHING;
