/**
 * Unit tests for walkthroughGenerationService (FEAT-004 step 3)
 *
 * Coverage:
 *   - startGeneration happy path: creates thread, returns provenance
 *   - startGeneration rejects missing projectId / intent
 *   - startGeneration rejects invalid skillPath
 *   - startGeneration throws when no skillRepo configured
 *   - tag-aware ranking injected into kickoff + start response (Phase 7)
 *   - getGenerationResult returns ready with valid JSON
 *   - getGenerationResult returns pending when no workspace
 *   - getGenerationResult returns failed when idle with no output
 *   - getGenerationResult returns cancelled after cancelGeneration
 *   - cancelGeneration calls cancelRun and marks cancelled
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

jest.mock('../services/walkthroughAiDraftService', () => ({
  listPublicWalkthroughAssetPaths: jest.fn().mockReturnValue(['/favicon.svg', '/brand-lockup.svg']),
  parseGeneratedWalkthroughProposal: jest.fn().mockReturnValue({
    proposal: {
      proposalId: 'proposal-1',
      walkthroughFields: {
        internalName: 'test-walkthrough',
        userTitle: 'Test Walkthrough',
        whyItMatters: 'For testing',
      },
      steps: [],
      units: [],
      generatedAt: '2026-07-29T00:00:00.000Z',
      generationContextVersion: 'context-1',
      policyPreset: 'A',
    },
    registryRejectionCount: 0,
  }),
}));

jest.mock('../services/walkthroughAnchorRegistryService', () => ({
  listAnchors: jest.fn(),
  listAuthoringAnchorEntries: jest.fn(),
}));

import { db } from '../db/drizzle';
import { createThread, cancelRun, isThreadIdle } from '../services/chatAgentService';
import { resolveSkillConfig } from '../services/projectSettingsService';
import { getDefaultModel } from '../services/appSettingsService';
import {
  listAnchors,
  listAuthoringAnchorEntries,
} from '../services/walkthroughAnchorRegistryService';
import { parseGeneratedWalkthroughProposal } from '../services/walkthroughAiDraftService';
import { listWalkthroughAnchors } from '../../shared/walkthroughAnchors';
import {
  WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS,
  type WalkthroughAnchorRegistryRecord,
} from '../../shared/types/walkthroughAnchorRegistry';
import {
  startGeneration,
  getGenerationResult,
  cancelGeneration,
  DEFAULT_WALKTHROUGH_GENERATION_SKILL_PATH,
  DEFAULT_GENERATION_ANCHOR_RANK_LIMIT,
  buildGenerationAnchorRankingQuery,
  buildWalkthroughGenerationAnchorRanking,
  formatAnchorRankingForKickoff,
  annotateProposalStepsWithAnchorMatch,
  _resetForTests,
} from '../services/walkthroughGenerationService';
import { DEFAULT_ANCHOR_AUTO_SELECT_SCORE_THRESHOLD } from '../services/walkthroughAnchorTagRanking';
import { WalkthroughAiError } from '../../shared/types/walkthroughAiDraft';
import type { ProjectSkillConfig } from '../../shared/types/projectSettings';
import type { ChatThread } from '../../shared/types/chat';
import type { WalkthroughAnchorRegistryEntry } from '../../shared/walkthroughAnchors';

const mockedDb = db as unknown as {
  query: { chatThreads: { findFirst: jest.Mock } };
};
const mockedCreateThread = createThread as jest.MockedFunction<typeof createThread>;
const mockedCancelRun = cancelRun as jest.MockedFunction<typeof cancelRun>;
const mockedIsThreadIdle = isThreadIdle as jest.MockedFunction<typeof isThreadIdle>;
const mockedResolveSkillConfig = resolveSkillConfig as jest.MockedFunction<typeof resolveSkillConfig>;
const mockedGetDefaultModel = getDefaultModel as jest.MockedFunction<typeof getDefaultModel>;
const mockedListAnchors = listAnchors as jest.MockedFunction<typeof listAnchors>;
const mockedListAuthoringAnchorEntries = listAuthoringAnchorEntries as jest.MockedFunction<
  typeof listAuthoringAnchorEntries
>;
const mockedParseProposal = parseGeneratedWalkthroughProposal as jest.MockedFunction<
  typeof parseGeneratedWalkthroughProposal
>;

/** Catalog-only key that must NOT appear in static DOM markers. */
const DB_ONLY_AUTHORING_ENTRY = {
  key: 'db-only-settings-cta',
  testId: 'db-only-settings-cta',
  label: 'DB-only Settings CTA',
  targetRoute: '/profile',
  allowedPlacements: ['bottom', 'top'] as const,
  smartTags: ['settings', 'modal'],
  openerAnchorKeys: ['user-menu-trigger'] as const,
  sourceLocations: [
    { filePath: 'src/client/components/ProfileSettingsModal.tsx', line: 42 },
  ],
};

