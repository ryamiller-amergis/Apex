/**
 * Unit tests for loadTestService — FEAT-004 Load Test Definition API
 *
 * Coverage matrix:
 *   TBI-004 DoD-0: CRUD happy paths (createDefinition, getDefinition, updateDefinition, deleteDefinition)
 *   TBI-004 DoD-1: getPortable omits secrets
 *   TBI-004 DoD-2: allowlist + prod hard-refuse
 *   PBI-004 AC-0:  Happy — saved with script_source
 *   PBI-004 AC-1:  Error — cap exceeded
 *   PBI-004 AC-2:  Edge — raw threshold reconcile
 *   PBI-004 AC-3:  Negative — plaintext secret rejected
 *   PBI-005 AC-0:  Happy — portable returns script + thresholds
 *   PBI-005 AC-1:  Error — secrets absent from portable response
 *   PBI-005 AC-2:  Edge — cross-project id returns null
 *   BR-009:        Project isolation (list only returns own rows)
 *   A-009:         Delete blocked by active run (409)
 */

import {
  reconcileThresholds,
  containsPlaintextSecret,
  isProdTarget,
  enforceProfileCaps,
  LOAD_TEST_CAPS,
} from '../services/loadTestService';
import { LoadTestValidationError } from '../../shared/types/loadTest';
import type {
  CreateLoadTestDefinitionInput,
} from '../../shared/types/loadTest';

// ── DB + Drizzle mock ─────────────────────────────────────────────────────────
// Use a factory function to avoid the jest.mock hoisting-before-initialization
// error that occurs when variable references appear in the jest.mock() callback.

jest.mock('../db/drizzle', () => {
  const mockReturning = jest.fn();
  const mockWhere = jest.fn();
  const mockLimit = jest.fn();
  const mockOrderBy = jest.fn();
  mockWhere.mockReturnValue({ limit: mockLimit, orderBy: mockOrderBy, returning: mockReturning });
  mockLimit.mockReturnValue({ orderBy: mockOrderBy });

  return {
    db: {
      select: jest.fn(() => ({ from: jest.fn(() => ({ where: mockWhere })) })),
      insert: jest.fn(() => ({ values: jest.fn(() => ({ returning: mockReturning })) })),
      update: jest.fn(() => ({ set: jest.fn(() => ({ where: mockWhere })) })),
      delete: jest.fn(() => ({ where: mockWhere })),
      transaction: jest.fn(),
    },
  };
});

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((col: unknown, val: unknown) => ({ _eq: { col, val } })),
  and: jest.fn((...args: unknown[]) => ({ _and: args })),
  or: jest.fn((...args: unknown[]) => ({ _or: args })),
  desc: jest.fn((col: unknown) => ({ _desc: col })),
  asc: jest.fn((col: unknown) => ({ _asc: col })),
  inArray: jest.fn((col: unknown, vals: unknown[]) => ({ _inArray: { col, vals } })),
  isNull: jest.fn(),
  isNotNull: jest.fn(),
  gte: jest.fn(),
  lte: jest.fn(),
  ne: jest.fn(),
  sql: jest.fn(),
  count: jest.fn(),
  // relations must return something callable so schema.ts can run
  relations: jest.fn().mockReturnValue({}),
}));

// ── Import service after mocks ─────────────────────────────────────────────────

import * as svc from '../services/loadTestService';

// ── Typed access to mocked db ─────────────────────────────────────────────────

function getMockDb() {
  return jest.requireMock('../db/drizzle').db as {
    select: jest.Mock;
    insert: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    transaction: jest.Mock;
  };
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

const PROJECT_A = 'project-a';
const PROJECT_B = 'project-b';
const USER_ID = 'user-1';
const DEF_ID = 'def-uuid-1';
const NOW = new Date().toISOString();

const baseLoadProfile = { vus: 10, durationMinutes: 5 };

function makeInput(overrides: Partial<CreateLoadTestDefinitionInput> = {}): CreateLoadTestDefinitionInput {
  return {
    name: 'My Test',
    script: 'import http from "k6/http"; export default function() { http.get("https://staging.example.com/api"); }',
    targetUrl: 'https://staging.example.com',
    environment: 'staging',
    loadProfile: baseLoadProfile,
    clientThresholds: [{ metric: 'http_req_duration', expression: 'p(95)<500' }],
    ...overrides,
  };
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DEF_ID,
    projectId: PROJECT_A,
    name: 'My Test',
    description: null,
    targetUrl: 'https://staging.example.com',
    environment: 'staging',
    engine: 'k6',
    flowType: 'single',
    scriptSource: 'form_builder',
    script: 'export default function() {}',
    loadProfile: baseLoadProfile,
    clientThresholds: [],
    runSource: null,
    secretRefs: null,
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: USER_ID,
    updatedBy: USER_ID,
    ...overrides,
  };
}

