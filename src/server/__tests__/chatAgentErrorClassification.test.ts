jest.mock('@cursor/sdk', () => {
  class CursorAgentError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'CursorAgentError';
    }
  }
  return {
    Agent: { create: jest.fn(), resume: jest.fn() },
    CursorAgentError,
  };
});

jest.mock('../db/drizzle', () => ({ db: { query: {} } }));
jest.mock('drizzle-orm', () => ({
  eq: jest.fn(),
  and: jest.fn(),
  isNull: jest.fn(),
}));
jest.mock('../db/schema', () => ({
  interviews: {},
  prds: {},
  designDocs: {},
}));
jest.mock('../services/chatThreadRepository', () => ({
  upsertThread: jest.fn(),
  insertMessage: jest.fn(),
  listThreadsByUser: jest.fn(),
  loadFullThread: jest.fn(),
  deleteThread: jest.fn(),
}));
jest.mock('../services/prdService', () => ({ syncPrdContent: jest.fn() }));
jest.mock('../services/designDocService', () => ({
  syncDesignDocContent: jest.fn(),
  syncValidationResult: jest.fn(),
  syncPerFeatureDesignDocs: jest.fn(),
  finalizeSingleFeatureDoc: jest.fn(),
  isSingleFeatureDesignDocRow: jest.fn(
    (row: { designPrototypeId?: string | null; featureIndex?: number | null }) =>
      row.designPrototypeId != null || row.featureIndex != null,
  ),
}));
jest.mock('../services/telemetry', () => ({
  trackAgentError: jest.fn(),
  trackEvent: jest.fn(),
}));
jest.mock('../utils/dataDir', () => ({
  resolveDataRoot: () => '/tmp/test-data',
  isAzureWwwroot: () => false,
}));

import {
  isFatalRunError,
  isTransientSdkError,
  isRecoverableSdkError,
  isFatalSdkError,
  classifyError,
  mapErrorCode,
  isRateLimitError,
  isAuthError,
} from '../services/chatAgentService';