function authoringCatalogFromBaseline() {
  return [
    ...WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS.map((seed) => ({
      key: seed.anchorKey,
      testId: seed.testId,
      label: seed.label,
      targetRoute: seed.approvedRoute ?? seed.suggestedRoute ?? '',
      allowedPlacements: seed.allowedPlacements,
      smartTags: seed.smartTags,
      openerAnchorKeys: seed.openerAnchorKeys ?? [],
      sourceLocations: seed.sourceLocations,
    })),
    DB_ONLY_AUTHORING_ENTRY,
  ];
}
const PROJECT_ID = 'Apex';
const USER_ID = 'user-1';
const THREAD_ID = 'thread-1';
const EARLIER = '2026-07-28T12:00:00.000Z';

const FAKE_SKILL_CONFIG = {
  id: 'cfg-1',
  project: PROJECT_ID,
  skillRepo: 'org/repo',
  skillBranch: 'main',
  skillProvider: 'github' as const,
  friendlyName: 'Default',
  isDefault: true,
  developmentModel: 'claude-sonnet-4',
  defaultModel: 'claude-sonnet-4',
};

function seedToRecord(
  seed: (typeof WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS)[number],
  index: number,
  overrides: Partial<WalkthroughAnchorRegistryRecord> = {},
): WalkthroughAnchorRegistryRecord {
  return {
    id: `gen-rank-${String(index + 1).padStart(2, '0')}`,
    anchorKey: seed.anchorKey,
    testId: seed.testId,
    label: seed.label,
    suggestedRoute: seed.suggestedRoute,
    approvedRoute: seed.approvedRoute,
    allowedPlacements: seed.allowedPlacements,
    smartTags: seed.smartTags,
    openerAnchorKeys: seed.openerAnchorKeys ?? [],
    sourceKind: seed.sourceKind,
    sourceLocations: seed.sourceLocations,
    sourceHash: seed.sourceHash,
    reviewStatus: seed.reviewStatus,
    isActive: seed.isActive,
    lastSeenAt: EARLIER,
    missingSince: null,
    deletedAt: null,
    aiProvenance: null,
    createdBy: seed.createdBy,
    createdAt: EARLIER,
    updatedBy: seed.updatedBy,
    updatedAt: EARLIER,
    ...overrides,
  };
}

function baselineCatalog(): WalkthroughAnchorRegistryRecord[] {
  return WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS.map((seed, i) => seedToRecord(seed, i));
}

function mockCatalogPage(items: WalkthroughAnchorRegistryRecord[]): void {
  mockedListAnchors.mockResolvedValue({
    items,
    nextCursor: null,
    counts: {
      total: items.length,
      pending: 0,
      approved: items.length,
      rejected: 0,
      active: items.length,
      missing: 0,
    },
  });
}

const VALID_OUTPUT = JSON.stringify({
  internalName: 'test-walkthrough',
  userTitle: 'Test Walkthrough',
  whyItMatters: 'For testing',
  steps: [
    {
      heading: 'Step 1',
      bodyMarkdown: 'First step',
      route: '/home',
      imageUrl: null,
      imageAlt: null,
      ctaLabel: null,
      ctaRoute: null,
      anchorKey: null,
      anchorPlacement: null,
    },
  ],
});

beforeEach(() => {
  jest.clearAllMocks();
  _resetForTests();
  mockedGetDefaultModel.mockResolvedValue('claude-sonnet-4');
  mockedResolveSkillConfig.mockResolvedValue(FAKE_SKILL_CONFIG as ProjectSkillConfig);
  mockedCreateThread.mockResolvedValue({ id: THREAD_ID } as ChatThread);
  mockCatalogPage(baselineCatalog());
  mockedListAuthoringAnchorEntries.mockResolvedValue(authoringCatalogFromBaseline() as WalkthroughAnchorRegistryEntry[]);
  // Re-assert factory default after clearAllMocks so parallel workers cannot drop it.
  mockedParseProposal.mockReturnValue({
    proposal: {
      proposalId: 'proposal-1',
      walkthroughFields: {
        internalName: 'test-walkthrough',
        userTitle: 'Test Walkthrough',
        whyItMatters: 'For testing',
      },
      steps: [],
      units: [],
      generatedAt: '2026-07-29T00:00:00.000Z',
      generationContextVersion: 'context-1',
      policyPreset: 'A',
    },
    registryRejectionCount: 0,
  });
  mockFs.existsSync.mockReturnValue(true);
  mockFs.readFileSync.mockReturnValue(
    '# Walkthrough Generation Skill\nTest content',
  );
});

