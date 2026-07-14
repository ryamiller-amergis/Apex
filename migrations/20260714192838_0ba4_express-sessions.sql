-- Up Migration
-- express-session store for multi-instance App Service (replaces session-file-store).
-- Schema matches connect-pg-simple's recommended table.sql.

CREATE TABLE "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
)
WITH (OIDS=FALSE);

ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX "IDX_session_expire" ON "session" ("expire");

-- Down Migration
DROP INDEX IF EXISTS "IDX_session_expire";
DROP TABLE IF EXISTS "session";
