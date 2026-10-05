-- Up Migration: reassign the design doc owner for the
-- "My Work Cloud Development (Cursor Cloud Agents)" PRD to Montrell Jubilee.
--
-- Design doc ownership lives on interviews.design_doc_owner_id and is resolved
-- through prds.interview_id, so updating the interview reassigns all six design
-- docs under PRD 07329ad8-bc34-4b2d-a161-ef664fa586f5 at once. There is no API
-- or admin UI to change this after interview kickoff.
--
-- Forward-only: apply-named-migration.js runs the whole file, so the Down
-- section is a comment-only no-op.
--
-- The target user and interview exist only in cloud DEV. Local and other
-- environments skip with a NOTICE rather than aborting, so this one-off data fix
-- does not block the rest of the migration queue there.

DO $$
DECLARE
  v_interview_id CONSTANT uuid := 'b5522070-feb6-45f0-962d-6562b5939150';
  v_new_owner_oid CONSTANT text := '08e8378b-b9ef-4e91-8988-4db0124c85a7';
  v_updated integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_users WHERE oid = v_new_owner_oid) THEN
    RAISE NOTICE 'SKIPPED: app_users row % (Montrell Jubilee) not found in this database', v_new_owner_oid;
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM interviews WHERE id = v_interview_id) THEN
    RAISE NOTICE 'SKIPPED: interview % not found in this database', v_interview_id;
    RETURN;
  END IF;

  UPDATE interviews
  SET design_doc_owner_id = v_new_owner_oid
  WHERE id = v_interview_id
    AND design_doc_owner_id IS DISTINCT FROM v_new_owner_oid;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE 'design_doc_owner_id rows updated: %', v_updated;
END $$;

-- Down Migration
-- No-op. To restore the previous owner (Ryan Miller,
-- 110b196f-3f0d-4890-969f-5571085039de), author a new forward migration.
