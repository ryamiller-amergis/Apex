/**
 * S7 — Build verification matrix and evidence streaming routes (TBI-021 DoD-2, PBI-023 AC-0..AC-3).
 * Covers VT-20, VT-21, VT-22, VT-23, VT-24, VT-25.
 */
import type { ArtifactRef } from '../../shared/types/loadTest';
import {
  buildEvidenceBlobPrefix,
  createInMemoryEvidenceStore,
  type EvidenceSlot,
} from '../services/builds/buildEvidenceStore';

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      buildRuns: { findFirst: jest.fn() },
      buildRevisions: { findMany: jest.fn(), findFirst: jest.fn() },
      buildVerificationRows: { findMany: jest.fn(), findFirst: jest.fn() },
    },
  },
}));

jest.mock('../db', () => ({
  __esModule: true,
  default: { end: jest.fn(), on: jest.fn() },
}));

const getUserPermissions = jest.fn();
jest.mock('../services/rbacService', () => ({
  getUserPermissions: (...args: unknown[]) => getUserPermissions(...args),
}));

const isSuperAdminRequest = jest.fn(() => false);
jest.mock('../utils/superAdmin', () => ({
  isSuperAdminRequest: (...args: unknown[]) => isSuperAdminRequest(...(args as [])),
  getAppEnvironment: () => 'local',
}));

jest.mock('../services/groupService', () => ({
  getUserGroupNames: async () => [],
  getUserGroupNamesForProject: async () => [],
}));

const getAssignmentsForUser = jest.fn();
jest.mock('../services/userProjectAssignmentService', () => ({
  getAssignmentsForUser: (...args: unknown[]) => getAssignmentsForUser(...args),
}));

const isFeatureEnabled = jest.fn(async () => true);
jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: (...args: unknown[]) => isFeatureEnabled(...(args as [])),
}));

const fakeEvidenceStore = createInMemoryEvidenceStore('ai-run-artifacts');
const streamEvidenceSpy = jest.fn(
  (ref: ArtifactRef, slot: EvidenceSlot) => fakeEvidenceStore.streamEvidence(ref, slot),
);

jest.mock('../services/builds/buildEvidenceStore', () => {
  const actual = jest.requireActual('../services/builds/buildEvidenceStore');
  return {
    ...actual,
    streamEvidence: (ref: ArtifactRef, slot: EvidenceSlot) => streamEvidenceSpy(ref, slot),
  };
});

import express from 'express';
import request from 'supertest';
import buildsRouter from '../routes/builds';

const { db: mockDb } = jest.requireMock('../db/drizzle') as {
  db: {
    query: {
      buildRuns: { findFirst: jest.Mock };
      buildRevisions: { findMany: jest.Mock; findFirst: jest.Mock };
      buildVerificationRows: { findMany: jest.Mock; findFirst: jest.Mock };
    };
  };
};

const USER_OID = 'user-member-oid';
const BUILD_ID = '00000000-0000-4000-8000-000000000010';
const OTHER_BUILD_ID = '00000000-0000-4000-8000-000000000020';
const UNKNOWN_BUILD_ID = '00000000-0000-4000-8000-000000000099';

const REV_1_ID = '00000000-0000-4000-8000-000000000101';
const REV_2_ID = '00000000-0000-4000-8000-000000000102';
const REV_3_ID = '00000000-0000-4000-8000-000000000103';
const OTHER_REV_ID = '00000000-0000-4000-8000-000000000201';

const ROW_PASS_ID = '00000000-0000-4000-8000-000000001001';
const ROW_FAIL_ID = '00000000-0000-4000-8000-000000001002';
const ROW_DEFERRED_ID = '00000000-0000-4000-8000-000000001003';
const ROW_RETIRED_ID = '00000000-0000-4000-8000-000000001004';
const ROW_RD_ID = '00000000-0000-4000-8000-000000001005';
const OTHER_BUILD_ROW_ID = '00000000-0000-4000-8000-000000002001';

let authenticatedUserOid: string | null = USER_OID;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (authenticatedUserOid) {
      (req as unknown as { user: unknown }).user = {
        profile: { oid: authenticatedUserOid },
      };
    }
    next();
  });
  app.use('/api/builds', buildsRouter);
  return app;
}

const baseBuildRun = {
  id: BUILD_ID,
  project: 'ProjectB',
  repository: 'org/repo',
  status: 'building',
  currentRevisionNumber: 3,
};

