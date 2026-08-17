/**
 * Integration tests for FEAT-003 turn-path linked-context materialization.
 * Covers VT-07 (pre-turn hook writes document) and VT-08 (Interview-scoped actor).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const mockGetLinkedContext = jest.fn();
const mockGetAdr = jest.fn();
const mockGetModuleById = jest.fn();
const mockTrackEvent = jest.fn();
const mockInterviewFindFirst = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      interviews: {
        findFirst: (...a: unknown[]) => mockInterviewFindFirst(...a),
      },
    },
  },
}));

jest.mock('../services/interviewLinkService', () => ({
  getLinkedContext: (...a: unknown[]) => mockGetLinkedContext(...a),
}));

jest.mock('../services/adrService', () => ({
  getAdr: (...a: unknown[]) => mockGetAdr(...a),
}));

jest.mock('../services/designModuleService', () => ({
  getModuleById: (...a: unknown[]) => mockGetModuleById(...a),
}));

jest.mock('../services/telemetry', () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import {
  LINKED_CONTEXT_DOCUMENT_RELATIVE_PATH,
  materializeLinkedContextForInterviewThread,
} from '../services/linkedContextMaterializerService';

const THREAD_ID = 'thread-1111-1111-1111-111111111111';
const INTERVIEW_ID = 'interview-2222-2222-2222-222222222222';
const ADR_ID = 'adr-3333-3333-3333-333333333333';
const MODULE_ID = 'mod-4444-4444-4444-444444444444';
const USER_ID = 'user-manager';

function documentPath(workspaceDir: string): string {
  return path.join(workspaceDir, ...LINKED_CONTEXT_DOCUMENT_RELATIVE_PATH.split('/'));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('materializeLinkedContextForInterviewThread — VT-07 / VT-08', () => {
  it('VT-07: materializes into workspace before turn when Interview row exists', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-turn-'));
    mockInterviewFindFirst.mockResolvedValue({ id: INTERVIEW_ID });
    mockGetLinkedContext.mockResolvedValue({
      interviewId: INTERVIEW_ID,
      adrLinks: [
        {
          adrId: ADR_ID,
          title: 'Accepted ADR',
          isAccepted: true,
          linkedBy: USER_ID,
          linkedAt: '2026-08-06T00:00:00.000Z',
        },
      ],
      designModuleLinks: [
        {
          designModuleId: MODULE_ID,
          name: 'Auth Module',
          linkedBy: USER_ID,
          linkedAt: '2026-08-06T00:00:00.000Z',
        },
      ],
      count: 2,
      capacity: 10,
    });
    mockGetAdr.mockResolvedValue({
      id: ADR_ID,
      title: 'Accepted ADR',
      status: 'accepted',
      content: 'Live ADR body for turn',
    });
    mockGetModuleById.mockResolvedValue({
      id: MODULE_ID,
      label: 'Auth Module',
      description: 'Auth boundary',
      content: 'Module documentation',
      sourceGlobs: ['src/server/services/rbacService.ts'],
    });

    const started = Date.now();
    const result = await materializeLinkedContextForInterviewThread({
      threadId: THREAD_ID,
      workspaceDir,
      userId: USER_ID,
      isInterviewThread: true,
    });
    const durationMs = Date.now() - started;

    expect(result?.outcome).toBe('written');
    expect(durationMs).toBeLessThan(2000);
    expect(fs.existsSync(documentPath(workspaceDir))).toBe(true);
    const body = fs.readFileSync(documentPath(workspaceDir), 'utf8');
    expect(body).toContain('Live ADR body for turn');
    expect(body).toContain('Module documentation');
    expect(body).toContain('src/server/services/rbacService.ts');

    // Looked up Interview by chat thread id (turn path).
    expect(mockInterviewFindFirst).toHaveBeenCalled();
  });

  it('VT-08: derives scope via Interview + actor userId (never client-supplied project)', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-scope-'));
    mockInterviewFindFirst.mockResolvedValue({ id: INTERVIEW_ID });
    mockGetLinkedContext.mockResolvedValue({
      interviewId: INTERVIEW_ID,
      adrLinks: [],
      designModuleLinks: [],
      count: 0,
      capacity: 10,
    });

    await materializeLinkedContextForInterviewThread({
      threadId: THREAD_ID,
      workspaceDir,
      userId: USER_ID,
      isInterviewThread: true,
    });

    expect(mockGetLinkedContext).toHaveBeenCalledWith(INTERVIEW_ID, {
      userId: USER_ID,
    });
    // getLinkedContext owns project isolation from the Interview record — no project arg accepted.
    const args = mockGetLinkedContext.mock.calls[0];
    expect(args).toHaveLength(2);
    expect(args[1]).not.toHaveProperty('project');
  });

  it('skips when thread is not interview-backed', async () => {
    const result = await materializeLinkedContextForInterviewThread({
      threadId: THREAD_ID,
      workspaceDir: os.tmpdir(),
      userId: USER_ID,
      isInterviewThread: false,
    });
    expect(result).toBeNull();
    expect(mockInterviewFindFirst).not.toHaveBeenCalled();
    expect(mockGetLinkedContext).not.toHaveBeenCalled();
  });

  it('skips when interview-like thread has no interviews row (e.g. ADR)', async () => {
    mockInterviewFindFirst.mockResolvedValue(undefined);
    const result = await materializeLinkedContextForInterviewThread({
      threadId: THREAD_ID,
      workspaceDir: os.tmpdir(),
      userId: USER_ID,
      isInterviewThread: true,
    });
    expect(result).toBeNull();
    expect(mockGetLinkedContext).not.toHaveBeenCalled();
  });
});

describe('chatAgentService turn-path wiring — VT-07 source check', () => {
  it('sendMessage invokes materializeLinkedContextForInterviewThread after repository prep', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../services/chatAgentService.ts'),
      'utf8',
    );
    expect(source).toContain('materializeLinkedContextForInterviewThread');
    expect(source).toContain("await import(");
    expect(source).toContain('./linkedContextMaterializerService');
    // Hook sits after prepareRepositoryReadRuntime in the turn path.
    const prepIdx = source.indexOf('prepareRepositoryReadRuntime');
    const matIdx = source.indexOf('materializeLinkedContextForInterviewThread');
    expect(prepIdx).toBeGreaterThan(-1);
    expect(matIdx).toBeGreaterThan(prepIdx);
  });
});
