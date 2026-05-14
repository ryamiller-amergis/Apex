-- Up Migration

CREATE TABLE app_users (
  oid          TEXT        PRIMARY KEY,
  display_name TEXT,
  email        TEXT,
  last_seen_at TIMESTAMPTZ
);

CREATE TABLE app_roles (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT        UNIQUE NOT NULL,
  description  TEXT,
  is_default   BOOLEAN     NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE app_permissions (
  id           UUID   PRIMARY KEY DEFAULT gen_random_uuid(),
  key          TEXT   UNIQUE NOT NULL,
  description  TEXT,
  category     TEXT
);

CREATE TABLE app_role_permissions (
  role_id       UUID  NOT NULL REFERENCES app_roles(id) ON DELETE CASCADE,
  permission_id UUID  NOT NULL REFERENCES app_permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE INDEX idx_app_role_permissions_role ON app_role_permissions (role_id);

CREATE TABLE app_user_roles (
  user_id     TEXT        NOT NULL REFERENCES app_users(oid) ON DELETE CASCADE,
  role_id     UUID        NOT NULL REFERENCES app_roles(id) ON DELETE CASCADE,
  assigned_by TEXT,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX idx_app_user_roles_user ON app_user_roles (user_id);

-- Seed roles
INSERT INTO app_roles (name, description, is_default) VALUES
  ('admin',  'Full administrative access', false),
  ('member', 'Standard member access',     true),
  ('viewer', 'Read-only access',           false);

-- Seed permissions
INSERT INTO app_permissions (key, description, category) VALUES
  ('admin:roles',        'Manage roles and permissions',    'admin'),
  ('admin:users',        'Manage user role assignments',    'admin'),
  ('chat:create',        'Create new chat threads',         'chat'),
  ('chat:view_all',      'View all users'' chat threads',   'chat'),
  ('deployments:create', 'Create deployments',              'deployments'),
  ('deployments:manage', 'Manage existing deployments',     'deployments'),
  ('workitems:write',    'Create and edit work items',      'workitems'),
  ('wiki:write',         'Create and edit wiki pages',      'wiki'),
  ('skills:manage',      'Manage agent skills',             'skills'),
  ('cost:view',          'View cost and usage data',        'cost');

-- Seed role-permission assignments: admin gets all permissions
INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name = 'admin';

-- Seed role-permission assignments: member
INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name = 'member'
  AND p.key IN ('chat:create', 'deployments:create', 'workitems:write', 'wiki:write');

-- Seed role-permission assignments: viewer
INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name = 'viewer'
  AND p.key IN ('chat:view_all', 'cost:view');

-- Down Migration

DROP TABLE IF EXISTS app_user_roles;
DROP TABLE IF EXISTS app_role_permissions;
DROP TABLE IF EXISTS app_permissions;
DROP TABLE IF EXISTS app_roles;
DROP TABLE IF EXISTS app_users;