const revisionsFixture = [
  {
    id: REV_1_ID,
    buildRunId: BUILD_ID,
    revisionNumber: 1,
    requirements: [
      { id: 'AC-1', kind: 'ac', text: 'Revision 1 requirement text', retired: false },
    ],
    riskDecisions: [],
  },
  {
    id: REV_2_ID,
    buildRunId: BUILD_ID,
    revisionNumber: 2,
    requirements: [
      { id: 'AC-1', kind: 'ac', text: 'Revision 2 requirement text', retired: false },
    ],
    riskDecisions: [],
  },
  {
    id: REV_3_ID,
    buildRunId: BUILD_ID,
    revisionNumber: 3,
    requirements: [
      { id: 'AC-1', kind: 'ac', text: 'Users can submit a request', retired: false },
      { id: 'AC-2', kind: 'ac', text: 'Empty title is rejected', retired: false },
      { id: 'NFR-1', kind: 'nfr', text: 'Page loads in under 1 second', retired: false },
      { id: 'DOD-1', kind: 'dod', text: 'Retired criterion from earlier draft', retired: true },
    ],
    riskDecisions: [
      {
        id: 'RD-1',
        category: 'data',
        rating: 'low',
        decision: 'Keep deleted records soft-deleted',
        rationale: 'Reversible operation',
      },
    ],
  },
];

const rev3RowsFixture = [
  {
    id: ROW_RETIRED_ID,
    buildRevisionId: REV_3_ID,
    requirementId: 'DOD-1',
    kind: 'dod',
    testTier: 'unit',
    testRefs: [{ path: 'src/__tests__/old.test.ts', name: 'DOD-1: old test' }],
    redEvidence: null,
    greenEvidence: null,
    evidenceBlobRef: null,
    status: 'retired',
    deferralReason: null,
  },
  {
    id: ROW_RD_ID,
    buildRevisionId: REV_3_ID,
    requirementId: 'RD-1',
    kind: 'risk_decision',
    testTier: 'integration',
    testRefs: [{ path: 'src/__tests__/risk.test.ts', name: 'RD-1: soft delete only' }],
    redEvidence: {
      commit: '1111111',
      command: 'npx jest src/__tests__/risk.test.ts',
      exitCode: 1,
      recordedAt: '2026-11-03T10:00:00.000Z',
      passed: 0,
      failed: 1,
      summary: '1 failed',
    },
    greenEvidence: {
      commit: '2222222',
      command: 'npx jest src/__tests__/risk.test.ts',
      exitCode: 0,
      recordedAt: '2026-11-03T10:02:00.000Z',
      passed: 1,
      failed: 0,
      summary: '1 passed',
    },
    evidenceBlobRef: {
      container: 'ai-run-artifacts',
      key: buildEvidenceBlobPrefix(BUILD_ID, 3, 'RD-1'),
    },
    status: 'pass',
    deferralReason: null,
  },
  {
    id: ROW_DEFERRED_ID,
    buildRevisionId: REV_3_ID,
    requirementId: 'NFR-1',
    kind: 'nfr',
    testTier: 'e2e',
    testRefs: [{ path: 'tests/e2e/perf.spec.ts', name: 'NFR-1: page load timing' }],
    redEvidence: null,
    greenEvidence: null,
    evidenceBlobRef: null,
    status: 'deferred',
    deferralReason: 'Playwright browser runner is not available in unit sandbox.',
  },
  {
    id: ROW_FAIL_ID,
    buildRevisionId: REV_3_ID,
    requirementId: 'AC-2',
    kind: 'ac',
    testTier: 'unit',
    testRefs: [{ path: 'src/__tests__/form.test.ts', name: 'AC-2: rejects empty title' }],
    redEvidence: {
      commit: 'aaaaaaa',
      command: 'npx jest src/__tests__/form.test.ts',
      exitCode: 1,
      recordedAt: '2026-11-03T10:00:00.000Z',
      passed: 0,
      failed: 1,
      summary: '1 failed',
    },
    greenEvidence: null,
    evidenceBlobRef: {
      container: 'ai-run-artifacts',
      key: buildEvidenceBlobPrefix(BUILD_ID, 3, 'AC-2'),
    },
    status: 'fail',
    deferralReason: null,
  },
  {
    id: ROW_PASS_ID,
    buildRevisionId: REV_3_ID,
    requirementId: 'AC-1',
    kind: 'ac',
    testTier: 'unit',
    testRefs: [{ path: 'src/__tests__/submit.test.ts', name: 'AC-1: submits request' }],
    redEvidence: {
      commit: 'a1b2c3d',
      command: 'npx jest src/__tests__/submit.test.ts',
      exitCode: 1,
      recordedAt: '2026-11-03T09:55:00.000Z',
      passed: 0,
      failed: 1,
      summary: '1 failed',
    },
    greenEvidence: {
      commit: 'd4e5f6a',
      command: 'npx jest src/__tests__/submit.test.ts',
      exitCode: 0,
      recordedAt: '2026-11-03T09:58:00.000Z',
      passed: 1,
      failed: 0,
      summary: '1 passed',
    },
    evidenceBlobRef: {
      container: 'ai-run-artifacts',
      key: buildEvidenceBlobPrefix(BUILD_ID, 3, 'AC-1'),
    },
    status: 'pass',
    deferralReason: null,
  },
];