const { CursorAgentError } = jest.requireMock('@cursor/sdk') as {
  CursorAgentError: new (msg: string) => Error;
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeError(message: string, extras?: Record<string, unknown>): Error {
  const err = new Error(message);
  if (extras) Object.assign(err, extras);
  return err;
}

// ── isFatalRunError ─────────────────────────────────────────────────────────

describe('isFatalRunError', () => {
  it.each([
    'Authentication failed: invalid token',
    'Authorization error: forbidden',
    'Unauthorized access to resource',
    'Forbidden: insufficient permissions',
    'Invalid API key provided',
    'Invalid token — please re-authenticate',
    'Invalid credential for this workspace',
    'Invalid config: missing required field',
    'Agent not found: abc-123',
    'agent not found',
  ])('returns true for fatal message: "%s"', (msg) => {
    expect(isFatalRunError(msg)).toBe(true);
  });

  it.each([
    'Rate limited — try again later',
    'Server error 500',
    'Connection reset',
    'Timeout waiting for response',
    'Something went wrong',
    '',
  ])('returns false for non-fatal message: "%s"', (msg) => {
    expect(isFatalRunError(msg)).toBe(false);
  });
});

// ── isTransientSdkError ─────────────────────────────────────────────────────

describe('isTransientSdkError', () => {
  it('returns true for 429 status code', () => {
    expect(isTransientSdkError(makeError('Rate limited', { statusCode: 429 }))).toBe(true);
  });

  it('returns true for 500 status code', () => {
    expect(isTransientSdkError(makeError('Internal Server Error', { statusCode: 500 }))).toBe(true);
  });

  it('returns true for 503 status code', () => {
    expect(isTransientSdkError(makeError('Service Unavailable', { statusCode: 503 }))).toBe(true);
  });

  it('returns true for status property (not statusCode)', () => {
    expect(isTransientSdkError(makeError('Bad gateway', { status: 502 }))).toBe(true);
  });

  it.each(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', 'EAI_AGAIN', 'ECONNREFUSED'])(
    'returns true for network error code %s',
    (code) => {
      expect(isTransientSdkError(makeError('Network error', { code }))).toBe(true);
    },
  );

  it('returns false for 401 Unauthorized', () => {
    expect(isTransientSdkError(makeError('Unauthorized', { statusCode: 401 }))).toBe(false);
  });

  it('returns false for 403 Forbidden', () => {
    expect(isTransientSdkError(makeError('Forbidden', { statusCode: 403 }))).toBe(false);
  });

  it('returns false for 400 Bad Request', () => {
    expect(isTransientSdkError(makeError('Bad request', { statusCode: 400 }))).toBe(false);
  });

  it('returns false for "already has active run" errors', () => {
    expect(isTransientSdkError(makeError('Agent already has active run'))).toBe(false);
  });

  it('returns false for a plain Error with no status or code', () => {
    expect(isTransientSdkError(new Error('Something happened'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isTransientSdkError('string error')).toBe(false);
    expect(isTransientSdkError(null)).toBe(false);
    expect(isTransientSdkError(undefined)).toBe(false);
  });
});

// ── isRecoverableSdkError ───────────────────────────────────────────────────

describe('isRecoverableSdkError', () => {
  it.each([
    'Agent already has active run',
    'Stale run detected — please retry',
    'Agent disposed during operation',
    'Run expired',
    'Agent not available right now',
  ])('returns true for recoverable message: "%s"', (msg) => {
    expect(isRecoverableSdkError(new Error(msg))).toBe(true);
  });

  it('returns false for non-Error values', () => {
    expect(isRecoverableSdkError('already has active run')).toBe(false);
    expect(isRecoverableSdkError(null)).toBe(false);
  });

  it('returns false for unrelated errors', () => {
    expect(isRecoverableSdkError(new Error('Rate limited'))).toBe(false);
    expect(isRecoverableSdkError(new Error('Unauthorized'))).toBe(false);
  });
});

// ── isFatalSdkError ─────────────────────────────────────────────────────────

describe('isFatalSdkError', () => {
  it('returns true for 401 status code', () => {
    expect(isFatalSdkError(makeError('Unauthorized', { statusCode: 401 }))).toBe(true);
  });

  it('returns true for 403 status code', () => {
    expect(isFatalSdkError(makeError('Forbidden', { statusCode: 403 }))).toBe(true);
  });

  it('returns true for 403 via status property', () => {
    expect(isFatalSdkError(makeError('Forbidden', { status: 403 }))).toBe(true);
  });

  it.each([
    'Authentication failed',
    'Authorization denied',
    'Unauthorized request',
    'Forbidden zone',
    'Invalid API key supplied',
    'Invalid token xyz',
    'Invalid credential pair',
    'Invalid config detected',
    'Agent not found: id-123',
  ])('returns true for fatal message: "%s"', (msg) => {
    expect(isFatalSdkError(new Error(msg))).toBe(true);
  });

  it('returns false for transient errors', () => {
    expect(isFatalSdkError(makeError('Rate limited', { statusCode: 429 }))).toBe(false);
    expect(isFatalSdkError(makeError('Server error', { statusCode: 500 }))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isFatalSdkError('Unauthorized')).toBe(false);
    expect(isFatalSdkError(42)).toBe(false);
    expect(isFatalSdkError(null)).toBe(false);
  });
});

// ── classifyError ───────────────────────────────────────────────────────────

describe('classifyError', () => {
  it('returns "fatal" for auth errors', () => {
    expect(classifyError(makeError('Unauthorized', { statusCode: 401 }))).toBe('fatal');
  });

  it('returns "fatal" for invalid config errors', () => {
    expect(classifyError(new Error('Invalid API key provided'))).toBe('fatal');
  });

  it('returns "recoverable" for stale run errors', () => {
    expect(classifyError(new Error('Agent already has active run'))).toBe('recoverable');
  });

  it('returns "recoverable" for disposed agent', () => {
    expect(classifyError(new Error('Agent disposed'))).toBe('recoverable');
  });

  it('returns "transient" for 429', () => {
    expect(classifyError(makeError('Too Many Requests', { statusCode: 429 }))).toBe('transient');
  });

  it('returns "transient" for 500', () => {
    expect(classifyError(makeError('Internal Server Error', { statusCode: 500 }))).toBe('transient');
  });

  it('returns "transient" for network errors', () => {
    expect(classifyError(makeError('connect ECONNRESET', { code: 'ECONNRESET' }))).toBe('transient');
  });

  it('returns "fatal" for CursorAgentError that is unclassified', () => {
    const err = new CursorAgentError('Some SDK error');
    expect(classifyError(err)).toBe('fatal');
  });

  it('returns "transient" for unknown non-CursorAgentError errors', () => {
    expect(classifyError(new Error('Something unexpected'))).toBe('transient');
  });

  it('returns "transient" for non-Error values', () => {
    expect(classifyError('string error')).toBe('transient');
    expect(classifyError(null)).toBe('transient');
  });

  it('prioritises fatal over recoverable when both patterns match', () => {
    const err = makeError('Unauthorized', { statusCode: 401 });
    expect(classifyError(err)).toBe('fatal');
  });
});

// ── mapErrorCode ────────────────────────────────────────────────────────────

describe('mapErrorCode', () => {
  it('returns "rate_limit" for rate-limit errors regardless of tier', () => {
    const err = makeError('Rate limited', { statusCode: 429 });
    expect(mapErrorCode('transient', err)).toBe('rate_limit');
  });

  it('returns "rate_limit" for message-based rate limit detection', () => {
    const err = new Error('Too many requests — rate limit exceeded');
    expect(mapErrorCode('transient', err)).toBe('rate_limit');
  });

  it('returns "transient" for transient tier', () => {
    const err = makeError('Server error', { statusCode: 500 });
    expect(mapErrorCode('transient', err)).toBe('transient');
  });

  it('returns "transient" for recoverable tier', () => {
    const err = new Error('Agent already has active run');
    expect(mapErrorCode('recoverable', err)).toBe('transient');
  });

  it('returns "auth" for fatal auth errors', () => {
    const err = makeError('Unauthorized', { statusCode: 401 });
    expect(mapErrorCode('fatal', err)).toBe('auth');
  });

  it('returns "fatal" for non-auth fatal errors', () => {
    const err = new Error('Invalid config detected');
    expect(mapErrorCode('fatal', err)).toBe('fatal');
  });
});

// ── isRateLimitError ────────────────────────────────────────────────────────

describe('isRateLimitError', () => {
  it('returns true for 429 status code', () => {
    expect(isRateLimitError(makeError('Too Many', { statusCode: 429 }))).toBe(true);
  });

  it('returns true for 429 via status property', () => {
    expect(isRateLimitError(makeError('Too Many', { status: 429 }))).toBe(true);
  });

  it('returns true for "rate limit" in message', () => {
    expect(isRateLimitError(new Error('rate limit exceeded'))).toBe(true);
  });

  it('returns true for "too many requests" in message', () => {
    expect(isRateLimitError(new Error('Too Many Requests'))).toBe(true);
  });

  it('returns false for non-rate-limit errors', () => {
    expect(isRateLimitError(new Error('Server error'))).toBe(false);
    expect(isRateLimitError(makeError('Error', { statusCode: 500 }))).toBe(false);
  });
});

// ── isAuthError ─────────────────────────────────────────────────────────────

describe('isAuthError', () => {
  it('returns true for 401', () => {
    expect(isAuthError(makeError('Unauthorized', { statusCode: 401 }))).toBe(true);
  });

  it('returns true for 403', () => {
    expect(isAuthError(makeError('Forbidden', { statusCode: 403 }))).toBe(true);
  });

  it('returns true for "authentication" in message', () => {
    expect(isAuthError(new Error('Authentication failed'))).toBe(true);
  });

  it('returns true for "unauthorized" in message', () => {
    expect(isAuthError(new Error('Unauthorized access'))).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isAuthError(new Error('Server error'))).toBe(false);
    expect(isAuthError(makeError('Error', { statusCode: 500 }))).toBe(false);
  });
});
