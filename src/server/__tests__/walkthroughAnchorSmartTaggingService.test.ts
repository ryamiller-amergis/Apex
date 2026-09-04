/**
 * Unit tests for walkthroughAnchorSmartTaggingService (Wave 2 Track B).
 *
 * Coverage:
 *   - startSmartTagging Apex grounding + candidate kickoff
 *   - only newly discovered (pending/unknown) IDs
 *   - getSmartTaggingResult ready → parse + persist once
 *   - AI/parse failure → failed + warning, no persist
 *   - cancelSmartTagging → cancelRun + cancelled status
 */

import fs from 'fs';

jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      chatThreads: { findFirst: jest.fn() },
    },
  },
}));

jest.mock('../services/chatAgentService', () => ({
  createThread: jest.fn(),
  cancelRun: jest.fn(),
  isThreadIdle: jest.fn(),
  isThreadLoaded: jest.fn(),
  sendMessage: jest.fn(),
  prepareBackgroundWorkflowTurn: jest.fn().mockResolvedValue({
    prompt: 'Begin.',
    model: 'claude-sonnet-4',
    skillPath: '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md',
    projectId: 'Apex',
    threadWorkspacePath: '/tmp/thread',
    repository: {
      provider: 'github',
      project: 'Apex',
      repo: 'org/repo',
      branch: 'main',
    },
  }),
}));

jest.mock('../services/backgroundWorkflowRouter', () => ({
  routeBackgroundWorkflow: jest.fn(async (input: { runInProcess: () => void }) => {
    input.runInProcess();
    return { route: 'worker', workspacePath: '/tmp/thread', runId: 'run-1' };
  }),
}));

jest.mock('../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/projectSettingsService', () => ({
  resolveSkillConfig: jest.fn(),
}));

jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn(),
}));

jest.mock('../services/walkthroughAiOptionsService', () => ({
  getWalkthroughAiOptions: jest.fn().mockResolvedValue({
    id: 'default',
    walkthroughGenerationSkillPath: '.cursor/skills/walkthrough-generation/SKILL.md',
    walkthroughGenerationModel: '',
    anchorSmartTaggingSkillPath:
      '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md',
    anchorSmartTaggingModel: '',
    anchorDiscoverySkillPath: '.cursor/skills/walkthrough-anchor-discovery/SKILL.md',
    anchorDiscoveryModel: '',
    createdBy: 'system',
    createdByDisplayName: 'System',
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedBy: 'system',
    updatedByDisplayName: 'System',
    updatedAt: '2026-07-30T00:00:00.000Z',
  }),
}));

jest.mock('../services/walkthroughAnchorRegistryService', () => ({
  getAnchorByTestId: jest.fn(),
  listAnchors: jest.fn(),
  applySmartTagSuggestionsToPending: jest.fn(),
}));

import { db } from '../db/drizzle';
import {
  createThread,
  cancelRun,
  isThreadIdle,
  isThreadLoaded,
  sendMessage,
} from '../services/chatAgentService';
import { routeBackgroundWorkflow } from '../services/backgroundWorkflowRouter';
import { resolveSkillConfig } from '../services/projectSettingsService';
import { getDefaultModel } from '../services/appSettingsService';
import * as walkthroughAnchorRegistryService from '../services/walkthroughAnchorRegistryService';
import {
  startSmartTagging,
  getSmartTaggingResult,
  cancelSmartTagging,
  DEFAULT_WALKTHROUGH_ANCHOR_SMART_TAGGING_SKILL_PATH,
  WalkthroughAnchorSmartTaggingOrchestrationError,
  _resetForTests,
} from '../services/walkthroughAnchorSmartTaggingService';
import type { ProjectSkillConfig } from '../../shared/types/projectSettings';
import type { ChatThread } from '../../shared/types/chat';
import type { WalkthroughAnchorRegistryRecord } from '../../shared/types/walkthroughAnchorRegistry';

const mockedDb = db as unknown as {
  query: { chatThreads: { findFirst: jest.Mock } };
};
const mockedCreateThread = createThread as jest.MockedFunction<
  typeof createThread
