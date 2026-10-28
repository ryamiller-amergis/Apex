/**
 * Unit tests for threadAccessService — document-scoped read vs owner write.
 */

import type { ChatThread } from '../../shared/types/chat';

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      interviews: { findFirst: jest.fn() },
      prds: { findFirst: jest.fn() },
      adrs: { findFirst: jest.fn() },
      designDocs: { findFirst: jest.fn() },
    },
  },
}));

jest.mock('../services/chatThreadRepository', () => ({
  loadFullThread: jest.fn(),
}));

jest.mock('../services/chatAgentService', () => ({
  getThread: jest.fn(),
}));

jest.mock('../services/rbacService', () => ({
  getUserPermissions: jest.fn(),
}));

jest.mock('../utils/rbacHelpers', () => ({
  isAdminUser: jest.fn(),
  isProjectAdmin: jest.fn(),
  isPlatformAdmin: jest.fn(),
}));

jest.mock('../services/documentApprovalService', () => ({
  isAssignedApprover: jest.fn(),
}));

import { db } from '../db/drizzle';
import { loadFullThread } from '../services/chatThreadRepository';
import { getThread } from '../services/chatAgentService';
import { getUserPermissions } from '../services/rbacService';
import { isAdminUser, isPlatformAdmin, isProjectAdmin } from '../utils/rbacHelpers';
import { isAssignedApprover } from '../services/documentApprovalService';
import {
  resolveThreadAccess,
  canWriteThread,
  canCreateDesignDocAssistantThread,
} from '../services/threadAccessService';

const mockLoadFullThread = loadFullThread as jest.Mock;
const mockGetThread = getThread as jest.Mock;
const mockGetUserPermissions = getUserPermissions as jest.Mock;
const mockIsAdminUser = isAdminUser as jest.Mock;
const mockIsProjectAdmin = isProjectAdmin as jest.Mock;
const mockIsPlatformAdmin = isPlatformAdmin as jest.Mock;
const mockIsAssignedApprover = isAssignedApprover as jest.Mock;

const mockDb = db as unknown as {
  query: {
    interviews: { findFirst: jest.Mock };
    prds: { findFirst: jest.Mock };
    adrs: { findFirst: jest.Mock };
    designDocs: { findFirst: jest.Mock };
  };
};

const baseThread: ChatThread = {
  id: 'thread-1',
  userId: 'author-1',
  status: 'idle',
  kickoff: { project: 'p', repo: 'r' },
  workspaceDir: '/tmp',
  flagged: false,
  messages: [{ id: 'm1', role: 'user', text: 'hi', ts: '2026-01-01T00:00:00Z' }],
  createdAt: '2026-01-01T00:00:00Z',
  lastActivityAt: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetThread.mockResolvedValue(baseThread);
  mockLoadFullThread.mockResolvedValue(baseThread);
  mockGetUserPermissions.mockResolvedValue(new Set(['interviews:view']));
  mockIsAdminUser.mockResolvedValue(false);
  mockIsProjectAdmin.mockResolvedValue(false);
  mockIsPlatformAdmin.mockResolvedValue(false);
  mockIsAssignedApprover.mockResolvedValue(false);
  mockDb.query.interviews.findFirst.mockResolvedValue(null);
  mockDb.query.prds.findFirst.mockResolvedValue(null);
  mockDb.query.adrs.findFirst.mockResolvedValue(null);
  mockDb.query.designDocs.findFirst.mockResolvedValue(null);
});

