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
  resolveRequirementsPhaseMessageWrite,
  resolveTechnicalPhaseMessageWrite,
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

describe('resolveRequirementsPhaseMessageWrite (FEAT-004 / PBI-007)', () => {
  const requirementsOnly = {
    id: 'iv-1',
    phaseFlow: 'requirements_only',
    requirementsOwnerId: 'owner-1',
    requirementsPhaseStatus: 'draft',
  };

  beforeEach(() => {
    mockGetUserPermissions.mockResolvedValue(
      new Set(['interviews:view', 'interviews:manage']),
    );
  });

  it('AC-0 / VT-07: allows the assigned Requirements owner who did not start the thread', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue(requirementsOnly);

    const result = await resolveRequirementsPhaseMessageWrite('owner-1', 'thread-1');

    expect(result).toEqual({ outcome: 'allowed', thread: baseThread });
  });

  it('AC-3 / VT-06: denies a reader who is not the assigned Requirements owner', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue(requirementsOnly);
    mockGetUserPermissions.mockResolvedValue(new Set(['interviews:view']));

    expect(await resolveRequirementsPhaseMessageWrite('viewer-1', 'thread-1')).toEqual({
      outcome: 'not_owner',
    });
  });

  it('AC-3: denies the user who started the thread once the phase was reassigned', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue(requirementsOnly);

    expect(await resolveRequirementsPhaseMessageWrite('author-1', 'thread-1')).toEqual({
      outcome: 'not_owner',
    });
  });

  it('RBAC NFR: denies the assigned owner who lacks interviews:manage', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue(requirementsOnly);
    mockGetUserPermissions.mockResolvedValue(new Set(['interviews:view']));

    expect(await resolveRequirementsPhaseMessageWrite('owner-1', 'thread-1')).toEqual({
      outcome: 'missing_manage_permission',
    });
  });

  it('AC-3: guards both_sequential until the Requirements summary is approved', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...requirementsOnly,
      phaseFlow: 'both_sequential',
    });

    expect(await resolveRequirementsPhaseMessageWrite('viewer-1', 'thread-1')).toEqual({
      outcome: 'not_owner',
    });

    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...requirementsOnly,
      phaseFlow: 'both_sequential',
      requirementsPhaseStatus: 'approved',
    });

    expect(await resolveRequirementsPhaseMessageWrite('viewer-1', 'thread-1')).toEqual({
      outcome: 'not_applicable',
    });
  });

  it('VT-08: leaves technical-only, legacy, and non-interview threads to the existing write rules', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...requirementsOnly,
      phaseFlow: 'technical_only',
      requirementsOwnerId: null,
      requirementsPhaseStatus: null,
    });
    expect(await resolveRequirementsPhaseMessageWrite('author-1', 'thread-1')).toEqual({
      outcome: 'not_applicable',
    });

    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...requirementsOnly,
      phaseFlow: null,
      requirementsOwnerId: null,
      requirementsPhaseStatus: null,
    });
    expect(await resolveRequirementsPhaseMessageWrite('author-1', 'thread-1')).toEqual({
      outcome: 'not_applicable',
    });

    mockDb.query.interviews.findFirst.mockResolvedValue(null);
    expect(await resolveRequirementsPhaseMessageWrite('author-1', 'thread-1')).toEqual({
      outcome: 'not_applicable',
    });
  });

  it('reports a missing thread instead of allowing the owner through', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue(requirementsOnly);
    mockGetThread.mockResolvedValue(null);
    mockLoadFullThread.mockResolvedValue(null);

    expect(await resolveRequirementsPhaseMessageWrite('owner-1', 'thread-1')).toEqual({
      outcome: 'thread_not_found',
    });
  });
});

describe('resolveTechnicalPhaseMessageWrite (FEAT-005 / PBI-008)', () => {
  beforeEach(() => {
    mockGetUserPermissions.mockResolvedValue(
      new Set(['interviews:view', 'interviews:manage']),
    );
  });

  it('AC-3 / VT-06 allows only the assigned Technical owner with manage permission', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      id: 'iv-1',
      technicalOwnerId: 'technical-owner',
      technicalPhaseChatThreadId: 'thread-1',
    });

    await expect(
      resolveTechnicalPhaseMessageWrite('technical-owner', 'thread-1'),
    ).resolves.toEqual({ outcome: 'allowed', thread: baseThread });
    await expect(
      resolveTechnicalPhaseMessageWrite('manager', 'thread-1'),
    ).resolves.toEqual({ outcome: 'not_owner' });
  });

  it('NFR denies the assigned Technical owner without interviews:manage', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      id: 'iv-1',
      technicalOwnerId: 'technical-owner',
      technicalPhaseChatThreadId: 'thread-1',
    });
    mockGetUserPermissions.mockResolvedValue(new Set(['interviews:view']));

    await expect(
      resolveTechnicalPhaseMessageWrite('technical-owner', 'thread-1'),
    ).resolves.toEqual({ outcome: 'missing_manage_permission' });
  });

  it('leaves unrelated threads to the existing message-write rules', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue(null);
    await expect(
      resolveTechnicalPhaseMessageWrite('technical-owner', 'thread-1'),
    ).resolves.toEqual({ outcome: 'not_applicable' });
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
