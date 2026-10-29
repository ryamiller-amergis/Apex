import { describe, expect, it } from 'vitest';
import {
  PersistenceError,
  PersistenceUnavailableError,
  ProfileConflictError,
  SchemaNotMigratedError,
} from './errors.ts';
import { findDriverError, mapDatabaseError } from './mapDatabaseError.ts';

const SUBJECT = 'seed-user-test-1';
const NAME = 'Sample Person One';
const EMAIL = 'sample.one@example.com';

function driverError(fields: Record<string, unknown>): Error {
  return Object.assign(new Error(String(fields.message ?? 'driver error')), {
    detail: `Key (external_subject)=(${SUBJECT}) already exists.`,
    where: `values (${NAME}, ${EMAIL})`,
    ...fields,
  });
}

function wrapped(cause: Error): Error {
  return Object.assign(
    new Error(
      `Failed query: insert into "app_users" values ($1, $2, $3)\nparams: ${SUBJECT},${NAME},${EMAIL}`
    ),
    { cause, query: 'insert', params: [SUBJECT, NAME, EMAIL] }
  );
}

function expectNoValues(error: Error): void {
  const text = [error.message, error.stack ?? '', JSON.stringify(error)].join(
    '\n'
  );
  for (const value of [SUBJECT, NAME, EMAIL, 'Key (']) {
    expect(text).not.toContain(value);
  }
  expect(error.cause).toBeUndefined();
}

describe('mapDatabaseError', () => {
  it('TBI-006 NFR maps a duplicate subject to ProfileConflictError', () => {
    const mapped = mapDatabaseError(
      driverError({
        code: '23505',
        constraint: 'app_users_external_subject_unique',
        message:
          'duplicate key value violates unique constraint "app_users_external_subject_unique"',
      })
    );
    expect(mapped).toBeInstanceOf(ProfileConflictError);
    expect(mapped).toBeInstanceOf(PersistenceError);
    expect(mapped.sqlState).toBe('23505');
    expect(mapped.constraint).toBe('app_users_external_subject_unique');
    expectNoValues(mapped);
  });

  it('maps another unique violation to a plain PersistenceError', () => {
    const mapped = mapDatabaseError(
      driverError({ code: '23505', constraint: 'other_unique' })
    );
    expect(mapped).not.toBeInstanceOf(ProfileConflictError);
    expect(mapped).toBeInstanceOf(PersistenceError);
    expect(mapped.sqlState).toBe('23505');
  });

  it('PBI-005 AC-1 maps an undefined table to SchemaNotMigratedError', () => {
    const mapped = mapDatabaseError(
      driverError({
        code: '42P01',
        message: 'relation "app_users" does not exist',
      })
    );
    expect(mapped).toBeInstanceOf(SchemaNotMigratedError);
    expect(mapped.sqlState).toBe('42P01');
    expectNoValues(mapped);
  });

  it.each([
    ['08006', driverError({ code: '08006' })],
    ['57P01', driverError({ code: '57P01' })],
    ['ECONNREFUSED', driverError({ code: 'ECONNREFUSED' })],
    ['ENOTFOUND', driverError({ code: 'ENOTFOUND' })],
    [
      'AggregateError',
      Object.assign(new AggregateError([new Error('x')], ''), {
        code: 'ECONNREFUSED',
      }),
    ],
    ['pool timeout', new Error('timeout exceeded when trying to connect')],
    [
      'connect timeout',
      new Error('Connection terminated due to connection timeout'),
    ],
  ])('maps %s to PersistenceUnavailableError', (_label, error) => {
    const mapped = mapDatabaseError(error);
    expect(mapped).toBeInstanceOf(PersistenceUnavailableError);
    expectNoValues(mapped);
  });

  it('TBI-006 NFR reads the driver error through the cause chain', () => {
    const mapped = mapDatabaseError(
      wrapped(
        driverError({
          code: '23505',
          constraint: 'app_users_external_subject_unique',
        })
      )
    );
    expect(mapped).toBeInstanceOf(ProfileConflictError);
    expectNoValues(mapped);
  });

  it('maps a value-too-long error to PersistenceError with its SQLSTATE', () => {
    const mapped = mapDatabaseError(wrapped(driverError({ code: '22001' })));
    expect(mapped.constructor).toBe(PersistenceError);
    expect(mapped.sqlState).toBe('22001');
    expectNoValues(mapped);
  });

  it('maps an unknown error to PersistenceError without a SQLSTATE', () => {
    const mapped = mapDatabaseError(new Error(`boom ${SUBJECT}`));
    expect(mapped.constructor).toBe(PersistenceError);
    expect(mapped.sqlState).toBeUndefined();
    expectNoValues(mapped);
    expect(mapDatabaseError('not an error').constructor).toBe(PersistenceError);
  });

  it('returns an existing PersistenceError unchanged', () => {
    const error = new SchemaNotMigratedError({ sqlState: '42P01' });
    expect(mapDatabaseError(error)).toBe(error);
  });
});

describe('findDriverError', () => {
  it('returns the code, constraint, and message of the innermost driver error', () => {
    const found = findDriverError(
      wrapped(
        driverError({
          code: '42703',
          message: 'column "x" does not exist',
        })
      )
    );
    expect(found).toEqual({
      code: '42703',
      constraint: undefined,
      message: 'column "x" does not exist',
    });
  });

  it('returns null when no error in the chain has a code', () => {
    expect(findDriverError(new Error('plain'))).toBeNull();
  });
});
