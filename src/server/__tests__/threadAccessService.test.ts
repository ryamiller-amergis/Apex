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
}));

jest.mock('../services/documentApprovalService', () => ({
  isAssignedApprover: jest.fn(),
}));

import { db } from '../db/drizzle';
import { loadFullThread } from '../services/chatThreadRepository';
import { getThread } from '../services/chatAgentService';
import { getUserPermissions } from '../services/rbacService';
import { isAdminUser } from '../utils/rbacHelpers';
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
