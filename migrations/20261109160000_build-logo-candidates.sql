-- Logo options generated for review before a Build revision is created.

-- Up Migration

CREATE TABLE build_logo_candidate_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  build_run_id UUID NOT NULL REFERENCES build_runs (id) ON DELETE RESTRICT,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT NOT NULL,
  failure_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT build_logo_candidate_batches_status_check
    CHECK (status IN ('running', 'ready', 'failed')),
  CONSTRAINT build_logo_candidate_batches_provider_check
    CHECK (provider IN ('comfyui')),
  CONSTRAINT build_logo_candidate_batches_prompt_check
    CHECK (char_length(btrim(prompt)) BETWEEN 1 AND 4000)
);

CREATE INDEX idx_build_logo_candidate_batches_run
  ON build_logo_candidate_batches (build_run_id, created_at DESC);
CREATE UNIQUE INDEX uq_build_logo_candidate_batches_running
  ON build_logo_candidate_batches (build_run_id)
  WHERE status = 'running';

CREATE TABLE build_logo_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES build_logo_candidate_batches (id) ON DELETE RESTRICT,
  build_run_id UUID NOT NULL REFERENCES build_runs (id) ON DELETE RESTRICT,
  status TEXT NOT NULL,
  digest TEXT,
  storage_key TEXT,
  failure_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT build_logo_candidates_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'superseded', 'failed')),
  CONSTRAINT build_logo_candidates_digest_check
    CHECK (digest IS NULL OR digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT build_logo_candidates_image_check
    CHECK ((status = 'pending' AND digest IS NOT NULL AND storage_key IS NOT NULL) OR status <> 'pending')
);

CREATE INDEX idx_build_logo_candidates_batch
  ON build_logo_candidates (batch_id, created_at);
CREATE UNIQUE INDEX uq_build_logo_candidates_approved
  ON build_logo_candidates (batch_id)
  WHERE status = 'approved';

-- Down Migration

DROP TABLE IF EXISTS build_logo_candidates;
DROP TABLE IF EXISTS build_logo_candidate_batches;
