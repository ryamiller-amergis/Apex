-- Up Migration
-- A skill file may be any text file, not only Markdown, and may be up to 1 MB.

ALTER TABLE project_playbook_skill_files
  DROP CONSTRAINT IF EXISTS project_playbook_skill_files_name_check;

ALTER TABLE project_playbook_skill_files
  ADD CONSTRAINT project_playbook_skill_files_name_check CHECK (
    file_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.[A-Za-z0-9]{1,16}$' AND upper(file_name) <> 'SKILL.MD'
  );

ALTER TABLE project_playbook_skill_files
  DROP CONSTRAINT IF EXISTS project_playbook_skill_files_size_check;

ALTER TABLE project_playbook_skill_files
  ADD CONSTRAINT project_playbook_skill_files_size_check CHECK (octet_length(content) <= 1000000);

-- Down Migration
-- Rolling back deletes attached files that only fit the wider rules, because the narrower checks
-- would reject them.

DELETE FROM project_playbook_skill_files
WHERE file_name !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.md$'
   OR octet_length(content) > 200000;

ALTER TABLE project_playbook_skill_files
  DROP CONSTRAINT IF EXISTS project_playbook_skill_files_size_check;

ALTER TABLE project_playbook_skill_files
  ADD CONSTRAINT project_playbook_skill_files_size_check CHECK (octet_length(content) <= 200000);

ALTER TABLE project_playbook_skill_files
  DROP CONSTRAINT IF EXISTS project_playbook_skill_files_name_check;

ALTER TABLE project_playbook_skill_files
  ADD CONSTRAINT project_playbook_skill_files_name_check CHECK (
    file_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.md$' AND file_name <> 'SKILL.md'
  );
