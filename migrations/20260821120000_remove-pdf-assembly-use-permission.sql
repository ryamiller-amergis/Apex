-- Remove the PDF Tools permission now that the workbench lives in DocHub.
-- Historical pdf_sessions / job tables are left in place (orphan data).

-- Up Migration
DELETE FROM app_permissions WHERE key = 'pdf-assembly:use';
-- app_role_permissions rows cascade-delete automatically

-- Down Migration
-- INSERT INTO app_permissions (id, key, description, category) VALUES
--   (gen_random_uuid(), 'pdf-assembly:use', 'Allows access to the PDF Tools assembly workspace', 'pdf-tools');