describe('resolveThreadAccess', () => {
  it('returns owner when the user owns the thread', async () => {
    const result = await resolveThreadAccess('author-1', 'thread-1');
    expect(result).toEqual({ access: 'owner', thread: baseThread });
  });

  it('returns read for a viewer with interviews:view on an interview-linked thread', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({ id: 'iv-1' });

    const result = await resolveThreadAccess('viewer-1', 'thread-1');

    expect(result).toEqual({ access: 'read', thread: baseThread });
  });

  it('returns read for adr:view on an ADR assistant thread', async () => {
    mockDb.query.adrs.findFirst.mockResolvedValue({
      id: 'adr-1',
      chatThreadId: 'interview-thread',
      adrAssistantThreadId: 'thread-1',
    });
    mockGetUserPermissions.mockResolvedValue(new Set(['adr:view']));

    const result = await resolveThreadAccess('viewer-1', 'thread-1');

    expect(result).toEqual({ access: 'read', thread: baseThread });
  });

  it('returns null for a viewer without interviews:view on a linked thread', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({ id: 'iv-1' });
    mockGetUserPermissions.mockResolvedValue(new Set());

    const result = await resolveThreadAccess('viewer-1', 'thread-1');

    expect(result).toBeNull();
  });

  it('returns null for a viewer on an unlinked standalone thread', async () => {
    const result = await resolveThreadAccess('viewer-1', 'thread-1');
    expect(result).toBeNull();
  });

  it('returns read for chat:view_all without interviews:view', async () => {
    mockGetUserPermissions.mockResolvedValue(new Set(['chat:view_all']));

    const result = await resolveThreadAccess('admin-chat', 'thread-1');

    expect(result).toEqual({ access: 'read', thread: baseThread });
  });

  it('returns null when the thread does not exist', async () => {
    mockGetThread.mockResolvedValue(null);
    mockLoadFullThread.mockResolvedValue(null);
    const result = await resolveThreadAccess('viewer-1', 'missing');
    expect(result).toBeNull();
  });
});

describe('canWriteThread', () => {
  it('allows the thread owner to write on an interview thread', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({ id: 'iv-1' });
    expect(await canWriteThread('author-1', 'thread-1')).toBe(true);
  });

  it('denies write for a viewer on an interview-linked thread', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({ id: 'iv-1' });
    expect(await canWriteThread('viewer-1', 'thread-1')).toBe(false);
  });

  it('allows a selected section owner to answer an interview', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      id: 'iv-1',
      authorId: 'author-1',
      project: 'Apex',
      testCaseOwnerId: 'qa-1',
    });
    expect(await canWriteThread('qa-1', 'thread-1')).toBe(true);
  });

  it('allows an assigned interview phase participant to answer', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      id: 'iv-1',
      authorId: 'author-1',
      project: 'Apex',
      deliveryAssigneeId: 'delivery-1',
    });
    expect(await canWriteThread('delivery-1', 'thread-1')).toBe(true);
  });

  it('allows a project admin to answer an interview', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      id: 'iv-1',
      authorId: 'author-1',
      project: 'Apex',
    });
    mockIsProjectAdmin.mockResolvedValue(true);
    expect(await canWriteThread('admin-1', 'thread-1')).toBe(true);
    expect(mockIsProjectAdmin).toHaveBeenCalledWith('admin-1', 'Apex');
  });

  it('allows a platform admin to answer an interview', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      id: 'iv-1',
      authorId: 'author-1',
      project: 'Apex',
    });
    mockIsPlatformAdmin.mockResolvedValue(true);
    expect(await canWriteThread('platform-1', 'thread-1')).toBe(true);
  });

  it('allows an assigned approver to write on a design-doc assistant thread', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue({
      id: 'doc-1',
      chatThreadId: null,
      qaChatThreadId: null,
      docAssistantThreadId: 'thread-1',
      validationThreadId: null,
    });
    mockIsAssignedApprover.mockResolvedValue(true);

    expect(await canWriteThread('approver-1', 'thread-1')).toBe(true);
    expect(mockIsAssignedApprover).toHaveBeenCalledWith('doc-1', 'design_doc', 'approver-1');
  });

  it('denies write for a viewer on a design-doc QA thread', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue({
      id: 'doc-1',
      chatThreadId: null,
      qaChatThreadId: 'thread-1',
      docAssistantThreadId: null,
      validationThreadId: null,
    });

    expect(await canWriteThread('viewer-1', 'thread-1')).toBe(false);
  });
});

describe('canCreateDesignDocAssistantThread', () => {
  it('allows the design doc author', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue({ authorId: 'author-1' });
    expect(await canCreateDesignDocAssistantThread('author-1', 'doc-1')).toBe(true);
  });

  it('allows admin', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue({ authorId: 'author-1' });
    mockIsAdminUser.mockResolvedValue(true);
    expect(await canCreateDesignDocAssistantThread('admin-1', 'doc-1')).toBe(true);
  });

  it('denies a viewer who is not author or admin', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue({ authorId: 'author-1' });
    expect(await canCreateDesignDocAssistantThread('viewer-1', 'doc-1')).toBe(false);
  });
});