>;
const mockedCancelRun = cancelRun as jest.MockedFunction<typeof cancelRun>;
const mockedIsThreadIdle = isThreadIdle as jest.MockedFunction<
  typeof isThreadIdle
>;
const mockedIsThreadLoaded = isThreadLoaded as jest.MockedFunction<
  typeof isThreadLoaded
>;
const mockedResolveSkillConfig = resolveSkillConfig as jest.MockedFunction<
  typeof resolveSkillConfig
>;
const mockedGetDefaultModel = getDefaultModel as jest.MockedFunction<
  typeof getDefaultModel
>;
const mockedRegistry = walkthroughAnchorRegistryService as jest.Mocked<
  typeof walkthroughAnchorRegistryService
>;

const USER_ID = 'user-1';
const THREAD_ID = 'thread-smart-1';

const FAKE_SKILL_CONFIG = {
  id: 'cfg-1',
  project: 'Apex',
  skillRepo: 'org/repo',
  skillBranch: 'main',
  skillProvider: 'github' as const,
  friendlyName: 'Default',
  isDefault: true,
  developmentModel: 'claude-sonnet-4',
  defaultModel: 'claude-sonnet-4',
};

const VALID_SMART_TAG_OUTPUT = JSON.stringify({
  suggestions: [
    {
      testId: 'new-candidate',
      anchorKey: 'new-candidate',
      suggestedLabel: 'New candidate',
      suggestedRoute: '/profile',
      allowedPlacements: ['bottom', 'top'],
      smartTags: ['profile', 'settings', 'section', 'edit'],
      confidence: 0.72,
      rationale: 'Found in ProfilePage.tsx near bio controls.',
    },
  ],
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  _resetForTests();
  mockedGetDefaultModel.mockResolvedValue('claude-sonnet-4');
  mockedResolveSkillConfig.mockResolvedValue(FAKE_SKILL_CONFIG as ProjectSkillConfig);
  mockedCreateThread.mockResolvedValue({ id: THREAD_ID } as ChatThread);
  mockedRegistry.getAnchorByTestId.mockResolvedValue(null);
  mockedRegistry.listAnchors.mockResolvedValue({
    items: [],
    nextCursor: null,
    counts: {
      total: 0,
      pending: 0,
      approved: 0,
      rejected: 0,
      active: 0,
      missing: 0,
    },
  });
  mockedRegistry.applySmartTagSuggestionsToPending.mockResolvedValue([]);
  mockedIsThreadIdle.mockReturnValue(false);
  mockedIsThreadLoaded.mockReturnValue(true);
  mockFs.existsSync.mockReturnValue(true);
  mockFs.readFileSync.mockReturnValue(VALID_SMART_TAG_OUTPUT);
});

async function startAndClearInFlight(
  candidates = [{ testId: 'new-candidate' }]
): Promise<void> {
  jest.useFakeTimers();
  await startSmartTagging({ candidates }, USER_ID);
  await jest.advanceTimersByTimeAsync(500);
  jest.useRealTimers();
}