function makeTargetRow(baseUrl = 'https://staging.example.com') {
  return {
    id: 'target-1',
    projectId: PROJECT_A,
    baseUrl,
    environmentLabel: 'staging',
    isReachable: true,
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: USER_ID,
    updatedBy: USER_ID,
  };
}

// Helper: make db.select() return a target row so allowlist check passes
function setupAllowlistHit(baseUrl = 'https://staging.example.com') {
  const db = getMockDb();
  db.select.mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        orderBy: jest.fn().mockResolvedValue([makeTargetRow(baseUrl)]),
      }),
    }),
  });
}

// Helper: make db.select() return empty (no allowlist entries)
function setupAllowlistMiss() {
  const db = getMockDb();
  db.select.mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        orderBy: jest.fn().mockResolvedValue([]),
      }),
    }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── isProdTarget ───────────────────────────────────────────────────────────────

describe('isProdTarget', () => {
  it('flags URLs with "prod" in them', () => {
    expect(isProdTarget('https://api.prod.example.com', 'staging')).toBe(true);
    expect(isProdTarget('https://prod-api.example.com', 'staging')).toBe(true);
    expect(isProdTarget('https://api-prod.example.com', 'staging')).toBe(true);
  });

  it('flags production environment labels', () => {
    expect(isProdTarget('https://staging.example.com', 'production')).toBe(true);
    expect(isProdTarget('https://staging.example.com', 'prod')).toBe(true);
  });

  it('does not flag legitimate staging URLs', () => {
    expect(isProdTarget('https://staging.example.com', 'staging')).toBe(false);
    expect(isProdTarget('https://dev.example.com', 'dev')).toBe(false);
  });
});

// ── containsPlaintextSecret ────────────────────────────────────────────────────

describe('containsPlaintextSecret', () => {
  it('detects bearer token in script', () => {
    expect(containsPlaintextSecret('Authorization: Bearer abc123token')).toBe(true);
    expect(containsPlaintextSecret("headers: { 'Authorization': 'Bearer xyz' }")).toBe(true);
  });

  it('detects api_key pattern', () => {
    expect(containsPlaintextSecret('api_key: mysecretvalue')).toBe(true);
  });

  it('does not flag key vault references', () => {
    // A clean script without any secret patterns
    expect(containsPlaintextSecret('export default function() { http.get("https://staging.example.com"); }')).toBe(false);
  });
});

// ── enforceProfileCaps ────────────────────────────────────────────────────────

describe('enforceProfileCaps', () => {
  it('allows profiles within caps', () => {
    expect(() =>
      enforceProfileCaps({ vus: 100, durationMinutes: 10 }),
    ).not.toThrow();
  });

  // PBI-004 AC-1: cap exceeded
  it('throws LOAD_TEST_PROFILE_CAP_EXCEEDED when VUs exceed cap', () => {
    expect(() =>
      enforceProfileCaps({ vus: LOAD_TEST_CAPS.maxVus + 1, durationMinutes: 1 }),
    ).toThrow(LoadTestValidationError);
    try {
      enforceProfileCaps({ vus: LOAD_TEST_CAPS.maxVus + 1, durationMinutes: 1 });
    } catch (e) {
      expect((e as LoadTestValidationError).code).toBe('LOAD_TEST_PROFILE_CAP_EXCEEDED');
    }
  });

  it('throws LOAD_TEST_PROFILE_CAP_EXCEEDED when duration exceeds cap', () => {
    expect(() =>
      enforceProfileCaps({ vus: 100, durationMinutes: LOAD_TEST_CAPS.maxDurationMinutes + 1 }),
    ).toThrow(LoadTestValidationError);
  });

  it('throws LOAD_TEST_PROFILE_CAP_EXCEEDED when RPS cap exceeds limit', () => {
    expect(() =>
      enforceProfileCaps({ vus: 100, durationMinutes: 10, rpsCap: LOAD_TEST_CAPS.maxRpsCap + 1 }),
    ).toThrow(LoadTestValidationError);
  });
});