describe('VT-13 — build-intake thread read narrowing (PBI-009 security NFR)', () => {
  const intakeThread: ChatThread = {
    ...baseThread,
    userId: 'requester-1',
    kickoff: {
      project: 'Apex',
      repo: 'org/target',
      playbookInterview: { runId: 'run-1', stepId: 'intake', snapshot: { key: 'build-intake', mode: 'human_led' } },
    } as ChatThread['kickoff'],
  };

  beforeEach(() => {
    mockGetThread.mockResolvedValue(intakeThread);
    mockDb.query.interviews.findFirst.mockResolvedValue({ id: 'iv-1' });
  });

  it('allows the requester as owner', async () => {
    await expect(resolveThreadAccess('requester-1', 'thread-1')).resolves.toEqual({ access: 'owner', thread: intakeThread });
  });

  it('allows a Project Admin of the build project', async () => {
    mockIsProjectAdmin.mockImplementation(async (_user: string, project: string) => project === 'Apex');
    await expect(resolveThreadAccess('pa-1', 'thread-1')).resolves.toEqual({ access: 'read', thread: intakeThread });
  });

  it('allows a Platform Admin', async () => {
    mockIsPlatformAdmin.mockResolvedValue(true);
    await expect(resolveThreadAccess('platform-1', 'thread-1')).resolves.toEqual({ access: 'read', thread: intakeThread });
  });

  it('refuses a member with interviews:view', async () => {
    mockGetUserPermissions.mockResolvedValue(new Set(['interviews:view']));
    await expect(resolveThreadAccess('member-1', 'thread-1')).resolves.toBeNull();
  });

  it('refuses a chat:view_all holder who is not a Project Admin', async () => {
    mockGetUserPermissions.mockResolvedValue(new Set(['chat:view_all']));
    await expect(resolveThreadAccess('viewer-all-1', 'thread-1')).resolves.toBeNull();
  });

  it('leaves a non-build interview thread on today\'s rules', async () => {
    mockGetThread.mockResolvedValue(baseThread);
    mockGetUserPermissions.mockResolvedValue(new Set(['interviews:view']));
    await expect(resolveThreadAccess('member-1', 'thread-1')).resolves.toEqual({ access: 'read', thread: baseThread });
  });
});

describe('VT-08 — build-intake write rule on the interview thread (TBI-010 DoD-0, DoD-1, DoD-3)', () => {
  const buildInterview = {
    id: 'iv-1',
    authorId: 'author-1',
    project: 'Apex',
    testCaseOwnerId: 'qa-1',
    deliveryAssigneeId: 'delivery-1',
    playbookProfileKey: 'build-intake',
  };

  beforeEach(() => {
    mockDb.query.interviews.findFirst.mockResolvedValue(buildInterview);
  });

  it('VT-08 allows a Project Admin of the interview project', async () => {
    mockIsProjectAdmin.mockImplementation(async (_user: string, project: string) => project === 'Apex');
    expect(await canWriteThread('pa-1', 'thread-1')).toBe(true);
  });

  it('VT-08 allows a Platform Admin', async () => {
    mockIsPlatformAdmin.mockResolvedValue(true);
    expect(await canWriteThread('platform-1', 'thread-1')).toBe(true);
  });

  it('VT-08 refuses a section owner and a phase assignee', async () => {
    expect(await canWriteThread('qa-1', 'thread-1')).toBe(false);
    expect(await canWriteThread('delivery-1', 'thread-1')).toBe(false);
  });

  it('VT-08 refuses a BA, Manager or Product Owner who is not the requester or an admin', async () => {
    mockGetUserPermissions.mockResolvedValue(new Set(['interviews:manage']));
    expect(await canWriteThread('ba-1', 'thread-1')).toBe(false);
  });

  it('VT-08 keeps section owners on a non-build interview', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({ ...buildInterview, playbookProfileKey: 'grill-with-docs' });
    expect(await canWriteThread('qa-1', 'thread-1')).toBe(true);
  });
});
