-- Up Migration

ALTER TABLE design_modules ADD COLUMN project TEXT NOT NULL DEFAULT 'Apex';

ALTER TABLE design_modules DROP CONSTRAINT design_modules_slug_key;

ALTER TABLE design_modules ADD CONSTRAINT design_modules_project_slug_key UNIQUE (project, slug);

CREATE INDEX idx_design_modules_project ON design_modules (project);

-- Down Migration

DROP INDEX IF EXISTS idx_design_modules_project;

ALTER TABLE design_modules DROP CONSTRAINT design_modules_project_slug_key;

ALTER TABLE design_modules ADD CONSTRAINT design_modules_slug_key UNIQUE (slug);

ALTER TABLE design_modules DROP COLUMN project;
