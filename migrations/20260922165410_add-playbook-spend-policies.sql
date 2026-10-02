-- Up Migration

CREATE TABLE playbook_spend_policies (
  project text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  baseline_cost_usd numeric(18, 6) NOT NULL,
  cap_usd numeric(18, 6) NOT NULL,
  warning_active boolean NOT NULL DEFAULT false,
  warning_generation integer NOT NULL DEFAULT 0,
  warning_crossed_at timestamptz,
  warning_recipient_user_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  override_by_user_id text REFERENCES app_users(oid) ON DELETE SET NULL,
  override_to_usd numeric(18, 6),
  override_at timestamptz,
  override_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT playbook_spend_policies_baseline_nonnegative CHECK (baseline_cost_usd >= 0),
  CONSTRAINT playbook_spend_policies_cap_positive CHECK (cap_usd > 0),
  CONSTRAINT playbook_spend_policies_warning_generation_nonnegative CHECK (warning_generation >= 0),
  CONSTRAINT playbook_spend_policies_warning_recipients_array
    CHECK (jsonb_typeof(warning_recipient_user_ids) = 'array'),
  CONSTRAINT playbook_spend_policies_warning_state_complete CHECK (
    (warning_active = false AND warning_crossed_at IS NULL)
    OR (warning_active = true AND warning_crossed_at IS NOT NULL)
  ),
  CONSTRAINT playbook_spend_policies_override_complete CHECK (
    (override_by_user_id IS NULL AND override_to_usd IS NULL AND override_at IS NULL AND override_reason IS NULL)
    OR
    (override_by_user_id IS NOT NULL AND override_to_usd IS NOT NULL AND override_to_usd > 0
      AND override_at IS NOT NULL AND length(trim(override_reason)) BETWEEN 10 AND 500)
  )
);

CREATE INDEX idx_playbook_spend_policies_enabled
  ON playbook_spend_policies (enabled)
  WHERE enabled = true;

INSERT INTO app_settings (key, value, updated_at)
VALUES ('playbooks.spend.default_no_history_cap_usd', '30.000000', now())
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_settings (key, value, updated_at)
VALUES ('playbooks.spend.latest_undercount_report', '{}', now())
ON CONFLICT (key) DO NOTHING;

-- Down Migration

DELETE FROM app_settings
WHERE key IN (
  'playbooks.spend.default_no_history_cap_usd',
  'playbooks.spend.latest_undercount_report'
);

DROP TABLE playbook_spend_policies;
