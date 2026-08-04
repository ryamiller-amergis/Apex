ALTER TABLE walkthroughs
  ADD COLUMN IF NOT EXISTS is_required BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN walkthroughs.is_required IS
  'When true, users must complete the walkthrough and cannot dismiss it.';
