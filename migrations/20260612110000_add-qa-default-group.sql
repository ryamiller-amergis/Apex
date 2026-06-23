-- Up Migration
INSERT INTO app_groups (name, description, project, is_default)
SELECT 'QA', 'Quality assurance and test case review', p.project, true
FROM project_skill_settings p
ON CONFLICT DO NOTHING;

-- Down Migration
DELETE FROM app_groups WHERE is_default = true AND name = 'QA';
