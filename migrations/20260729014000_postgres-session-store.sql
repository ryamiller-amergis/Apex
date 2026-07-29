-- Up Migration
-- PostgreSQL-backed Express sessions. The application owns this table through
-- migrations; connect-pg-simple must not create it at runtime.

CREATE TABLE express_sessions (
  sid    VARCHAR      NOT NULL COLLATE "default",
  sess   JSON         NOT NULL,
  expire TIMESTAMP(6) NOT NULL,
  CONSTRAINT express_sessions_pkey PRIMARY KEY (sid)
);

CREATE INDEX idx_express_sessions_expire
  ON express_sessions (expire);

-- Down Migration

DROP TABLE express_sessions;