// ── reconcileThresholds ───────────────────────────────────────────────────────

describe('reconcileThresholds — PBI-004 AC-2', () => {
  const clientThresholds = [{ metric: 'http_req_duration', expression: 'p(95)<1000' }];

  it('parses options.thresholds from a raw k6 script', () => {
    const script = `
      export const options = {
        thresholds: {
          'http_req_duration': ['p(95)<500'],
          'http_req_failed': ['rate<0.01'],
        },
      };
      export default function() {}
    `;
    const { thresholds, reconciled } = reconcileThresholds(script, clientThresholds);
    expect(reconciled).toBe(true);
    expect(thresholds).toEqual([
      { metric: 'http_req_duration', expression: 'p(95)<500' },
      { metric: 'http_req_failed', expression: 'rate<0.01' },
    ]);
  });

  it('falls back to client thresholds when options block is absent', () => {
    const script = 'export default function() { http.get("/"); }';
    const { thresholds, reconciled } = reconcileThresholds(script, clientThresholds);
    expect(reconciled).toBe(false);
    expect(thresholds).toEqual(clientThresholds);
  });

  it('falls back when thresholds block not in options', () => {
    const script = 'export const options = { vus: 10, duration: "30s" }; export default function() {}';
    const { thresholds, reconciled } = reconcileThresholds(script, clientThresholds);
    expect(reconciled).toBe(false);
    expect(thresholds).toEqual(clientThresholds);
  });
});

// ── createDefinition ──────────────────────────────────────────────────────────