const rev1RowsFixture = [
  {
    id: '00000000-0000-4000-8000-000000001101',
    buildRevisionId: REV_1_ID,
    requirementId: 'AC-1',
    kind: 'ac',
    testTier: 'unit',
    testRefs: [{ path: 'src/__tests__/r1.test.ts', name: 'AC-1: r1 test' }],
    redEvidence: null,
    greenEvidence: null,
    evidenceBlobRef: null,
    status: 'fail',
    deferralReason: null,
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.query.buildRuns.findFirst.mockReset();
  mockDb.query.buildRevisions.findMany.mockReset();
  mockDb.query.buildRevisions.findFirst.mockReset();
  mockDb.query.buildVerificationRows.findMany.mockReset();
  mockDb.query.buildVerificationRows.findFirst.mockReset();
  fakeEvidenceStore.blobs.clear();
  authenticatedUserOid = USER_OID;
  isSuperAdminRequest.mockReturnValue(false);
  isFeatureEnabled.mockResolvedValue(true);

  getAssignmentsForUser.mockResolvedValue(['ProjectB']);
  getUserPermissions.mockImplementation(async (_userId: string, project?: string) =>
    project === 'ProjectB' ? new Set(['builds:view']) : new Set<string>(),
  );

  mockDb.query.buildRuns.findFirst.mockImplementation(async () => baseBuildRun);
  mockDb.query.buildRevisions.findMany.mockImplementation(async () => [...revisionsFixture]);
  mockDb.query.buildRevisions.findFirst.mockImplementation(async () => revisionsFixture[2]);
  mockDb.query.buildVerificationRows.findMany.mockImplementation(async () => [...rev3RowsFixture]);
  mockDb.query.buildVerificationRows.findFirst.mockImplementation(async () => rev3RowsFixture[4]);
});

