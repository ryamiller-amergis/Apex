-- Up Migration: hand two design docs to Ryan Miller so he can start development
-- from his own account.
--
--   3dbe8b48-1010-44fb-99db-cb0a0e147ac7
--   fcf55a99-8597-4032-b768-788e4ec4670b
--
-- Design doc ownership lives on interviews.design_doc_owner_id and is resolved
-- through prds.interview_id (designDocService computes
-- effectiveOwnerId = designDocOwnerId ?? authorId). There is no API or admin UI
-- to change it after interview kickoff, so it has to move here.
--
-- That column is interview-scoped: every design doc under the same interview
-- shares one owner, so reassigning it also moves any sibling docs under the same
-- interviews. That is the approved intent.
--
-- The NOTICE output below names every doc in scope, but node-pg-migrate does not
-- forward server notices to stdout, so none of it reaches a deploy log. Treat the
-- notices as help when running this by hand through psql or
-- apply-named-migration.js; to confirm what actually moved, run the verification
-- query in the pull request description afterwards.
--
-- design_docs.author_id moves too, for the two named docs only. author_id is a
-- second permission path in assertAuthorOrOwnerOrAdmin, so leaving it behind
-- would keep the previous owner's edit, submit, and delete rights alive.
--
-- document_owner_approvals is deliberately left alone. Rows there record who
-- approved and when, and isDocumentOwner reads the interview rather than that
-- table, so a stale pointer grants nobody anything. Rewriting it would
-- misattribute a past approval.
--
-- design_docs.updated_at is left alone as well: no document content changed, and
-- the UI surfaces that column as "last updated".
--
-- Forward-only: apply-named-migration.js executes the whole file, so the Down
-- section is a comment-only no-op.
--
-- Databases without these design docs (local, CI, cloud dev) skip with a NOTICE
-- instead of aborting, so this one-off data fix does not block the migration
-- queue there.

DO $$
DECLARE
  v_doc_ids CONSTANT uuid[] := ARRAY[
    '3dbe8b48-1010-44fb-99db-cb0a0e147ac7'::uuid,
    'fcf55a99-8597-4032-b768-788e4ec4670b'::uuid
  ];
  v_found integer;
  v_candidates text[];
  v_new_owner_oid text;
  v_owner_label text;
  v_interview_ids uuid[];
  v_updated integer;
  v_approvals integer;
  r RECORD;
BEGIN
  SELECT count(*) INTO v_found FROM design_docs WHERE id = ANY(v_doc_ids);

  IF v_found = 0 THEN
    RAISE NOTICE 'SKIPPED: neither design doc exists in this database';
    RETURN;
  END IF;

  IF v_found <> array_length(v_doc_ids, 1) THEN
    RAISE EXCEPTION 'Expected % design docs but found % - refusing a partial handover',
      array_length(v_doc_ids, 1), v_found;
  END IF;

  -- Require exactly one distinct match so a near-miss, or a second Ryan Miller,
  -- aborts instead of silently reassigning to the wrong person. The OID is the
  -- one recorded in 20260901190425_c834_reassign-cloud-dev-design-doc-owner.sql.
  SELECT array_agg(DISTINCT oid) INTO v_candidates
  FROM app_users
  WHERE oid = '110b196f-3f0d-4890-969f-5571085039de'
     OR email ILIKE 'ryamiller@%'
     OR display_name ILIKE '%ryan%miller%';

  IF v_candidates IS NULL THEN
    RAISE EXCEPTION 'No app_users row matches Ryan Miller - cannot reassign';
  END IF;

  IF array_length(v_candidates, 1) > 1 THEN
    RAISE EXCEPTION 'Ryan Miller lookup is ambiguous (% candidates: %)',
      array_length(v_candidates, 1), v_candidates;
  END IF;

  v_new_owner_oid := v_candidates[1];

  SELECT format('%s <%s> oid=%s',
                coalesce(display_name, '(no name)'),
                coalesce(email, '(no email)'),
                oid)
    INTO v_owner_label
  FROM app_users
  WHERE oid = v_new_owner_oid;

  RAISE NOTICE 'New design doc owner: %', v_owner_label;

  SELECT array_agg(DISTINCT p.interview_id) INTO v_interview_ids
  FROM design_docs dd
  JOIN prds p ON p.id = dd.prd_id
  WHERE dd.id = ANY(v_doc_ids)
    AND p.interview_id IS NOT NULL;

  IF v_interview_ids IS NULL THEN
    RAISE NOTICE 'No interview backs these docs; ownership falls back to design_docs.author_id';
  ELSE
    FOR r IN
      SELECT i.id,
             i.title,
             coalesce(u.display_name, '(unset)') AS prev_owner,
             coalesce(i.design_doc_owner_id, '(null)') AS prev_oid
      FROM interviews i
      LEFT JOIN app_users u ON u.oid = i.design_doc_owner_id
      WHERE i.id = ANY(v_interview_ids)
    LOOP
      RAISE NOTICE 'interview % (%) previous owner: % [%]',
        r.id, r.title, r.prev_owner, r.prev_oid;
    END LOOP;

    FOR r IN
      SELECT p.interview_id,
             dd.id AS doc_id,
             dd.title,
             dd.status,
             (dd.id = ANY(v_doc_ids)) AS named,
             coalesce(au.display_name, '(unknown)') AS author_name
      FROM design_docs dd
      JOIN prds p ON p.id = dd.prd_id
      LEFT JOIN app_users au ON au.oid = dd.author_id
      WHERE p.interview_id = ANY(v_interview_ids)
      ORDER BY p.interview_id, dd.created_at
    LOOP
      RAISE NOTICE 'in scope: interview=% doc=% named=% status=% author=% title=%',
        r.interview_id, r.doc_id, r.named, r.status, r.author_name, r.title;
    END LOOP;

    UPDATE interviews
    SET design_doc_owner_id = v_new_owner_oid
    WHERE id = ANY(v_interview_ids)
      AND design_doc_owner_id IS DISTINCT FROM v_new_owner_oid;

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RAISE NOTICE 'interviews.design_doc_owner_id rows updated: %', v_updated;
  END IF;

  UPDATE design_docs
  SET author_id = v_new_owner_oid
  WHERE id = ANY(v_doc_ids)
    AND author_id IS DISTINCT FROM v_new_owner_oid;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE 'design_docs.author_id rows updated: %', v_updated;

  SELECT count(*) INTO v_approvals
  FROM document_owner_approvals
  WHERE document_type = 'design_doc'
    AND document_id = ANY(v_doc_ids);

  IF v_approvals > 0 THEN
    RAISE NOTICE 'document_owner_approvals rows left untouched as historical record: %', v_approvals;
  END IF;
END $$;

-- Down Migration
-- No-op. To restore the previous owner, author a new forward migration using the
-- OIDs printed by this migration's NOTICE output.
