-- Restore FEAT-002 to Ready for the affected Apex My Work user.
-- The row is a synthetic completion (no cloud thread or branch). Match every
-- identity field so this repair cannot alter another developer or feature.
DELETE FROM dev_sessions
WHERE id = 'dfa31e70-0e7d-4786-9635-b4c3f12543d2'
  AND prd_id = '94038473-eb3d-4ef5-9578-1287814a7793'
  AND feature_id = 'FEAT-002'
  AND project = 'Apex'
  AND author_id = '110b196f-3f0d-4890-969f-5571085039de'
  AND status = 'completed'
  AND chat_thread_id IS NULL
  AND branch_name IS NULL;