describe('Build verification and evidence routes (S7)', () => {
  it('VT-20: streams seeded red evidence with text/plain, nosniff, no-store and first byte under 1s for a member with builds:view', async () => {
    const prefix = buildEvidenceBlobPrefix(BUILD_ID, 3, 'AC-1');
    const seededRedOutput = 'FAIL src/__tests__/submit.test.ts\n  ● AC-1: submits request\n    Expected 200, received 500';
    await fakeEvidenceStore.putEvidence(prefix, 'red', seededRedOutput);

    const startedAt = Date.now();
    const res = await request(createApp()).get(
      `/api/builds/${BUILD_ID}/evidence/${ROW_PASS_ID}/red`,
    );
    const elapsedMs = Date.now() - startedAt;

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain;\s*charset=utf-8$/i);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toBe(seededRedOutput);
    expect(elapsedMs).toBeLessThan(1000);
    expect(streamEvidenceSpy).toHaveBeenCalledWith(
      { container: 'ai-run-artifacts', key: prefix },
      'red',
    );
  });

  it('VT-21: returns 403 on both routes with no data and never calls the Blob client when caller holds builds:view in project A and build is in project B', async () => {
    const prefix = buildEvidenceBlobPrefix(BUILD_ID, 3, 'AC-1');
    await fakeEvidenceStore.putEvidence(prefix, 'red', 'SECRET_PROJECT_B_EVIDENCE');

    getAssignmentsForUser.mockResolvedValue(['ProjectA']);
    getUserPermissions.mockImplementation(async (_userId: string, project?: string) =>
      project === 'ProjectA' ? new Set(['builds:view']) : new Set<string>(),
    );

    const evidenceRes = await request(createApp())
      .get(`/api/builds/${BUILD_ID}/evidence/${ROW_PASS_ID}/red`)
      .set('x-apex-project', 'ProjectA');

    const matrixRes = await request(createApp())
      .get(`/api/builds/${BUILD_ID}/verification`)
      .set('x-apex-project', 'ProjectA');

    expect(evidenceRes.status).toBe(403);
    expect(evidenceRes.text).not.toContain('SECRET_PROJECT_B_EVIDENCE');
    expect(evidenceRes.body).toEqual({ error: 'Forbidden' });

    expect(matrixRes.status).toBe(403);
    expect(matrixRes.body).toEqual({ error: 'Forbidden' });
    expect(matrixRes.body.rows).toBeUndefined();

    expect(streamEvidenceSpy).not.toHaveBeenCalled();
  });

  it('VT-22: returns 404 BUILD_EVIDENCE_NOT_AVAILABLE when Blob is missing, 404 for unknown build, 404 for row of another build, and 400 for slot blue', async () => {
    // 1. Row exists, Blob is missing from storage
    const missingBlobRes = await request(createApp()).get(
      `/api/builds/${BUILD_ID}/evidence/${ROW_PASS_ID}/red`,
    );
    expect(missingBlobRes.status).toBe(404);
    expect(missingBlobRes.body).toMatchObject({
      code: 'BUILD_EVIDENCE_NOT_AVAILABLE',
    });

    // 2. Unknown build
    mockDb.query.buildRuns.findFirst.mockResolvedValueOnce(null);
    const unknownBuildRes = await request(createApp()).get(
      `/api/builds/${UNKNOWN_BUILD_ID}/evidence/${ROW_PASS_ID}/red`,
    );
    expect(unknownBuildRes.status).toBe(404);

    // 3. Row belonging to another build
    mockDb.query.buildVerificationRows.findFirst.mockResolvedValueOnce({
      ...rev3RowsFixture[4],
      id: OTHER_BUILD_ROW_ID,
      buildRevisionId: OTHER_REV_ID,
      revision: { id: OTHER_REV_ID, buildRunId: OTHER_BUILD_ID, revisionNumber: 1 },
    });
    mockDb.query.buildRevisions.findFirst.mockResolvedValueOnce({
      id: OTHER_REV_ID,
      buildRunId: OTHER_BUILD_ID,
      revisionNumber: 1,
    });
    streamEvidenceSpy.mockClear();
    const foreignRowRes = await request(createApp()).get(
      `/api/builds/${BUILD_ID}/evidence/${OTHER_BUILD_ROW_ID}/red`,
    );
    expect(foreignRowRes.status).toBe(404);
    expect(streamEvidenceSpy).not.toHaveBeenCalled();

    // 4. Invalid slot "blue"
    const badSlotRes = await request(createApp()).get(
      `/api/builds/${BUILD_ID}/evidence/${ROW_PASS_ID}/blue`,
    );
    expect(badSlotRes.status).toBe(400);
  });

  it('VT-23: answers 200 on both routes when the build-from-prompt feature flag evaluates false for the project', async () => {
    isFeatureEnabled.mockResolvedValue(false);
    const prefix = buildEvidenceBlobPrefix(BUILD_ID, 3, 'AC-1');
    await fakeEvidenceStore.putEvidence(prefix, 'green', 'PASS src/__tests__/submit.test.ts');

    const matrixRes = await request(createApp()).get(
      `/api/builds/${BUILD_ID}/verification`,
    );
    const evidenceRes = await request(createApp()).get(
      `/api/builds/${BUILD_ID}/evidence/${ROW_PASS_ID}/green`,
    );

    expect(matrixRes.status).toBe(200);
    expect(evidenceRes.status).toBe(200);
    expect(evidenceRes.text).toBe('PASS src/__tests__/submit.test.ts');
  });

  it('VT-24: returns sorted rows, summary counts, and revisionNumbers with no container/key/url fields; supports ?revision=, 404 on revision=99, 400 on revision=abc', async () => {
    // Default (currentRevisionNumber = 3)
    const defaultRes = await request(createApp()).get(
      `/api/builds/${BUILD_ID}/verification`,
    );
    expect(defaultRes.status).toBe(200);
    expect(defaultRes.body.buildId).toBe(BUILD_ID);
    expect(defaultRes.body.revisionNumber).toBe(3);
    expect(defaultRes.body.revisionNumbers).toEqual([3, 2, 1]);
    expect(defaultRes.body.summary).toEqual({
      total: 5,
      pass: 2,
      fail: 1,
      deferred: 1,
      retired: 1,
    });

    // Order: non-retired by kind (ac, dod, br, nfr, risk_decision) then ID, with retired last
    expect(defaultRes.body.rows.map((r: { requirementId: string }) => r.requirementId)).toEqual([
      'AC-1',
      'AC-2',
      'NFR-1',
      'RD-1',
      'DOD-1',
    ]);

    const ac1Row = defaultRes.body.rows[0];
    expect(ac1Row).toEqual({
      id: ROW_PASS_ID,
      requirementId: 'AC-1',
      kind: 'ac',
      requirementText: 'Users can submit a request',
      tier: 'unit',
      status: 'pass',
      testReferences: [{ file: 'src/__tests__/submit.test.ts', name: 'AC-1: submits request' }],
      red: {
        commit: 'a1b2c3d',
        command: 'npx jest src/__tests__/submit.test.ts',
        exitCode: 1,
        recordedAt: '2026-11-03T09:55:00.000Z',
      },
      green: {
        commit: 'd4e5f6a',
        command: 'npx jest src/__tests__/submit.test.ts',
        exitCode: 0,
        recordedAt: '2026-11-03T09:58:00.000Z',
      },
      deferralReason: null,
    });

    const deferredRow = defaultRes.body.rows[2];
    expect(deferredRow.requirementId).toBe('NFR-1');
    expect(deferredRow.status).toBe('deferred');
    expect(deferredRow.deferralReason).toBe(
      'Playwright browser runner is not available in unit sandbox.',
    );

    // No container, key, url, or evidenceBlobRef anywhere in the serialized JSON
    const rawJson = JSON.stringify(defaultRes.body);
    expect(rawJson).not.toContain('"container"');
    expect(rawJson).not.toContain('"key"');
    expect(rawJson).not.toContain('"url"');
    expect(rawJson).not.toContain('"evidenceBlobRef"');

    // Explicit ?revision=1
    mockDb.query.buildVerificationRows.findMany.mockResolvedValueOnce([...rev1RowsFixture]);
    const rev1Res = await request(createApp()).get(
      `/api/builds/${BUILD_ID}/verification?revision=1`,
    );
    expect(rev1Res.status).toBe(200);
    expect(rev1Res.body.revisionNumber).toBe(1);
    expect(rev1Res.body.revisionNumbers).toEqual([3, 2, 1]);
    expect(rev1Res.body.summary).toEqual({
      total: 1,
      pass: 0,
      fail: 1,
      deferred: 0,
      retired: 0,
    });
    expect(rev1Res.body.rows[0].requirementText).toBe('Revision 1 requirement text');

    // Unknown revision=99 -> 404
    const unknownRevRes = await request(createApp()).get(
      `/api/builds/${BUILD_ID}/verification?revision=99`,
    );
    expect(unknownRevRes.status).toBe(404);

    // Invalid revision=abc -> 400
    const badRevRes = await request(createApp()).get(
      `/api/builds/${BUILD_ID}/verification?revision=abc`,
    );
    expect(badRevRes.status).toBe(400);
  });

  it('VT-25: enforces 401 with no session, 200 for a viewer role with builds:view, and 403 for a caller without builds:view on both routes', async () => {
    const prefix = buildEvidenceBlobPrefix(BUILD_ID, 3, 'AC-1');
    await fakeEvidenceStore.putEvidence(prefix, 'red', 'FAIL test output');

    // 1. No session -> 401 on both routes
    authenticatedUserOid = null;
    const unauthMatrix = await request(createApp()).get(
      `/api/builds/${BUILD_ID}/verification`,
    );
    const unauthEvidence = await request(createApp()).get(
      `/api/builds/${BUILD_ID}/evidence/${ROW_PASS_ID}/red`,
    );
    expect(unauthMatrix.status).toBe(401);
    expect(unauthEvidence.status).toBe(401);

    // 2. Viewer role with builds:view -> 200 on both routes
    authenticatedUserOid = 'viewer-user-oid';
    getAssignmentsForUser.mockResolvedValue(['ProjectB']);
    getUserPermissions.mockImplementation(async (_userId: string, project?: string) =>
      project === 'ProjectB' ? new Set(['builds:view']) : new Set<string>(),
    );
    const viewerMatrix = await request(createApp()).get(
      `/api/builds/${BUILD_ID}/verification`,
    );
    const viewerEvidence = await request(createApp()).get(
      `/api/builds/${BUILD_ID}/evidence/${ROW_PASS_ID}/red`,
    );
    expect(viewerMatrix.status).toBe(200);
    expect(viewerEvidence.status).toBe(200);

    // 3. Caller without builds:view -> 403 on both routes
    authenticatedUserOid = 'no-perm-user-oid';
    getAssignmentsForUser.mockResolvedValue(['ProjectB']);
    getUserPermissions.mockResolvedValue(new Set(['interviews:view']));
    const forbiddenMatrix = await request(createApp()).get(
      `/api/builds/${BUILD_ID}/verification`,
    );
    const forbiddenEvidence = await request(createApp()).get(
      `/api/builds/${BUILD_ID}/evidence/${ROW_PASS_ID}/red`,
    );
    expect(forbiddenMatrix.status).toBe(403);
    expect(forbiddenEvidence.status).toBe(403);
  });
});
