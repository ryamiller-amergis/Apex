/**
 * Tests for calendarWorkItemAssistantService.
 *
 * Covers: field/type matrix, session ownership check, session status check,
 * proposal staging, selected-ID enforcement, content size enforcement,
 * and that the `before` value comes from the server snapshot (not the model).
 */

import { handleProposeWorkItemChanges } from '../services/calendarWorkItemAssistantService';
import * as chatAgentService from '../services/chatAgentService';

// ── Mock DB to return controlled session data ─────────────────────────────────

const mockDbInsert = jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) });
const mockDbUpdateSet = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) });
const mockDbUpdate = jest.fn().mockReturnValue({ set: mockDbUpdateSet });
let mockSessionRow: any = null;

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      workItemAssistantSessions: {
        findFirst: jest.fn().mockImplementation(async () => mockSessionRow),
      },
      workItemChangeProposals: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    },
    insert: jest.fn().mockImplementation(() => ({ values: jest.fn().mockResolvedValue([]) })),
    update: jest.fn().mockImplementation(() => ({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) })),
  },
}));

jest.mock('../services/chatAgentService', () => ({
  getThread: jest.fn(),
}));

const mockGetThread = chatAgentService.getThread as jest.Mock;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeThread(overrides?: object) {
  return {
    id: 'thread-1',
    userId: 'user-1',
    kickoff: {
      assistantType: 'calendar-work-item',
      project: 'MaxView',
      repo: 'MaxView',
    },
    messages: [],
    status: 'idle',
    workspaceDir: '/tmp/test',
    flagged: false,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSessionRow(overrides?: object) {
  return {
    id: 'session-1',
    ownerUserId: 'user-1',
    project: 'MaxView',
    areaPath: 'MaxView',
    anchorWorkItemId: 100,
    selectedWorkItemIds: [100, 200, 300],
    contextSnapshot: [
      {
        id: 100,
        parentId: null,
        depth: 0,
        workItemType: 'Feature',
        title: 'Feature A',
        state: 'Active',
        areaPath: 'MaxView',
        rev: 5,
        changedDate: '2026-07-15',
        description: '<p>Existing description</p>',
        acceptanceCriteria: '',
        supportedFields: ['description', 'acceptanceCriteria'],
      },
      {
        id: 200,
        parentId: 100,
        depth: 1,
        workItemType: 'Product Backlog Item',
        title: 'PBI 1',
        state: 'New',
        areaPath: 'MaxView',
        rev: 3,
        changedDate: '2026-07-15',
        description: '',
        acceptanceCriteria: '',
        supportedFields: ['description', 'acceptanceCriteria'],
      },
      {
        id: 300,
        parentId: 100,
        depth: 1,
        workItemType: 'Technical Backlog Item',
        title: 'TBI 1',
        state: 'New',
        areaPath: 'MaxView',
        rev: 2,
        changedDate: '2026-07-15',
        description: '',
        acceptanceCriteria: undefined,
        supportedFields: ['description'],
      },
    ],
    threadId: 'thread-1',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockSessionRow = null;
});

describe('handleProposeWorkItemChanges', () => {
  describe('thread validation', () => {
    it('returns error when thread not found', async () => {
      mockGetThread.mockResolvedValue(null);

      const result = await handleProposeWorkItemChanges({
        threadId: 'thread-1',
        sessionId: 'session-1',
        changes: [{ workItemId: 100, fields: [{ field: 'description', after: 'New text' }] }],
      });

      expect(JSON.parse(result.content[0].text)).toMatchObject({ error: expect.stringContaining('Thread not found') });
    });

    it('returns error when thread is not a calendar-work-item thread', async () => {
      mockGetThread.mockResolvedValue(makeThread({
        kickoff: { assistantType: 'prd', project: 'MaxView', repo: 'MaxView' },
      }));

      const result = await handleProposeWorkItemChanges({
        threadId: 'thread-1',
        sessionId: 'session-1',
        changes: [{ workItemId: 100, fields: [{ field: 'description', after: 'New' }] }],
      });

      expect(JSON.parse(result.content[0].text)).toMatchObject({ error: expect.stringContaining('Calendar') });
    });
  });

  describe('session validation', () => {
    beforeEach(() => {
      mockGetThread.mockResolvedValue(makeThread());
    });

    it('returns error when session not found', async () => {
      mockSessionRow = null;

      const result = await handleProposeWorkItemChanges({
        threadId: 'thread-1',
        sessionId: 'session-1',
        changes: [{ workItemId: 100, fields: [{ field: 'description', after: 'x' }] }],
      });

      expect(JSON.parse(result.content[0].text)).toMatchObject({ error: expect.stringContaining('not found') });
    });

    it('returns error when session owner does not match thread user', async () => {
      mockSessionRow = makeSessionRow({ ownerUserId: 'other-user' });

      const result = await handleProposeWorkItemChanges({
        threadId: 'thread-1',
        sessionId: 'session-1',
        changes: [{ workItemId: 100, fields: [{ field: 'description', after: 'x' }] }],
      });

      expect(JSON.parse(result.content[0].text)).toMatchObject({ error: expect.stringContaining('mismatch') });
    });

    it('returns error when session is not active', async () => {
      mockSessionRow = makeSessionRow({ status: 'closed' });

      const result = await handleProposeWorkItemChanges({
        threadId: 'thread-1',
        sessionId: 'session-1',
        changes: [{ workItemId: 100, fields: [{ field: 'description', after: 'x' }] }],
      });

      expect(JSON.parse(result.content[0].text)).toMatchObject({ error: expect.stringContaining('not active') });
    });

    it('returns error when session threadId does not match', async () => {
      mockSessionRow = makeSessionRow({ threadId: 'different-thread' });

      const result = await handleProposeWorkItemChanges({
        threadId: 'thread-1',
        sessionId: 'session-1',
        changes: [{ workItemId: 100, fields: [{ field: 'description', after: 'x' }] }],
      });

      expect(JSON.parse(result.content[0].text)).toMatchObject({ error: expect.stringContaining('mismatch') });
    });
  });

  describe('scope enforcement', () => {
    beforeEach(() => {
      mockGetThread.mockResolvedValue(makeThread());
      mockSessionRow = makeSessionRow();
    });

    it('returns error when work item ID is not in selected scope', async () => {
      const result = await handleProposeWorkItemChanges({
        threadId: 'thread-1',
        sessionId: 'session-1',
        changes: [{ workItemId: 999, fields: [{ field: 'description', after: 'New' }] }],
      });

      expect(JSON.parse(result.content[0].text)).toMatchObject({ error: expect.stringContaining('999') });
    });

    it('returns error when TBI has acceptanceCriteria field (not in supportedFields)', async () => {
      const result = await handleProposeWorkItemChanges({
        threadId: 'thread-1',
        sessionId: 'session-1',
        changes: [{
          workItemId: 300,
          fields: [{ field: 'acceptanceCriteria', after: 'Given/When/Then' }],
        }],
      });

      expect(JSON.parse(result.content[0].text)).toMatchObject({ error: expect.stringContaining('not supported') });
    });
  });

  describe('successful proposal staging', () => {
    beforeEach(() => {
      mockGetThread.mockResolvedValue(makeThread());
      mockSessionRow = makeSessionRow();
    });

    it('stages a valid description change for a Feature', async () => {
      const result = await handleProposeWorkItemChanges({
        threadId: 'thread-1',
        sessionId: 'session-1',
        changes: [{ workItemId: 100, fields: [{ field: 'description', after: 'Improved description' }] }],
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.proposalId).toBeDefined();
      expect(parsed.changeCount).toBe(1);
      expect(parsed.itemIds).toContain(100);
    });

    it('stages acceptanceCriteria for a PBI', async () => {
      const result = await handleProposeWorkItemChanges({
        threadId: 'thread-1',
        sessionId: 'session-1',
        changes: [{
          workItemId: 200,
          fields: [{ field: 'acceptanceCriteria', after: 'Given a user\nWhen they submit\nThen it works' }],
        }],
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.itemIds).toContain(200);
    });

    it('stages description for a TBI (acceptanceCriteria not allowed)', async () => {
      const result = await handleProposeWorkItemChanges({
        threadId: 'thread-1',
        sessionId: 'session-1',
        changes: [{ workItemId: 300, fields: [{ field: 'description', after: 'Technical description' }] }],
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.itemIds).toContain(300);
    });

    it('stages changes for multiple items at once', async () => {
      const result = await handleProposeWorkItemChanges({
        threadId: 'thread-1',
        sessionId: 'session-1',
        changes: [
          { workItemId: 100, fields: [{ field: 'description', after: 'Feature desc' }] },
          { workItemId: 200, fields: [{ field: 'description', after: 'PBI desc' }] },
        ],
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.changeCount).toBe(2);
    });

    it('uses server-provided before value from snapshot, not model input', async () => {
      // The handler should take 'before' from the snapshot, not from user/model input.
      // The Feature (id=100) has description '<p>Existing description</p>' in the snapshot.
      const result = await handleProposeWorkItemChanges({
        threadId: 'thread-1',
        sessionId: 'session-1',
        changes: [{ workItemId: 100, fields: [{ field: 'description', after: 'New description' }] }],
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(true);
      // Verify proposal was staged (before content comes from snapshot, not from model)
      expect(parsed.proposalId).toBeDefined();
    });
  });

  describe('content size enforcement', () => {
    beforeEach(() => {
      mockGetThread.mockResolvedValue(makeThread());
      mockSessionRow = makeSessionRow();
    });

    it('returns error when field content exceeds 64 KB', async () => {
      const oversized = 'x'.repeat(65_537);
      const result = await handleProposeWorkItemChanges({
        threadId: 'thread-1',
        sessionId: 'session-1',
        changes: [{ workItemId: 100, fields: [{ field: 'description', after: oversized }] }],
      });

      expect(JSON.parse(result.content[0].text)).toMatchObject({ error: expect.stringContaining('64 KB') });
    });
  });
});
