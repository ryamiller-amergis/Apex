---
name: postgresql-migrations
description: Patterns for creating and applying SQL database migrations safely. Use when adding tables, columns, indexes, or constraints to a PostgreSQL database.
---

# PostgreSQL Migrations — Foundation

Safe patterns for evolving a PostgreSQL database schema with explicit migration files.

## Creating a migration

1. Generate a timestamped filename: `{timestamp}_{description}.sql`
2. Write an Up migration section and optionally a Down migration section.
3. Every migration must be:
   - **Idempotent** — safe to run multiple times (use `IF NOT EXISTS`, `IF EXISTS`)
   - **Backward compatible** — do not break running application code
   - **Non-destructive** — prefer additive changes; never drop columns in the same migration that adds them

## Up migration patterns

```sql
-- Add a new table
CREATE TABLE IF NOT EXISTS my_table (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add a column (backward compatible)
ALTER TABLE existing_table ADD COLUMN IF NOT EXISTS new_column TEXT;

-- Add an index
CREATE INDEX IF NOT EXISTS idx_my_table_name ON my_table (name);
```

## Down migration

Always include a commented-out Down migration so rollback is possible:

```sql
-- Down Migration
-- DROP TABLE IF EXISTS my_table;
-- ALTER TABLE existing_table DROP COLUMN IF EXISTS new_column;
```

## Rules

- Never drop a column that application code still reads or writes.
- Add `NOT NULL` columns with a default value, or add nullable first.
- Index every foreign key column.
- Name indexes consistently: `idx_{table}_{column(s)}`.
- Keep each migration focused on one concern.
- Run migrations in a transaction when possible.
- Test the migration locally before committing.

## Project-specific conventions

The project adapter defines:
- The migration runner command
- The migration file location
- Timestamp format used by this project
- Any project-specific naming conventions
