-- Up Migration

ALTER TABLE playbook_step_runs
  ADD COLUMN input_inline jsonb,
  ADD COLUMN gate_pool_key text,
  ADD COLUMN gate_approval_mode text;

ALTER TABLE playbook_step_runs
  ADD CONSTRAINT playbook_step_runs_gate_approval_mode_check
  CHECK (gate_approval_mode IS NULL OR gate_approval_mode IN ('any_one', 'all_required'));

CREATE TABLE playbook_gate_approvers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  step_run_id uuid NOT NULL REFERENCES playbook_step_runs(id) ON DELETE CASCADE,
  approver_user_id text NOT NULL REFERENCES app_users(oid) ON DELETE RESTRICT,
  source_group_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  decision text,
  comment text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_playbook_gate_approvers_step_user UNIQUE (step_run_id, approver_user_id),
  CONSTRAINT playbook_gate_approvers_decision_check
    CHECK (decision IS NULL OR decision IN ('approved', 'rejected')),
  CONSTRAINT playbook_gate_approvers_decision_complete
    CHECK (
      (decision IS NULL AND decided_at IS NULL)
      OR (decision IS NOT NULL AND decided_at IS NOT NULL)
    ),
  CONSTRAINT playbook_gate_approvers_source_groups_array
    CHECK (jsonb_typeof(source_group_ids) = 'array')
);

CREATE INDEX idx_playbook_gate_approvers_user_decision
  ON playbook_gate_approvers (approver_user_id, decision);
CREATE INDEX idx_playbook_gate_approvers_step
  ON playbook_gate_approvers (step_run_id);

-- Down Migration

DROP TABLE playbook_gate_approvers;
ALTER TABLE playbook_step_runs
  DROP CONSTRAINT playbook_step_runs_gate_approval_mode_check,
  DROP COLUMN gate_approval_mode,
  DROP COLUMN gate_pool_key,
  DROP COLUMN input_inline;