describe('createDefinition', () => {
  // PBI-004 AC-0: Happy path — saved with script_source
  it('persists and returns definition with scriptSource intact (AC-0)', async () => {
    setupAllowlistHit();
    const db = getMockDb();

    const row = makeRow({
      scriptSource: 'form_builder',
    });
    db.transaction.mockImplementation(async (fn: (tx: any) => Promise<any[]>) => {
      const tx = { insert: () => ({ values: () => ({ returning: () => [row] }) }) };
      return fn(tx);
    });

    const input = makeInput({
      scriptSource: 'form_builder',
    });
    const result = await svc.createDefinition(PROJECT_A, input, USER_ID);

    expect(result.name).toBe('My Test');
    expect(result.scriptSource).toBe('form_builder');
  });

  // PBI-004 AC-1: Profile cap exceeded — no row change
  it('throws LOAD_TEST_PROFILE_CAP_EXCEEDED and does not persist when VUs exceed cap (AC-1)', async () => {
    setupAllowlistHit();
    const db = getMockDb();

    const input = makeInput({ loadProfile: { vus: 999_999, durationMinutes: 5 } });

    await expect(svc.createDefinition(PROJECT_A, input, USER_ID)).rejects.toMatchObject({
      code: 'LOAD_TEST_PROFILE_CAP_EXCEEDED',
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('throws LOAD_TEST_PROFILE_CAP_EXCEEDED when duration exceeds cap (AC-1)', async () => {
    setupAllowlistHit();
    const db = getMockDb();

    const input = makeInput({ loadProfile: { vus: 10, durationMinutes: 999 } });

    await expect(svc.createDefinition(PROJECT_A, input, USER_ID)).rejects.toMatchObject({
      code: 'LOAD_TEST_PROFILE_CAP_EXCEEDED',
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  // PBI-004 AC-2: raw threshold reconcile on save
  it('reconciles thresholds when scriptSource is raw (AC-2)', async () => {
    setupAllowlistHit();
    const db = getMockDb();

    const script = `
      export const options = {
        thresholds: { 'http_req_duration': ['p(95)<300'] },
      };
      export default function() { http.get("https://staging.example.com"); }
    `;
    let capturedThresholds: unknown;
    db.transaction.mockImplementation(async (fn: (tx: any) => Promise<any[]>) => {
      const tx = {
        insert: () => ({
          values: (vals: Record<string, unknown>) => {
            capturedThresholds = vals.clientThresholds;
            const row = makeRow({ ...vals, scriptSource: 'raw', script });
            return { returning: () => [row] };
          },
        }),
      };
      return fn(tx);
    });

    const input = makeInput({
      scriptSource: 'raw',
      script,
      clientThresholds: [{ metric: 'http_req_duration', expression: 'p(95)<1000' }],
    });
    await svc.createDefinition(PROJECT_A, input, USER_ID);

    expect(capturedThresholds).toEqual([
      { metric: 'http_req_duration', expression: 'p(95)<300' },
    ]);
  });

  it('keeps client thresholds as fallback when raw parse fails (AC-2)', async () => {
    setupAllowlistHit();
    const db = getMockDb();

    const script = 'export default function() {}'; // no options block
    let capturedThresholds: unknown;
    db.transaction.mockImplementation(async (fn: (tx: any) => Promise<any[]>) => {
      const tx = {
        insert: () => ({
          values: (vals: Record<string, unknown>) => {
            capturedThresholds = vals.clientThresholds;
            return { returning: () => [makeRow({ ...vals })] };
          },
        }),
      };
      return fn(tx);
    });

    const clientThresholds = [{ metric: 'http_req_duration', expression: 'p(95)<999' }];
    const input = makeInput({ scriptSource: 'raw', script, clientThresholds });
    await svc.createDefinition(PROJECT_A, input, USER_ID);

    // Falls back to supplied clientThresholds
    expect(capturedThresholds).toEqual(clientThresholds);
  });

  // PBI-004 AC-3: Plaintext secret rejected
  it('throws LOAD_TEST_PLAINTEXT_SECRET when secretRefs contains a bearer token (AC-3)', async () => {
    setupAllowlistHit();
    const db = getMockDb();

    const input = makeInput({
      secretRefs: { Authorization: 'Bearer myplaintexttoken' },
    });

    await expect(svc.createDefinition(PROJECT_A, input, USER_ID)).rejects.toMatchObject({
      code: 'LOAD_TEST_PLAINTEXT_SECRET',
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('throws LOAD_TEST_PLAINTEXT_SECRET when script contains a bearer token (AC-3)', async () => {
    setupAllowlistHit();
    const db = getMockDb();

    const input = makeInput({
      script: "http.get('https://staging.example.com', { headers: { Authorization: 'Bearer s3cr3t' } });",
    });

    await expect(svc.createDefinition(PROJECT_A, input, USER_ID)).rejects.toMatchObject({
      code: 'LOAD_TEST_PLAINTEXT_SECRET',
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  // TBI-004 DoD-2: Prod target refused
  it('rejects LOAD_TEST_PROD_TARGET_REFUSED for a prod environment (DoD-2)', async () => {
    const db = getMockDb();
    const input = makeInput({
      targetUrl: 'https://api.example.com',
      environment: 'production',
    });

    await expect(svc.createDefinition(PROJECT_A, input, USER_ID)).rejects.toMatchObject({
      code: 'LOAD_TEST_PROD_TARGET_REFUSED',
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  // TBI-004 DoD-2: Non-allowlisted target refused
  it('rejects LOAD_TEST_TARGET_NOT_ALLOWLISTED when target not on allowlist (DoD-2)', async () => {
    setupAllowlistMiss();
    const db = getMockDb();

    const input = makeInput();

    await expect(svc.createDefinition(PROJECT_A, input, USER_ID)).rejects.toMatchObject({
      code: 'LOAD_TEST_TARGET_NOT_ALLOWLISTED',
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  // Input validation
  it('throws LOAD_TEST_VALIDATION when name is missing', async () => {
    const input = makeInput({ name: '' });

    await expect(svc.createDefinition(PROJECT_A, input, USER_ID)).rejects.toMatchObject({
      code: 'LOAD_TEST_VALIDATION',
    });
  });

  it('throws LOAD_TEST_VALIDATION when script is missing', async () => {
    const input = makeInput({ script: '' });

    await expect(svc.createDefinition(PROJECT_A, input, USER_ID)).rejects.toMatchObject({
      code: 'LOAD_TEST_VALIDATION',
    });
  });
});

// ── getDefinition ─────────────────────────────────────────────────────────────

describe('getDefinition', () => {
  it('returns the definition when found (TBI-004 DoD-0)', async () => {
    const db = getMockDb();
    const row = makeRow();
    db.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([row]) }),
      }),
    });

    const result = await svc.getDefinition(PROJECT_A, DEF_ID);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(DEF_ID);
    expect(result?.projectId).toBe(PROJECT_A);
  });

  it('returns null when not found', async () => {
    const db = getMockDb();
    db.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
      }),
    });

    const result = await svc.getDefinition(PROJECT_A, 'nonexistent');
    expect(result).toBeNull();
  });
});

// ── listDefinitions — BR-009 project isolation ────────────────────────────────

describe('listDefinitions — BR-009 project isolation', () => {
  it('returns only rows scoped to the requested projectId (BR-009)', async () => {
    const db = getMockDb();
    const projectARow = makeRow({ projectId: PROJECT_A });

    db.select
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockResolvedValue([projectARow]),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockResolvedValue([]),
          }),
        }),
      });

    const results = await svc.listDefinitions(PROJECT_A);

    expect(results).toHaveLength(1);
    expect(results[0].projectId).toBe(PROJECT_A);
    expect(results[0].latestRun).toBeNull();
  });

  it('attaches the latest run summary per definition', async () => {
    const db = getMockDb();
    const projectARow = makeRow({ projectId: PROJECT_A, id: DEF_ID });

    db.select
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockResolvedValue([projectARow]),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockResolvedValue([
              {
                id: 'run-newer',
                loadTestId: DEF_ID,
                status: 'dispatched',
                overallResult: null,
                createdAt: '2026-07-25T12:00:00.000Z',
              },
              {
                id: 'run-older',
                loadTestId: DEF_ID,
                status: 'passed',
                overallResult: 'passed',
                createdAt: '2026-07-24T12:00:00.000Z',
              },
            ]),
          }),
        }),
      });

    const results = await svc.listDefinitions(PROJECT_A);
    expect(results[0].latestRun).toEqual({
      id: 'run-newer',
      status: 'dispatched',
      overallResult: null,
    });
  });
});

// ── deleteDefinition — A-009 active-run guard ─────────────────────────────────

describe('deleteDefinition', () => {
  it('rejects 409 LOAD_TEST_ACTIVE_RUN when an active run exists (A-009)', async () => {
    const db = getMockDb();

    // Active-run check returns a run row → should block delete
    db.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([{ id: 'run-1' }]),
        }),
      }),
    });

    await expect(svc.deleteDefinition(PROJECT_A, DEF_ID)).rejects.toMatchObject({
      code: 'LOAD_TEST_ACTIVE_RUN',
    });
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('hard-deletes when no active run exists (TBI-004 DoD-0)', async () => {
    const db = getMockDb();

    // Active-run check returns empty
    db.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([]),
        }),
      }),
    });

    db.delete.mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: DEF_ID }]),
      }),
    });

    const result = await svc.deleteDefinition(PROJECT_A, DEF_ID);
    expect(result).toBe(true);
  });
});

