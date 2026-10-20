-- Up Migration

-- A learning step can store selected AI outcomes without a human review.
-- Item-level feedback can also be kept as needs_changes rather than a yes or no.

ALTER TABLE playbook_outcome_feedback
  ALTER COLUMN review_step_run_id DROP NOT NULL;

ALTER TABLE playbook_outcome_feedback
  DROP CONSTRAINT IF EXISTS playbook_outcome_feedback_decision_check;

ALTER TABLE playbook_outcome_feedback
  ADD CONSTRAINT playbook_outcome_feedback_decision_check
  CHECK (decision IN ('approved', 'rejected', 'needs_changes', 'recorded'));

-- Down Migration

ALTER TABLE playbook_outcome_feedback
  DROP CONSTRAINT IF EXISTS playbook_outcome_feedback_decision_check;

ALTER TABLE playbook_outcome_feedback
  ADD CONSTRAINT playbook_outcome_feedback_decision_check
  CHECK (decision IN ('approved', 'rejected'));

ALTER TABLE playbook_outcome_feedback
  ALTER COLUMN review_step_run_id SET NOT NULL;
