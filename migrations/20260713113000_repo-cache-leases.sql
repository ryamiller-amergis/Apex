-- Up Migration

CREATE TABLE repo_cache_leases (
  cache_key  TEXT        PRIMARY KEY,
  owner_id  TEXT        NOT NULL,
  generation INTEGER    NOT NULL DEFAULT 1,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_repo_cache_leases_expires_at
  ON repo_cache_leases (expires_at);

-- Down Migration

DROP TABLE repo_cache_leases;