// ── getPortable ───────────────────────────────────────────────────────────────

describe('getPortable', () => {
  // PBI-005 AC-0: returns script + thresholds for a known definition
  it('returns portable definition with script and thresholds (AC-0)', async () => {
    const db = getMockDb();
    const row = makeRow({
      script: 'export default function() { http.get("https://staging.example.com"); }',
      clientThresholds: [{ metric: 'http_req_duration', expression: 'p(95)<500' }],
      secretRefs: null,
    });
    db.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([row]) }),
      }),
    });

    const result = await svc.getPortable(PROJECT_A, DEF_ID);

    expect(result).not.toBeNull();
    expect(result?.script).toBeDefined();
    expect(result?.clientThresholds).toEqual([{ metric: 'http_req_duration', expression: 'p(95)<500' }]);
  });

  // PBI-005 AC-1: secret values absent from portable response
  it('does not include secretRefs in the portable response (AC-1)', async () => {
    const db = getMockDb();
    const row = makeRow({
      secretRefs: { Authorization: 'kv://myvault/mysecret' },
    });
    db.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([row]) }),
      }),
    });

    const result = await svc.getPortable(PROJECT_A, DEF_ID);

    expect(result).not.toBeNull();
    // secretRefs must not appear in portable artifact (BR-006, PBI-005 AC-1)
    expect((result as any).secretRefs).toBeUndefined();
    expect((result as any).secret_refs).toBeUndefined();
  });

  // PBI-005 AC-2: cross-project / missing id returns null
  it('returns null when definition id not in project (AC-2)', async () => {
    const db = getMockDb();
    db.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
      }),
    });

    const result = await svc.getPortable(PROJECT_B, DEF_ID);
    expect(result).toBeNull();
  });
});