describe('walkthroughAnchorSmartTaggingService', () => {
  describe('startSmartTagging', () => {
    it('creates an Apex-grounded Cursor thread with candidate kickoff context', async () => {
      const result = await startSmartTagging(
        {
          candidates: [
            {
              testId: 'new-candidate',
              sourceLocations: [
                { filePath: 'src/client/components/ProfilePage.tsx', line: 40 },
              ],
              sourceKind: 'data_testid',
            },
            { testId: 'new-candidate' },
          ],
        },
        USER_ID
      );

      expect(result.threadId).toBe(THREAD_ID);
      expect(result.candidateTestIds).toEqual(['new-candidate']);
      expect(result.provenance.provider).toBe('cursor');
      expect(result.provenance.skillPath).toBe(
        DEFAULT_WALKTHROUGH_ANCHOR_SMART_TAGGING_SKILL_PATH
      );
      expect(mockedResolveSkillConfig).toHaveBeenCalledWith({
        project: 'Apex',
      });
      expect(mockedCreateThread).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({
          project: 'Apex',
          repo: 'org/repo',
          branch: 'main',
          skillProvider: 'github',
          skillPath: DEFAULT_WALKTHROUGH_ANCHOR_SMART_TAGGING_SKILL_PATH,
          model: 'claude-sonnet-4',
          freeformContext: expect.stringContaining('new-candidate'),
        }),
        { skipAutoKickoff: true }
      );
      const ctx = mockedCreateThread.mock.calls[0][1].freeformContext as string;
      expect(ctx).toContain('## Accessible Page Modules');
      expect(ctx).toContain('src/client/components/PrdReviewView.tsx');
      expect(ctx).toContain('src/client/components/AgentHome.tsx');
      expect(ctx).toContain('src/client/components/AppHeader.tsx');
      expect(ctx).toContain('src/client/components/Changelog.tsx');
      expect(ctx).toContain('src/client/components/AdminRoles.tsx');
      expect(ctx).toContain('src/client/components/ProfilePage.tsx');
      expect(ctx).toContain('/backlog?tab=prds');
      expect(ctx).toContain('"key": "cloudcost"');
      expect(ctx).toContain('## Curated Routes');
      expect(ctx).toContain('## Existing Catalog Hints');
      expect(ctx).toContain('Use `suggestedLabel`');
      expect(ctx).toContain('Never emit a `label` field');
      expect(ctx).toContain('Never emit `tooltip`');
    });

    it('DoD-1 / DoD-2: enqueues walkthrough-smart-tagging in the background and never sends an in-process Cursor message', async () => {
      await startSmartTagging({ candidates: [{ testId: 'new-candidate' }] }, USER_ID);

      expect(routeBackgroundWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowClass: 'walkthrough-smart-tagging',
          threadId: THREAD_ID,
        }),
      );
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('DoD-1: chunks All leftovers internally at 50 per worker thread', async () => {
      const candidates = Array.from({ length: 51 }, (_, i) => ({
        testId: `anchor-${i}`,
      }));
      mockedCreateThread
        .mockResolvedValueOnce({ id: 'thread-a' } as ChatThread)
        .mockResolvedValueOnce({ id: 'thread-b' } as ChatThread);

      const result = await startSmartTagging({ candidates }, USER_ID);

      expect(result.candidateTestIds).toHaveLength(51);
      expect(mockedCreateThread).toHaveBeenCalledTimes(2);
      expect(routeBackgroundWorkflow).toHaveBeenCalledTimes(2);
    });

    it('filters out approved/rejected catalog rows (only newly discovered)', async () => {
      mockedRegistry.getAnchorByTestId.mockImplementation(
        async (testId: string) => {
          if (testId === 'approved-one') {
            return {
              id: '1',
              testId: 'approved-one',
              reviewStatus: 'approved',
            } as unknown as WalkthroughAnchorRegistryRecord;
          }
          return {
            id: '2',
            testId: 'pending-one',
            reviewStatus: 'pending',
          } as unknown as WalkthroughAnchorRegistryRecord;
        }
      );

      const result = await startSmartTagging(
        {
          candidates: [{ testId: 'approved-one' }, { testId: 'pending-one' }],
        },
        USER_ID
      );

      expect(result.candidateTestIds).toEqual(['pending-one']);
      const ctx = mockedCreateThread.mock.calls[0][1].freeformContext as string;
      expect(ctx).toContain('pending-one');
      expect(ctx).not.toContain('approved-one');
    });

    it('rejects empty candidates and invalid skillPath', async () => {
      await expect(
        startSmartTagging({ candidates: [] }, USER_ID)
      ).rejects.toBeInstanceOf(WalkthroughAnchorSmartTaggingOrchestrationError);
      await expect(
        startSmartTagging(
          { candidates: [{ testId: 'x' }], skillPath: '../../../etc/passwd' },
          USER_ID
        )
      ).rejects.toThrow(/skillPath must use a supported Agent Skills root/);
    });

    it('throws when Apex repo is not configured', async () => {
      mockedResolveSkillConfig.mockResolvedValue({ skillRepo: '' } as ProjectSkillConfig);
      await expect(
        startSmartTagging({ candidates: [{ testId: 'x' }] }, USER_ID)
      ).rejects.toThrow(/no connected repository/);
    });
  });

  describe('getSmartTaggingResult', () => {
    it('returns ready, parses output, and persists onto pending rows once', async () => {
      await startAndClearInFlight();
      mockedDb.query.chatThreads.findFirst.mockResolvedValue({
        userId: USER_ID,
        workspaceDir: '/tmp/ws',
        status: 'idle',
      });
      mockedRegistry.applySmartTagSuggestionsToPending.mockResolvedValue([
        {
          id: 'row-1',
          testId: 'new-candidate',
          label: 'New candidate',
          reviewStatus: 'pending',
        } as unknown as WalkthroughAnchorRegistryRecord,
      ]);

      const first = await getSmartTaggingResult(THREAD_ID, USER_ID);
      expect(first.status).toBe('ready');
      expect(first.result?.suggestions[0].testId).toBe('new-candidate');
      expect(first.updated).toHaveLength(1);
      expect(first.warning).toBeUndefined();
      expect(
        mockedRegistry.applySmartTagSuggestionsToPending
      ).toHaveBeenCalledTimes(1);
      expect(
        mockedRegistry.applySmartTagSuggestionsToPending
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          testIds: ['new-candidate'],
          actor: { id: USER_ID },
          provenanceBase: expect.objectContaining({
            provider: 'cursor',
            threadId: THREAD_ID,
          }),
        })
      );

      const second = await getSmartTaggingResult(THREAD_ID, USER_ID);
      expect(second.status).toBe('ready');
      expect(
        mockedRegistry.applySmartTagSuggestionsToPending
      ).toHaveBeenCalledTimes(1);
    });

    it('returns pending when workspace is not ready', async () => {
      await startAndClearInFlight();
      mockedDb.query.chatThreads.findFirst.mockResolvedValue({
        userId: USER_ID,
        workspaceDir: null,
        status: 'running',
      });
      const result = await getSmartTaggingResult(THREAD_ID, USER_ID);
      expect(result.status).toBe('pending');
    });

    it('fails clearly when agent memory was lost (e.g. server restart) with no output', async () => {
      await startAndClearInFlight();
      mockedDb.query.chatThreads.findFirst.mockResolvedValue({
        userId: USER_ID,
        workspaceDir: '/tmp/ws',
        status: 'running',
      });
      mockFs.existsSync.mockReturnValue(false);
      mockedIsThreadIdle.mockReturnValue(false);
      mockedIsThreadLoaded.mockReturnValue(false);

      const result = await getSmartTaggingResult(THREAD_ID, USER_ID);
      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/no longer running|restarted/i);
      expect(result.warning).toMatch(/remain pending and reviewable/i);
    });

    it('returns pending while in-memory agent is still working without output yet', async () => {
      await startAndClearInFlight();
      mockedDb.query.chatThreads.findFirst.mockResolvedValue({
        userId: USER_ID,
        workspaceDir: '/tmp/ws',
        status: 'running',
      });
      mockFs.existsSync.mockReturnValue(false);
      mockedIsThreadIdle.mockReturnValue(false);
      mockedIsThreadLoaded.mockReturnValue(true);

      const result = await getSmartTaggingResult(THREAD_ID, USER_ID);
      expect(result.status).toBe('pending');
    });

    it('names background routing as the cause when the batch was never dispatched to a worker', async () => {
      const mockedRoute = routeBackgroundWorkflow as jest.MockedFunction<
        typeof routeBackgroundWorkflow
      >;
      mockedRoute.mockResolvedValueOnce({
        route: 'in-process',
        reason: 'flag-disabled',
      });
      await startAndClearInFlight();
      mockedDb.query.chatThreads.findFirst.mockResolvedValue({
        userId: USER_ID,
        workspaceDir: '/tmp/ws',
        status: 'idle',
      });
      mockFs.existsSync.mockReturnValue(false);
      mockedIsThreadIdle.mockReturnValue(true);

      const result = await getSmartTaggingResult(THREAD_ID, USER_ID);

      expect(result.status).toBe('failed');
      expect(result.error).toContain('flag-disabled');
      expect(result.error).toMatch(/ai-runs-background/);
      expect(result.error).not.toMatch(/Agent completed/);
      expect(result.warning).toMatch(/remain pending and reviewable/i);
      expect(
        mockedRegistry.applySmartTagSuggestionsToPending
      ).not.toHaveBeenCalled();
    });

    it('on AI failure leaves rows reviewable with warning (no persist)', async () => {
      await startAndClearInFlight();
      mockedDb.query.chatThreads.findFirst.mockResolvedValue({
        userId: USER_ID,
        workspaceDir: '/tmp/ws',
        status: 'idle',
      });
      mockFs.existsSync.mockReturnValue(false);
      mockedIsThreadIdle.mockReturnValue(true);

      const result = await getSmartTaggingResult(THREAD_ID, USER_ID);
      expect(result.status).toBe('failed');
      expect(result.warning).toMatch(/remain pending and reviewable/i);
      expect(
        mockedRegistry.applySmartTagSuggestionsToPending
      ).not.toHaveBeenCalled();
    });

    it('returns failed+warning when output JSON is invalid', async () => {
      await startAndClearInFlight();
      mockedDb.query.chatThreads.findFirst.mockResolvedValue({
        userId: USER_ID,
        workspaceDir: '/tmp/ws',
        status: 'idle',
      });
      mockFs.readFileSync.mockReturnValue('not-json{{{');

      const result = await getSmartTaggingResult(THREAD_ID, USER_ID);
      expect(result.status).toBe('failed');
      expect(result.warning).toBeTruthy();
      expect(
        mockedRegistry.applySmartTagSuggestionsToPending
      ).not.toHaveBeenCalled();
    });

    it('applies partial AI batches and leaves missing candidates pending with a warning', async () => {
      await startAndClearInFlight([
        { testId: 'new-candidate' },
        { testId: 'second-candidate' },
      ]);
      mockedDb.query.chatThreads.findFirst.mockResolvedValue({
        userId: USER_ID,
        workspaceDir: '/tmp/ws',
        status: 'idle',
      });

      const result = await getSmartTaggingResult(THREAD_ID, USER_ID);

      expect(result.status).toBe('ready');
      expect(result.warning).toMatch(/partial batch \(1\/2\)/i);
      expect(result.warning).toContain('second-candidate');
      expect(
        mockedRegistry.applySmartTagSuggestionsToPending
      ).toHaveBeenCalledTimes(1);
    });

    it('on partial persist failure leaves catalog reviewable (failed + warning, no discard)', async () => {
      await startAndClearInFlight();
      mockedDb.query.chatThreads.findFirst.mockResolvedValue({
        userId: USER_ID,
        workspaceDir: '/tmp/ws',
        status: 'idle',
      });
      mockedRegistry.applySmartTagSuggestionsToPending.mockRejectedValue(
        new Error('DB write failed mid-batch')
      );

      const result = await getSmartTaggingResult(THREAD_ID, USER_ID);
      expect(result.status).toBe('failed');
      expect(result.warning).toMatch(/remain pending and reviewable/i);
      expect(result.result).toBeUndefined();
      expect(
        mockedRegistry.applySmartTagSuggestionsToPending
      ).toHaveBeenCalled();
    });
  });

  describe('cancelSmartTagging', () => {
    it('calls cancelRun and returns cancelled on subsequent poll', async () => {
      await startSmartTagging(
        { candidates: [{ testId: 'new-candidate' }] },
        USER_ID
      );
      mockedDb.query.chatThreads.findFirst.mockResolvedValue({
        userId: USER_ID,
        workspaceDir: '/tmp/ws',
        status: 'running',
      });

      await cancelSmartTagging(THREAD_ID, USER_ID);
      expect(mockedCancelRun).toHaveBeenCalledWith(THREAD_ID);

      const result = await getSmartTaggingResult(THREAD_ID, USER_ID);
      expect(result.status).toBe('cancelled');
    });
  });
});
