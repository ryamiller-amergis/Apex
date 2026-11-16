import request from 'supertest';
import express, { type NextFunction, type Request, type Response } from 'express';
import { AzureDevOpsService } from '../services/azureDevOps';
import * as releasePlatformService from '../services/releasePlatformService';
import * as projectSettingsService from '../services/projectSettingsService';
import * as skillCatalogFacade from '../services/skillCatalogFacade';
import * as modelsService from '../services/modelsService';
import * as bedrockService from '../services/bedrockService';
import {
  annotateChangelogTreeWithPlatforms,
  buildChangelogFilename,
  buildFallbackReleaseChangelogMarkdown,
  clearReleaseChangelogCachesForTests,
  computeChangelogSlaBudgetMs,
  generateReleaseChangelog,
  inferSmartPlatformsFromText,
  loadReleaseChangelogSkillMarkdown,
  resolveBedrockCandidateModels,
  resolveProjectReleaseChangelogConfig,
  setReleaseChangelogAiProviderForTests,
} from '../services/releaseChangelogService';
import type { ReleasePlatform } from '../../shared/types/releasePlatforms';

jest.mock('../services/azureDevOps');
jest.mock('../services/releasePlatformService', () => {
  const actual = jest.requireActual('../services/releasePlatformService');
  return {
    ...actual,
    getProjectReleasePlatformsState: jest.fn(),
  };
});
jest.mock('../services/projectSettingsService', () => ({
  getSkillConfig: jest.fn(),
  getSkillConfigById: jest.fn(),
  listSkillConfigsForProject: jest.fn(),
  resolveSkillConfig: jest.fn().mockResolvedValue({ defaultModel: 'composer-2.5' }),
}));
jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn().mockResolvedValue('composer-2.5'),
}));
jest.mock('../services/skillCatalogFacade', () => ({
  getSkillFile: jest.fn(),
}));
jest.mock('../services/modelsService', () => ({
  fetchAvailableModels: jest.fn().mockResolvedValue([]),
  resolveCursorModelChoice: jest.fn(async (model: string, effort?: string) => ({
    model,
    effort,
  })),
  requestModelAvailabilityProbe: jest.fn(),
}));
jest.mock('../services/bedrockService', () => ({
  listAvailableBedrockModels: jest.fn().mockResolvedValue([
    { id: 'us.anthropic.claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { id: 'us.anthropic.claude-haiku-4-6-20261001-v1:0', label: 'Claude Haiku 4.6' },
  ]),
}));

let assignedReleaseProjects = new Set<string>(['MaxView']);

jest.mock('../middleware/rbac', () => ({
  requireGroupMembership:
    () => (req: Request & { user?: unknown }, _res: Response, next: NextFunction) => {
      req.user = { profile: { oid: 'ba-user-oid' } };
      next();
    },
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requireAnyPermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requireProjectAccess: (resolve: (req: Request) => string | undefined) =>
    (req: Request, res: Response, next: NextFunction) => {
      const project = resolve(req);
      if (!project || !assignedReleaseProjects.has(project)) {
        return res.status(403).json({ error: 'Forbidden: not assigned to this project' });
      }
      next();
    },
  resolveRequestProject: (req: Request) => {
    const bodyProject = (req.body as { project?: unknown } | undefined)?.project;
    return typeof bodyProject === 'string' ? bodyProject : undefined;
  },
  attachPermissions: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import apiRouter from '../routes/api';

const DESKTOP: ReleasePlatform = {
  id: 'plat-desktop',
  project: 'MaxView',
  slug: 'desktop',
  name: 'Desktop',
  color: 'blue',
  sortOrder: 0,
  createdAt: '2026-11-16T00:00:00.000Z',
};

const MOBILE: ReleasePlatform = {
  id: 'plat-mobile',
  project: 'MaxView',
  slug: 'mobile',
  name: 'Mobile',
  color: 'purple',
  sortOrder: 1,
  createdAt: '2026-11-16T00:01:00.000Z',
};

const mockGetPlatformState =
  releasePlatformService.getProjectReleasePlatformsState as jest.MockedFunction<
    typeof releasePlatformService.getProjectReleasePlatformsState
  >;

describe('releaseChangelogService — skill, platform awareness, and hierarchical rollup', () => {
  afterEach(() => {
    setReleaseChangelogAiProviderForTests(null);
    clearReleaseChangelogCachesForTests();
    jest.clearAllMocks();
  });

  it('scales SLA latency budgets tightly by item count (~1.35s for 1, ~2.15s for 5, ~3.15s for 10, capped <= 3.8s)', () => {
    expect(computeChangelogSlaBudgetMs(1)).toBeLessThanOrEqual(1_500);
    expect(computeChangelogSlaBudgetMs(5)).toBeLessThanOrEqual(2_300);
    expect(computeChangelogSlaBudgetMs(10)).toBeLessThanOrEqual(3_500);
    expect(computeChangelogSlaBudgetMs(50)).toBeLessThanOrEqual(3_800);
  });

  it('enforces the SLA deadline and immediately resolves with structured fallback when an AI provider stalls', async () => {
    setReleaseChangelogAiProviderForTests({
      generateMarkdown: () =>
        new Promise((resolve) => {
          const t = setTimeout(() => resolve('# Never reached'), 30_000);
          t.unref?.();
        }),
    });

    const mockAdo = {
      getReleaseEpicChangelogContext: jest.fn().mockResolvedValue({
        epic: {
          id: 901,
          version: 'MV 2026.18.0',
          status: 'In Progress',
          targetDate: '2026-11-30',
          description: 'RTO/Shift',
          tags: 'ReleaseVersion',
        },
        items: [
          {
            id: 777,
            title: 'Shift Swap Approvals',
            workItemType: 'Feature',
            state: 'In Progress',
            tags: 'Mobile',
            description: 'Managers can approve shift swaps from Mobile.',
            ancestorIds: [],
            ancestorTags: '',
            children: [],
          },
        ],
      }),
    } as unknown as AzureDevOpsService;

    mockGetPlatformState.mockResolvedValue({
      project: 'MaxView',
      platforms: [MOBILE, DESKTOP],
      epicPlatformIds: {},
      workItemPlatformIds: {},
    });

    const started = Date.now();
    const result = await generateReleaseChangelog({
      epicId: 901,
      project: 'MaxView',
      adoService: mockAdo,
    });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2_000);
    expect(result.source).toBe('fallback');
    expect(result.markdown).toContain('# MV 2026.18.0 — Release Notes');
    expect(result.markdown).toContain('Shift Swap Approvals');
  });

  it('loads the bundled .cursor/skills/release-changelog/SKILL.md instructions', () => {
    const skillMd = loadReleaseChangelogSkillMarkdown();
    expect(skillMd).toContain('name: release-changelog');
    expect(skillMd).toContain('Smart Hierarchical Rollup');
    expect(skillMd).toContain('Smart Platform Awareness');
  });

  it('honours Project Settings Sidecar skill, model, effort, and Bedrock overrides without waiting on a live model catalog', async () => {
    (projectSettingsService.resolveSkillConfig as jest.Mock).mockResolvedValueOnce({
      id: 'cfg-1',
      project: 'MaxView',
      friendlyName: 'Default',
      isDefault: true,
      skillProvider: 'ado',
      skillRepo: 'MaxView',
      skillBranch: 'main',
      releaseChangelogSkillPath: '.cursor/skills/custom-exec-notes/SKILL.md',
      releaseChangelogModel: 'claude-sonnet-4-5', // pretend retired model configured in sidecar
      releaseChangelogEffort: 'low',
      releaseChangelogBedrockModelId: 'us.anthropic.claude-haiku-legacy-retired',
    });

    (skillCatalogFacade.getSkillFile as jest.Mock).mockResolvedValueOnce(
      '---\nname: custom-exec-notes\n---\n# Custom Exec Notes Skill',
    );
    (modelsService.resolveCursorModelChoice as jest.Mock).mockClear();
    (bedrockService.listAvailableBedrockModels as jest.Mock).mockClear();

    const resolved = await resolveProjectReleaseChangelogConfig('MaxView');
    expect(resolved.skillPath).toBe('.cursor/skills/custom-exec-notes/SKILL.md');
    expect(resolved.skillMarkdown).toContain('# Custom Exec Notes Skill');
    expect(resolved.cursorModel).toBe('claude-sonnet-4-5');
    expect(resolved.cursorEffort).toBe('low');
    expect(modelsService.resolveCursorModelChoice).not.toHaveBeenCalled();
    expect(resolved.configuredBedrockModelId).toBe(
      'us.anthropic.claude-haiku-legacy-retired',
    );

    // Static chain: configured override first, then known Haiku and Sonnet ids. No ListInferenceProfiles call.
    const bedrockCandidates = resolveBedrockCandidateModels(resolved.configuredBedrockModelId);
    expect(bedrockCandidates).toEqual(
      expect.arrayContaining([
        'us.anthropic.claude-haiku-legacy-retired',
        'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        'us.anthropic.claude-sonnet-4-6',
      ]),
    );
    expect(bedrockCandidates[0]).toBe('us.anthropic.claude-haiku-legacy-retired');
    expect(bedrockService.listAvailableBedrockModels).not.toHaveBeenCalled();
  });

  it('falls back to the bundled skill when a configured repo Sidecar skill path is missing', async () => {
    (projectSettingsService.resolveSkillConfig as jest.Mock).mockResolvedValueOnce({
      id: 'cfg-2',
      project: 'MaxView',
      friendlyName: 'Default',
      isDefault: true,
      skillProvider: 'ado',
      skillRepo: 'MaxView',
      skillBranch: 'main',
      releaseChangelogSkillPath: '.cursor/skills/deleted-skill/SKILL.md',
    });
    (skillCatalogFacade.getSkillFile as jest.Mock).mockRejectedValueOnce(
      new Error('ADO 404 not found'),
    );

    const resolved = await resolveProjectReleaseChangelogConfig('MaxView');
    expect(resolved.skillPath).toBe('.cursor/skills/release-changelog/SKILL.md');
    expect(resolved.skillMarkdown).toContain('name: release-changelog');
  });

  it('builds clean slugified .md filenames from release versions', () => {
    expect(buildChangelogFilename('MV 2027.01.13')).toBe('mv-2027.01.13-changelog.md');
    expect(buildChangelogFilename('  Release / v2.4 (Mobile)  ')).toBe(
      'release-v2.4-mobile-changelog.md',
    );
  });

  it('infers configured platforms from unmistakable title/description keywords when unassigned', () => {
    const platforms = [DESKTOP, MOBILE];

    expect(
      inferSmartPlatformsFromText('Fix iOS push notification badge count', platforms).map(
        (p) => p.slug,
      ),
    ).toEqual(['mobile']);

    expect(
      inferSmartPlatformsFromText('Windows Electron installer auto-update prompt', platforms).map(
        (p) => p.slug,
      ),
    ).toEqual(['desktop']);

    expect(
      inferSmartPlatformsFromText('Update quarterly billing tax calculation', platforms),
    ).toEqual([]);
  });

  it('annotates hierarchical Feature/PBI trees with explicit, tag, inherited, and smart-inferred platforms', () => {
    const annotated = annotateChangelogTreeWithPlatforms({
      epicId: 900,
      epicTags: 'ReleaseVersion',
      platformState: {
        project: 'MaxView',
        platforms: [DESKTOP, MOBILE],
        epicPlatformIds: {},
        workItemPlatformIds: {
          500: ['plat-mobile'], // Feature #500 explicitly assigned Mobile
        },
      },
      rawItems: [
        {
          id: 500,
          title: 'Field Offline Inspections',
          workItemType: 'Feature',
          state: 'In Progress',
          tags: '',
          description: '<p>Allow inspectors to complete checklists without cell service.</p>',
          ancestorIds: [],
          ancestorTags: '',
          children: [
            {
              id: 501,
              title: 'Queue inspection photos locally',
              workItemType: 'Product Backlog Item',
              state: 'Done',
              tags: '',
              description: '',
              ancestorIds: [500],
              ancestorTags: '',
              children: [],
            },
            {
              id: 502,
              title: 'Background sync retry worker',
              workItemType: 'Technical Backlog Item',
              state: 'Ready For Release',
              tags: '',
              description: '',
              ancestorIds: [500],
              ancestorTags: '',
              children: [],
            },
          ],
        },
        {
          id: 600,
          title: 'Desktop Tray Quick-Launch',
          workItemType: 'Product Backlog Item',
          state: 'Done',
          tags: '', // unassigned, but title clearly indicates Desktop
          description: 'Launch MaxView directly from the Windows system tray.',
          ancestorIds: [],
          ancestorTags: '',
          children: [],
        },
      ],
    });

    expect(annotated.platformsIncluded).toEqual(['Desktop', 'Mobile']);
    // 2 children under Feature #500 + 1 standalone PBI #600 = 3 leaf deliverables
    expect(annotated.leafItemCount).toBe(3);
    // Child PBIs inherit Mobile from parent Feature #500
    expect(annotated.items[0].platforms).toEqual(['Mobile']);
    expect(annotated.items[0].children[0].platforms).toEqual(['Mobile']);
    // Unassigned PBI #600 gets smart-inferred Desktop
    expect(annotated.items[1].platforms).toEqual([]);
    expect(annotated.items[1].inferredPlatforms).toEqual(['Desktop']);

    // Deterministic fallback groups cleanly by Desktop and Mobile and rolls Feature #500 into one bullet
    const fallbackMd = buildFallbackReleaseChangelogMarkdown({
      epic: {
        version: 'MV 2027.01.13',
        targetDate: '2027-01-13',
        descriptionExcerpt: '',
      },
      configuredPlatforms: [DESKTOP, MOBILE],
      platformsIncluded: annotated.platformsIncluded,
      items: annotated.items,
    });

    expect(fallbackMd).toContain('# MV 2027.01.13 — Release Notes');
    expect(fallbackMd).toContain('**Platforms:** Desktop, Mobile');
    expect(fallbackMd).toContain('## Desktop');
    expect(fallbackMd).toContain('- **Desktop Tray Quick-Launch**');
    expect(fallbackMd).toContain('## Mobile');
    expect(fallbackMd).toContain(
      '- **Field Offline Inspections** — Allow inspectors to complete checklists without cell service.',
    );
    // Child PBI #501 is rolled up into Feature #500 rather than listed separately
    expect(fallbackMd).not.toContain('Queue inspection photos locally');
  });

  it('invokes the AI skill provider with full hierarchical + platform context and strips outer code fences', async () => {
    const mockProvider = {
      generateMarkdown: jest.fn().mockResolvedValue(
        '```markdown\n# MV 2027.01.13 — Release Notes\n\n**Target Date:** 2027-01-13 | **Target Platform:** Mobile\n\n## Highlights\n\n- **Offline Inspections** — Field teams can capture and sync inspections offline.\n```',
      ),
    };
    setReleaseChangelogAiProviderForTests(mockProvider);

    const mockAdo = {
      getReleaseEpicChangelogContext: jest.fn().mockResolvedValue({
        epic: {
          id: 900,
          version: 'MV 2027.01.13',
          status: 'In Progress',
          targetDate: '2027-01-13',
          description: 'January mobile field release',
          tags: 'ReleaseVersion',
        },
        items: [
          {
            id: 500,
            title: 'Offline Inspections',
            workItemType: 'Feature',
            state: 'In Progress',
            tags: 'Platform:Mobile',
            description: 'Offline checklist support',
            ancestorIds: [],
            ancestorTags: '',
            children: [
              {
                id: 501,
                title: 'Offline SQLite cache',
                workItemType: 'Product Backlog Item',
                state: 'Done',
                tags: '',
                description: '',
                ancestorIds: [500],
                ancestorTags: 'Platform:Mobile',
                children: [],
              },
            ],
          },
        ],
      }),
    } as unknown as AzureDevOpsService;

    mockGetPlatformState.mockResolvedValue({
      project: 'MaxView',
      platforms: [MOBILE],
      epicPlatformIds: {},
      workItemPlatformIds: {},
    });

    const result = await generateReleaseChangelog({
      epicId: 900,
      project: 'MaxView',
      areaPath: 'MaxView',
      userId: 'user-1',
      adoService: mockAdo,
    });

    expect(mockProvider.generateMarkdown).toHaveBeenCalledTimes(1);
    const passedPrompt = mockProvider.generateMarkdown.mock.calls[0][0].prompt as string;
    expect(passedPrompt).toContain('Offline Inspections');
    expect(passedPrompt).toContain('Offline SQLite cache');
    expect(passedPrompt).toContain('Mobile');

    expect(result.source).toBe('ai');
    expect(result.filename).toBe('mv-2027.01.13-changelog.md');
    expect(result.platformsIncluded).toEqual(['Mobile']);
    expect(result.itemCount).toBe(1);
    expect(result.leafItemCount).toBe(1);
    expect(result.markdown.startsWith('# MV 2027.01.13 — Release Notes')).toBe(true);
    expect(result.markdown).not.toContain('```');
  });
});

describe('POST /api/releases/:epicId/changelog route', () => {
  let app: express.Application;
  let mockAdoInstance: { getReleaseEpicChangelogContext: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    assignedReleaseProjects = new Set(['MaxView']);
    setReleaseChangelogAiProviderForTests(null);

    app = express();
    app.use(express.json());
    app.use('/api', apiRouter);

    mockAdoInstance = {
      getReleaseEpicChangelogContext: jest.fn(),
    };
    (AzureDevOpsService as jest.MockedClass<typeof AzureDevOpsService>).mockImplementation(
      () => mockAdoInstance as unknown as AzureDevOpsService,
    );
    mockGetPlatformState.mockResolvedValue({
      project: 'MaxView',
      platforms: [DESKTOP, MOBILE],
      epicPlatformIds: {},
      workItemPlatformIds: {},
    });
  });

  it('returns 400 for an invalid epic ID and 403 when project is missing', async () => {
    await request(app)
      .post('/api/releases/not-a-number/changelog')
      .send({ project: 'MaxView' })
      .expect(400);

    await request(app)
      .post('/api/releases/101/changelog')
      .send({})
      .expect(403);
  });

  it('returns 403 when the caller is not assigned to the named project', async () => {
    assignedReleaseProjects = new Set(['OtherProject']);

    const res = await request(app)
      .post('/api/releases/101/changelog')
      .send({ project: 'MaxView' })
      .expect(403);

    expect(res.body.error).toMatch(/not assigned/i);
    expect(mockAdoInstance.getReleaseEpicChangelogContext).not.toHaveBeenCalled();
  });

  it('returns 404 when the release epic does not exist in ADO', async () => {
    mockAdoInstance.getReleaseEpicChangelogContext.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/releases/999/changelog')
      .send({ project: 'MaxView', areaPath: 'MaxView' })
      .expect(404);

    expect(res.body.error).toContain('#999');
  });

  it('generates and returns executive Markdown changelog for a valid release epic', async () => {
    mockAdoInstance.getReleaseEpicChangelogContext.mockResolvedValue({
      epic: {
        id: 101,
        version: 'MV 2027.01.13',
        status: 'In Progress',
        targetDate: '2027-01-13',
        description: '',
        tags: 'ReleaseVersion',
      },
      items: [
        {
          id: 301,
          title: 'Mobile Offline Mode',
          workItemType: 'Feature',
          state: 'In Progress',
          tags: 'Mobile',
          description: 'Complete field forms offline with automatic background sync.',
          ancestorIds: [],
          ancestorTags: '',
          children: [],
        },
      ],
    });

    const res = await request(app)
      .post('/api/releases/101/changelog')
      .send({ project: 'MaxView', areaPath: 'MaxView' })
      .expect(200);

    expect(res.body.epicId).toBe(101);
    expect(res.body.filename).toBe('mv-2027.01.13-changelog.md');
    expect(res.body.platformsIncluded).toEqual(['Mobile']);
    expect(res.body.markdown).toContain('# MV 2027.01.13 — Release Notes');
    expect(res.body.markdown).toContain('Mobile Offline Mode');
  });
});