describe('walkthroughGenerationService', () => {
  describe('startGeneration', () => {
    it('creates thread with correct parameters and returns provenance', async () => {
      const result = await startGeneration(
        { projectId: PROJECT_ID, intent: 'Create a tour of the profile page' },
        USER_ID,
      );

      expect(result.threadId).toBe(THREAD_ID);
      expect(result.provenance.provider).toBe('cursor');
      expect(result.provenance.model).toBe('claude-sonnet-4');
      expect(result.provenance.skillPath).toBe(DEFAULT_WALKTHROUGH_GENERATION_SKILL_PATH);
      expect(result.provenance.threadId).toBe(THREAD_ID);
      expect(mockedCreateThread).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({
          project: PROJECT_ID,
          repo: 'org/repo',
          branch: 'main',
          skillProvider: 'github',
          skillPath: DEFAULT_WALKTHROUGH_GENERATION_SKILL_PATH,
          model: 'claude-sonnet-4',
        }),
      );
    });

    it('uses the Apex repository connection when the walkthrough targets another project', async () => {
      await startGeneration(
        { projectId: 'Customer Portal', intent: 'Create a feature tour' },
        USER_ID,
      );

      expect(mockedResolveSkillConfig).toHaveBeenCalledWith({ project: 'Apex' });
      expect(mockedCreateThread).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({
          project: 'Apex',
          repo: 'org/repo',
          freeformContext: expect.stringContaining(
            '**Walkthrough target project:** Customer Portal',
          ),
        }),
      );
    });

    it('falls back to the local Apex Git remote outside deployed environments', async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      mockedResolveSkillConfig.mockResolvedValue({ skillRepo: '' } as ProjectSkillConfig);
      mockFs.readFileSync.mockImplementation(((filePath: fs.PathOrFileDescriptor) => {
        const value = String(filePath).replace(/\\/g, '/');
        if (value.endsWith('/.git/config')) {
          return [
            '[remote "origin"]',
            '  url = https://github.com/ryamiller-amergis/Scrum.git',
          ].join('\n');
        }
        if (value.endsWith('/.git/HEAD')) {
          return 'ref: refs/heads/feature/walkthroughs';
        }
        return '';
      }) as typeof fs.readFileSync);

      try {
        await startGeneration(
          { projectId: 'Customer Portal', intent: 'Create a feature tour' },
          USER_ID,
        );
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }

      expect(mockedCreateThread).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({
          project: 'Apex',
          repo: 'ryamiller-amergis/Scrum',
          branch: 'feature/walkthroughs',
          skillProvider: 'github',
        }),
      );
    });

    it('uses client-supplied model override', async () => {
      await startGeneration(
        { projectId: PROJECT_ID, intent: 'test', model: 'gpt-4o' },
        USER_ID,
      );
      expect(mockedCreateThread).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({ model: 'gpt-4o' }),
      );
    });

    it('uses client-supplied skillPath override', async () => {
      await startGeneration(
        {
          projectId: PROJECT_ID,
          intent: 'test',
          skillPath: '.cursor/skills/custom-gen/SKILL.md',
        },
        USER_ID,
      );
      expect(mockedCreateThread).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({
          skillPath: '.cursor/skills/custom-gen/SKILL.md',
        }),
      );
    });

    it('rejects missing projectId', async () => {
      await expect(
        startGeneration({ projectId: '', intent: 'test' }, USER_ID),
      ).rejects.toThrow(WalkthroughAiError);
    });

    it('rejects missing intent', async () => {
      await expect(
        startGeneration({ projectId: PROJECT_ID, intent: '' }, USER_ID),
      ).rejects.toThrow(WalkthroughAiError);
    });

    it('rejects invalid skillPath', async () => {
      await expect(
        startGeneration(
          { projectId: PROJECT_ID, intent: 'test', skillPath: '../../../etc/passwd' },
          USER_ID,
        ),
      ).rejects.toThrow('skillPath must match .cursor/skills/*/SKILL.md');
    });

    it('throws when no skillRepo configured', async () => {
      mockedResolveSkillConfig.mockResolvedValue({ skillRepo: '' } as ProjectSkillConfig);
      await expect(
        startGeneration({ projectId: PROJECT_ID, intent: 'test' }, USER_ID),
      ).rejects.toThrow('Apex project has no connected repository');
    });

    it('loads approved+active catalog, ranks by tags, and returns recommendations', async () => {
      const intent = 'profile bio section edit settings';
      const result = await startGeneration(
        {
          projectId: PROJECT_ID,
          intent,
          existingDraft: {
            steps: [
              {
                heading: 'Profile — Bio',
                bodyMarkdown: 'Edit the profile bio section settings.',
                route: '/profile',
                ordinal: 0,
              },
            ],
          },
        },
        USER_ID,
      );

      expect(mockedListAnchors).toHaveBeenCalledWith(
        expect.objectContaining({
          reviewStatus: 'approved',
          isActive: true,
        }),
      );
      expect(result.anchorRanking.autoSelectThreshold).toBe(
        DEFAULT_ANCHOR_AUTO_SELECT_SCORE_THRESHOLD,
      );
      expect(result.anchorRanking.rankedCandidates.length).toBeGreaterThan(0);
      expect(result.anchorRanking.rankedCandidates.length).toBeLessThanOrEqual(
        DEFAULT_GENERATION_ANCHOR_RANK_LIMIT,
      );
      expect(result.anchorRanking.rankedCandidates[0].anchorKey).toBe('profile-bio');
      expect(result.anchorRanking.autoSelectedAnchor?.anchorKey).toBe('profile-bio');
      expect(result.anchorRanking.autoSelectedAnchor?.score).toBeGreaterThanOrEqual(
        DEFAULT_ANCHOR_AUTO_SELECT_SCORE_THRESHOLD,
      );

      const freeform = mockedCreateThread.mock.calls[0][1].freeformContext as string;
      expect(freeform).toContain('## Ranked Catalog Anchor Candidates');
      expect(freeform).toContain('profile-bio');
      expect(freeform).toContain('"score"');
      expect(freeform).toContain('"evidence"');
      expect(freeform).toContain('### Auto-selected Anchor');
      expect(freeform).toContain('## Authoring Catalog Anchors (approved + active allow-list)');
      expect(freeform).toContain(DB_ONLY_AUTHORING_ENTRY.key);
      expect(freeform).toContain('"openerAnchorKeys"');
      expect(freeform).toContain('"user-menu-trigger"');
      expect(freeform).toContain('"testId"');
      expect(freeform).toContain('"sourceLocations"');
      expect(freeform).toContain('ProfileSettingsModal.tsx');
      expect(freeform).toContain('prefer a visible alternative or a centered step');
      // Regression: kickoff allow-list must come from DB authoring catalog, not DOM markers only.
      expect(listWalkthroughAnchors().some((a) => a.key === DB_ONLY_AUTHORING_ENTRY.key)).toBe(
        false,
      );
      expect(mockedListAuthoringAnchorEntries).toHaveBeenCalled();
    });

    it('exposes ranked recommendations without auto-select when below threshold', async () => {
      const result = await startGeneration(
        {
          projectId: PROJECT_ID,
          intent: 'xyzzy unrelated jargon with no catalog overlap',
        },
        USER_ID,
      );

      expect(result.anchorRanking.rankedCandidates.length).toBeGreaterThan(0);
      expect(result.anchorRanking.autoSelectedAnchor).toBeNull();

      const freeform = mockedCreateThread.mock.calls[0][1].freeformContext as string;
      expect(freeform).toContain('## Ranked Catalog Anchor Candidates');
      expect(freeform).toContain('None — choose from ranked recommendations during staged review');
    });

    it('continues generation when catalog ranking load fails', async () => {
      mockedListAnchors.mockRejectedValue(new Error('catalog unavailable'));

      const result = await startGeneration(
        { projectId: PROJECT_ID, intent: 'Create a tour of the profile page' },
        USER_ID,
      );

      expect(result.threadId).toBe(THREAD_ID);
      expect(result.anchorRanking.rankedCandidates).toEqual([]);
      expect(result.anchorRanking.autoSelectedAnchor).toBeNull();
    });
  });

  describe('tag-aware ranking helpers', () => {
    it('builds ranking query from intent plus existing draft route/heading/body', () => {
      expect(
        buildGenerationAnchorRankingQuery({
          projectId: PROJECT_ID,
          intent: 'Tour the profile theme controls',
          existingDraft: {
            steps: [
              {
                heading: 'Theme',
                bodyMarkdown: 'Open appearance settings.',
                route: '/profile',
                ordinal: 0,
              },
            ],
          },
        }),
      ).toEqual({
        route: '/profile',
        intent: 'Tour the profile theme controls',
        heading: 'Theme',
        body: 'Open appearance settings.',
      });
    });

    it('ranks catalog fixtures and formats kickoff payload with scores/evidence', () => {
      const ranking = buildWalkthroughGenerationAnchorRanking(baselineCatalog(), {
        projectId: PROJECT_ID,
        intent: 'profile bio section edit settings',
        existingDraft: {
          steps: [
            {
              heading: 'Profile — Bio',
              bodyMarkdown: 'Edit the profile bio section settings.',
              route: '/profile',
              ordinal: 0,
            },
          ],
        },
      });

      expect(ranking.rankedCandidates[0].anchorKey).toBe('profile-bio');
      expect(ranking.autoSelectedAnchor?.anchorKey).toBe('profile-bio');
      expect(ranking.autoSelectThreshold).toBe(DEFAULT_ANCHOR_AUTO_SELECT_SCORE_THRESHOLD);

      const markdown = formatAnchorRankingForKickoff(ranking);
      expect(markdown).toContain('## Ranked Catalog Anchor Candidates');
      expect(markdown).toContain('profile-bio');
      expect(markdown).toContain('matchedTags');
      expect(markdown).toContain('"autoSelectedAnchor"');
    });
  });

  describe('annotateProposalStepsWithAnchorMatch', () => {
    it('trusts any AI-selected anchor; only anchorless steps are belowThreshold', () => {
      const ranking = {
        rankedCandidates: [
          {
            anchorKey: 'profile-bio',
            testId: 'profile-bio',
            label: 'Profile bio',
            approvedRoute: '/profile',
            allowedPlacements: ['bottom'] as const,
            smartTags: ['profile'],
            score: 0.9,
            evidence: {
              routeCompatible: true,
              routeExactMatch: true,
              matchedTags: ['profile'],
              matchedLabelTokens: ['profile'],
              queryTokens: ['profile'],
              overlapRatio: 1,
            },
          },
          {
            anchorKey: 'weak-anchor',
            testId: 'weak-anchor',
            label: 'Weak',
            approvedRoute: null,
            allowedPlacements: ['top'] as const,
            smartTags: [],
            score: 0.4,
            evidence: {
              routeCompatible: true,
              routeExactMatch: false,
              matchedTags: [],
              matchedLabelTokens: [],
              queryTokens: [],
              overlapRatio: 0,
            },
          },
        ],
        autoSelectedAnchor: null,
        autoSelectThreshold: DEFAULT_ANCHOR_AUTO_SELECT_SCORE_THRESHOLD,
      };

      const annotated = annotateProposalStepsWithAnchorMatch(
        {
          proposalId: 'p1',
          walkthroughFields: {
            internalName: 'n',
            userTitle: 't',
            whyItMatters: 'w',
          },
          steps: [
            {
              id: 's1',
              ordinal: 0,
              heading: 'Strong',
              bodyMarkdown: 'body',
              anchor: {
                key: 'profile-bio',
                targetRoute: '/profile',
                placement: 'bottom',
              },
            },
            {
              id: 's2',
              ordinal: 1,
              heading: 'Weak',
              bodyMarkdown: 'body',
              anchor: {
                key: 'weak-anchor',
                targetRoute: '/profile',
                placement: 'top',
              },
            },
            {
              id: 's3',
              ordinal: 2,
              heading: 'Missing',
              bodyMarkdown: 'body',
            },
          ],
          units: [],
          generatedAt: '2026-07-30T00:00:00.000Z',
          generationContextVersion: 'v1',
          policyPreset: 'A',
        },
        ranking,
      );

      expect(annotated.steps[0].anchorMatch).toMatchObject({
        score: 0.9,
        belowThreshold: false,
        hasAnchor: true,
      });
      // A low heuristic score with an AI-selected anchor is NOT below threshold —
      // the validated catalog pick is trusted.
      expect(annotated.steps[1].anchorMatch).toMatchObject({
        score: 0.4,
        belowThreshold: false,
        hasAnchor: true,
      });
      // Only a step with no anchor at all is below threshold (becomes a centered step).
      expect(annotated.steps[2].anchorMatch).toMatchObject({
        score: 0,
        belowThreshold: true,
        hasAnchor: false,
      });
      expect(annotated.units.some((u) => u.kind === 'step' && u.value.anchorMatch)).toBe(
        true,
      );
    });
  });

  describe('getGenerationResult', () => {
    it('returns ready with valid JSON output', async () => {
      mockedDb.query.chatThreads.findFirst.mockResolvedValue({
        userId: USER_ID,
        workspaceDir: '/tmp/ws',
        status: 'idle',
      });
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(VALID_OUTPUT);

      const result = await getGenerationResult(THREAD_ID, USER_ID);
      expect(result.status).toBe('ready');
      expect(result.rawJson).toBe(VALID_OUTPUT);
      expect(result.proposal?.proposalId).toBe('proposal-1');

      // Phase 6/7 reconciliation: must pass DB authoring catalog (incl. non-DOM keys),
      // not omit the 4th arg (which would silently fall back to DOM markers).
      expect(mockedListAuthoringAnchorEntries).toHaveBeenCalled();
      expect(mockedParseProposal).toHaveBeenCalledWith(
        VALID_OUTPUT,
        'A',
        expect.any(Array),
        expect.arrayContaining([
          expect.objectContaining({ key: DB_ONLY_AUTHORING_ENTRY.key }),
        ]),
      );
      const catalogArg = mockedParseProposal.mock.calls[0][3] as
        | readonly { key: string }[]
        | undefined;
      expect(catalogArg?.some((a) => a.key === DB_ONLY_AUTHORING_ENTRY.key)).toBe(true);
      expect(listWalkthroughAnchors().some((a) => a.key === DB_ONLY_AUTHORING_ENTRY.key)).toBe(
        false,
      );
    });

    it('returns pending when no workspace yet', async () => {
      mockedDb.query.chatThreads.findFirst.mockResolvedValue({
        userId: USER_ID,
        workspaceDir: null,
        status: 'running',
      });

      const result = await getGenerationResult(THREAD_ID, USER_ID);
      expect(result.status).toBe('pending');
    });

    it('returns failed when idle with no output', async () => {
      mockedDb.query.chatThreads.findFirst.mockResolvedValue({
        userId: USER_ID,
        workspaceDir: '/tmp/ws',
        status: 'idle',
      });
      mockFs.existsSync.mockReturnValue(false);
      mockedIsThreadIdle.mockReturnValue(true);

      const result = await getGenerationResult(THREAD_ID, USER_ID);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('without generating');
    });

    it('returns failed when output has invalid JSON', async () => {
      mockedDb.query.chatThreads.findFirst.mockResolvedValue({
        userId: USER_ID,
        workspaceDir: '/tmp/ws',
        status: 'idle',
      });
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('not json{{{');

      const result = await getGenerationResult(THREAD_ID, USER_ID);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('not valid JSON');
    });

    it('returns failed when output missing steps array', async () => {
      mockedDb.query.chatThreads.findFirst.mockResolvedValue({
        userId: USER_ID,
        workspaceDir: '/tmp/ws',
        status: 'idle',
      });
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('{"internalName": "x"}');

      const result = await getGenerationResult(THREAD_ID, USER_ID);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('missing steps');
    });

    it('throws when thread not found', async () => {
      mockedDb.query.chatThreads.findFirst.mockResolvedValue(null);
      await expect(getGenerationResult(THREAD_ID, USER_ID)).rejects.toThrow(
        WalkthroughAiError,
      );
    });
  });

  describe('cancelGeneration', () => {
    it('marks thread as cancelled and calls cancelRun', async () => {
      mockedDb.query.chatThreads.findFirst.mockResolvedValue({
        userId: USER_ID,
        workspaceDir: '/tmp/ws',
        status: 'running',
      });

      const result = await cancelGeneration(THREAD_ID, USER_ID);
      expect(result.status).toBe('cancelled');
      expect(mockedCancelRun).toHaveBeenCalledWith(THREAD_ID);
    });

    it('returns cancelled on subsequent status poll', async () => {
      mockedDb.query.chatThreads.findFirst.mockResolvedValue({
        userId: USER_ID,
        workspaceDir: '/tmp/ws',
        status: 'idle',
      });

      await cancelGeneration(THREAD_ID, USER_ID);
      const result = await getGenerationResult(THREAD_ID, USER_ID);
      expect(result.status).toBe('cancelled');
    });
  });
});
