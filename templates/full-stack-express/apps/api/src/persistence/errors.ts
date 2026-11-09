// Messages are constant. A driver error is never attached as `cause`, because
// PostgreSQL puts row values in its `detail` field.

export interface PersistenceErrorFields {
  sqlState?: string;
  constraint?: string;
}

export class PersistenceError extends Error {
  readonly sqlState?: string;
  readonly constraint?: string;

  constructor(
    fields: PersistenceErrorFields = {},
    message = 'The database operation failed.'
  ) {
    super(message);
    this.name = new.target.name;
    if (fields.sqlState !== undefined) {
      this.sqlState = fields.sqlState;
    }
    if (fields.constraint !== undefined) {
      this.constraint = fields.constraint;
    }
  }
}

export class ProfileConflictError extends PersistenceError {
  constructor(fields: PersistenceErrorFields = {}) {
    super(fields, 'A profile already exists for this external subject.');
  }
}

export class SchemaNotMigratedError extends PersistenceError {
  constructor(fields: PersistenceErrorFields = {}) {
    super(fields, 'The database schema has not been migrated.');
  }
}

export class PersistenceUnavailableError extends PersistenceError {
  constructor(fields: PersistenceErrorFields = {}) {
    super(fields, 'The database is unavailable.');
  }
}
