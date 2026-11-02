import {
  PersistenceError,
  PersistenceUnavailableError,
  ProfileConflictError,
  SchemaNotMigratedError,
} from './errors.ts';

const SUBJECT_UNIQUE = 'app_users_external_subject_unique';
const MAX_CAUSE_DEPTH = 10;
const SQLSTATE = /^[0-9A-Z]{5}$/;
const UNAVAILABLE_CODES = new Set([
  '57P01',
  '57P02',
  '57P03',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);
// node-postgres raises connection timeouts as plain errors with no code.
const TIMEOUT_MESSAGE = /timeout (?:exceeded|expired)|connection timeout/i;

export interface DriverErrorInfo {
  code: string;
  constraint: string | undefined;
  message: string | undefined;
}

function readString(value: object, key: string): string | undefined {
  const field: unknown = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

// Drizzle wraps driver errors (DrizzleQueryError), so the code sits on a cause.
export function findDriverError(error: unknown): DriverErrorInfo | null {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current === null || typeof current !== 'object') {
      return null;
    }
    const code = readString(current, 'code');
    if (code !== undefined) {
      return {
        code,
        constraint: readString(current, 'constraint'),
        message: readString(current, 'message'),
      };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function hasTimeoutMessage(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) {
      return false;
    }
    if (TIMEOUT_MESSAGE.test(current.message)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

export function mapDatabaseError(error: unknown): PersistenceError {
  if (error instanceof PersistenceError) {
    return error;
  }
  const driver = findDriverError(error);
  if (driver === null) {
    return hasTimeoutMessage(error)
      ? new PersistenceUnavailableError()
      : new PersistenceError();
  }
  const sqlState = SQLSTATE.test(driver.code) ? driver.code : undefined;
  if (driver.code === '23505' && driver.constraint === SUBJECT_UNIQUE) {
    return new ProfileConflictError({
      sqlState,
      constraint: driver.constraint,
    });
  }
  if (driver.code === '42P01') {
    return new SchemaNotMigratedError({ sqlState });
  }
  if (driver.code.startsWith('08') || UNAVAILABLE_CODES.has(driver.code)) {
    return new PersistenceUnavailableError({ sqlState });
  }
  return new PersistenceError({ sqlState, constraint: driver.constraint });
}
