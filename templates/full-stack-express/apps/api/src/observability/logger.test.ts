import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.ts';
import { IDENTITY_FIELD_NAMES, serializeError } from './redaction.ts';
import { captureLogs } from './testing/captureLogs.ts';

const MARKER = 'MARKER_IDENTITY_VALUE';

function nest(depth: number, key: string): Record<string, unknown> {
  let value: Record<string, unknown> = { [key]: MARKER };
  for (let level = 0; level < depth; level += 1) {
    value = { [`level${level}`]: value };
  }
  return value;
}

describe('createLogger', () => {
  it('VT-10 TBI-016 DoD-0 DoD-3 writes single-line JSON and follows LOG_LEVEL', () => {
    const warnCapture = captureLogs();
    const warnLogger = createLogger({ LOG_LEVEL: 'warn' }, warnCapture.stream);
    warnLogger.info('info line');
    warnLogger.warn({ detail: 'multi\nline' }, 'warn line');
    const warnLines = warnCapture.raw();
    expect(warnLines).toHaveLength(1);
    const parsed = JSON.parse(warnLines[0] ?? '') as Record<string, unknown>;
    expect(parsed.msg).toBe('warn line');
    expect(parsed.level).toBe('warn');

    const infoCapture = captureLogs();
    const infoLogger = createLogger({ LOG_LEVEL: 'info' }, infoCapture.stream);
    infoLogger.info('info line');
    infoLogger.warn('warn line');
    expect(infoCapture.lines().map((line) => line.msg)).toEqual([
      'info line',
      'warn line',
    ]);
  });

  it('VT-10 silent writes nothing', () => {
    const capture = captureLogs();
    const logger = createLogger({ LOG_LEVEL: 'silent' }, capture.stream);
    logger.fatal('nothing');
    expect(capture.raw()).toEqual([]);
  });

  it('VT-09 TBI-016 DoD-1 redacts every identity key at depths 0 to 3', () => {
    const capture = captureLogs();
    const logger = createLogger({ LOG_LEVEL: 'info' }, capture.stream);
    for (const key of IDENTITY_FIELD_NAMES) {
      for (let depth = 0; depth <= 3; depth += 1) {
        logger.info(nest(depth, key), `${key} at ${depth}`);
      }
    }
    const lines = capture.raw();
    expect(lines).toHaveLength(IDENTITY_FIELD_NAMES.length * 4);
    for (const line of lines) {
      expect(line).not.toContain(MARKER);
      expect(line).toContain('[Redacted]');
    }
  });

  it('VT-09 redacts identity keys inside arrays and on child bindings', () => {
    const capture = captureLogs();
    const logger = createLogger({ LOG_LEVEL: 'info' }, capture.stream);
    logger.info({ users: [{ email: MARKER }] }, 'array');
    logger.child({ email: MARKER }).info('child');
    for (const line of capture.raw()) {
      expect(line).not.toContain(MARKER);
    }
  });

  it('VT-09 TBI-016 NFR the error serializer keeps type, code, message, and stack only', () => {
    const capture = captureLogs();
    const logger = createLogger({ LOG_LEVEL: 'info' }, capture.stream);
    const error = Object.assign(new Error('duplicate key'), {
      code: '23505',
      detail: `Key (email)=(${MARKER}) already exists.`,
      where: `SQL statement ${MARKER}`,
      parameters: [MARKER],
      query: `insert into app_users values ('${MARKER}')`,
      cause: new Error(`wrapped ${MARKER}`),
    });
    logger.error({ err: error }, 'request failed');
    const [line] = capture.lines();
    expect(capture.raw().join('')).not.toContain(MARKER);
    expect(line?.err).toEqual({
      type: 'Error',
      code: '23505',
      message: 'duplicate key',
      stack: expect.stringContaining('duplicate key'),
    });
  });

  it('VT-09 serializeError leaves non-error values in a safe shape', () => {
    expect(serializeError('text')).toEqual({ type: 'string', message: 'text' });
    expect(serializeError({ email: MARKER })).toEqual({ type: 'object' });
    class CustomFailure extends Error {
      override name = 'CustomFailure';
    }
    expect(serializeError(new CustomFailure('x'))).toMatchObject({
      type: 'CustomFailure',
      message: 'x',
    });
  });
});
