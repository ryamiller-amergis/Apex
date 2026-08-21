import {
  resolvePrototypeContext,
  invalidatePrototypeContextCache,
  normalizeDesignSystemSkillPath,
  resolvePrototypeExtendMode,
  fetchProjectPageContext,
} from '../services/prototypeContextService';
import { resolveSkillConfig } from '../services/projectSettingsService';
import { fetchAdoFileGeneric } from '../utils/adoFileFetch';
import { fetchExistingPageContext } from '../services/designSystemService';
import { getSkillFile } from '../services/skillCatalogFacade';

jest.mock('../services/projectSettingsService', () => ({
  resolveSkillConfig: jest.fn(),
}));

jest.mock('../utils/adoFileFetch', () => ({
  fetchAdoFileGeneric: jest.fn(),
}));

jest.mock('../services/skillCatalogFacade', () => ({
  getSkillFile: jest.fn(),
}));

jest.mock('../services/designTokensService', () => ({
  getMaxviewColorTokens: jest.fn().mockReturnValue('## MaxView Color Tokens\nprimary: #323695'),
}));

jest.mock('../services/designSystemService', () => ({
  getDesignSystemCatalog: jest.fn().mockResolvedValue({ uiKnowledgeBase: 'MaxView screens catalog', routes: [], tokensCss: '', componentNames: [], componentDescriptions: {}, routeLayoutHints: {}, fetchedAt: 0 }),
  fetchExistingPageContext: jest.fn().mockResolvedValue('### File: /src/client/components/AgentHome.tsx'),
}));

const mockResolveSkillConfig = resolveSkillConfig as jest.Mock;
const mockFetchAdoFileGeneric = fetchAdoFileGeneric as jest.Mock;
const mockGetSkillFile = getSkillFile as jest.Mock;

describe('prototypeContextService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    invalidatePrototypeContextCache();
    process.env.ADO_ORG = 'https://dev.azure.com/myorg';
    process.env.ADO_PAT = 'test-pat';
  });

  afterEach(() => {
    delete process.env.ADO_ORG;
    delete process.env.ADO_PAT;
  });

  describe('resolvePrototypeContext', () => {
    it('returns project-specific context when the design-system skill resolves', async () => {
      mockResolveSkillConfig.mockResolvedValue({
        skillRepo: 'MyADOProject/Amego',
        skillBranch: 'main',
        prototypeDesignSystemPath: null,
        screenInventoryPath: null,
        prototypeWebReferencesEnabled: false,
      });
      mockFetchAdoFileGeneric.mockResolvedValue('# Amego Design System\n## Colors\n:root { --primary: #1FB6AE; }');

      const ctx = await resolvePrototypeContext('amego-project', undefined);

      expect(ctx).not.toBeNull();
      expect(ctx!.isProjectSpecific).toBe(true);
      expect(ctx!.appName).toBeTruthy();
      expect(ctx!.designSystemMarkdown).toContain('Amego Design System');
    });

    it('uses the convention path when prototypeDesignSystemPath is null', async () => {
      mockResolveSkillConfig.mockResolvedValue({
        skillRepo: 'MyOrg/Amego',
        skillBranch: 'develop',
        prototypeDesignSystemPath: null,
        screenInventoryPath: null,
        prototypeWebReferencesEnabled: false,
      });
      mockFetchAdoFileGeneric.mockResolvedValue('# Design System Content');

      await resolvePrototypeContext('amego', undefined);

      expect(mockFetchAdoFileGeneric).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        '.cursor/skills/design-system/SKILL.md',
        'develop',
      );
    });

    it('uses a custom prototypeDesignSystemPath when configured', async () => {
      mockResolveSkillConfig.mockResolvedValue({
        skillRepo: 'Org/Repo',
        skillBranch: 'main',
        prototypeDesignSystemPath: '.cursor/skills/custom-design/SKILL.md',
        screenInventoryPath: null,
        prototypeWebReferencesEnabled: false,
      });
      mockFetchAdoFileGeneric.mockResolvedValue('# Custom Design System');

      await resolvePrototypeContext('custom-project', undefined);

      expect(mockFetchAdoFileGeneric).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        '.cursor/skills/custom-design/SKILL.md',
        'main',
      );
    });

    it('loads the design-system skill from GitHub when skillProvider is github', async () => {
      mockResolveSkillConfig.mockResolvedValue({
        skillProvider: 'github',
        skillRepo: 'ryamiller-amergis/Apex',
        skillBranch: 'main',
        prototypeDesignSystemPath: 'design-system',
        screenInventoryPath: '.cursor/skills/design-system/apex-screens.md',
        prototypeWebReferencesEnabled: false,
      });
      mockGetSkillFile.mockResolvedValue('# Apex Design System\nprimary: #2747D9');

      const ctx = await resolvePrototypeContext('Apex', undefined);

      expect(ctx).not.toBeNull();
      expect(ctx!.isProjectSpecific).toBe(true);
      expect(ctx!.designSystemMarkdown).toContain('# Apex Design System');
      expect(ctx!.extend?.provider).toBe('github');
      expect(ctx!.extend?.repo).toBe('ryamiller-amergis/Apex');
      expect(mockGetSkillFile).toHaveBeenCalledWith(
        'Apex',
        'ryamiller-amergis/Apex',
        '.cursor/skills/design-system/SKILL.md',
        'main',
        'github',
      );
      expect(mockFetchAdoFileGeneric).not.toHaveBeenCalled();
    });

    it('returns null (fail loudly) when a configured project ADO fetch fails', async () => {
      // C3 fix: a project with skillRepo configured but an unreachable design-system file
      // returns null so the prototype is marked generation_failed rather than silently
      // producing MaxView-styled output for a non-MaxView project.
      mockResolveSkillConfig.mockResolvedValue({
        skillRepo: 'Org/Repo',
        skillBranch: 'main',
        prototypeDesignSystemPath: null,
        screenInventoryPath: null,
        prototypeWebReferencesEnabled: false,
      });
      mockFetchAdoFileGeneric.mockRejectedValue(new Error('ADO 404'));

      const ctx = await resolvePrototypeContext('some-project', undefined);

      expect(ctx).toBeNull();
    });

    it('falls back to MaxView bundle when no skillRepo is configured', async () => {
      mockResolveSkillConfig.mockResolvedValue(null);

      const ctx = await resolvePrototypeContext('unconfigured-project', undefined);

      expect(ctx).not.toBeNull();
      expect(ctx!.isProjectSpecific).toBe(false);
    });

    it('populates extend context when screenInventoryPath is set', async () => {
      mockResolveSkillConfig.mockResolvedValue({
        skillRepo: 'Org/MaxView',
        skillBranch: 'development',
        prototypeDesignSystemPath: null,
        screenInventoryPath: '.cursor/skills/figma-ui-knowledge-base/clientapp-screens.md',
        prototypeWebReferencesEnabled: false,
      });
      mockFetchAdoFileGeneric.mockResolvedValue('# MaxView Design System');

      const ctx = await resolvePrototypeContext('maxview-project', undefined);

      expect(ctx!.extend?.screenInventoryPath).toBe('.cursor/skills/figma-ui-knowledge-base/clientapp-screens.md');
    });

    it('caches and returns the cached result on repeated calls', async () => {
      mockResolveSkillConfig.mockResolvedValue({
        skillRepo: 'Org/Amego',
        skillBranch: 'main',
        prototypeDesignSystemPath: null,
        screenInventoryPath: null,
        prototypeWebReferencesEnabled: false,
      });
      mockFetchAdoFileGeneric.mockResolvedValue('# Amego Design System');

      await resolvePrototypeContext('amego', undefined);
      await resolvePrototypeContext('amego', undefined);

      // ADO fetch should only happen once (second call is cached)
      expect(mockFetchAdoFileGeneric).toHaveBeenCalledTimes(1);
    });

    it('expands a design-system skill name to the convention SKILL.md path', async () => {
      mockResolveSkillConfig.mockResolvedValue({
        skillRepo: 'Org/Apex',
        skillBranch: 'main',
        prototypeDesignSystemPath: 'design-system',
        screenInventoryPath: '.cursor/skills/design-system/apex-screens.md',
        prototypeWebReferencesEnabled: false,
      });
      mockFetchAdoFileGeneric.mockResolvedValue('# Apex Design System');

      await resolvePrototypeContext('apex', undefined);

      expect(mockFetchAdoFileGeneric).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        '.cursor/skills/design-system/SKILL.md',
        'main',
      );
    });
  });
});

describe('normalizeDesignSystemSkillPath', () => {
  it('uses the convention path when the setting is blank', () => {
    expect(normalizeDesignSystemSkillPath(null)).toBe('.cursor/skills/design-system/SKILL.md');
    expect(normalizeDesignSystemSkillPath('')).toBe('.cursor/skills/design-system/SKILL.md');
  });

  it('keeps a full SKILL.md path from the skill list', () => {
    expect(normalizeDesignSystemSkillPath('/.cursor/skills/design-system/SKILL.md'))
      .toBe('.cursor/skills/design-system/SKILL.md');
  });

  it('expands a skill name to the convention folder', () => {
    expect(normalizeDesignSystemSkillPath('design-system'))
      .toBe('.cursor/skills/design-system/SKILL.md');
  });
});

describe('resolvePrototypeExtendMode', () => {
  it('uses a screenshot as EXTEND ground truth even without page source', () => {
    expect(resolvePrototypeExtendMode({
      targetRoute: '/home',
      existingPageContext: '',
      pageScreenshot: { base64: 'abc', mediaType: 'image/png' },
    })).toEqual({ extendMode: true, attachScreenshot: true });
  });

  it('does not EXTEND when there is no target route', () => {
    expect(resolvePrototypeExtendMode({
      pageScreenshot: { base64: 'abc', mediaType: 'image/png' },
    })).toEqual({ extendMode: false, attachScreenshot: false });
  });
});

describe('fetchProjectPageContext', () => {
  const mockFetchExisting = fetchExistingPageContext as jest.Mock;

  it('passes the project repo into the existing-page fetch', async () => {
    mockFetchExisting.mockResolvedValue('page source');

    const result = await fetchProjectPageContext('ApexProj', 'Apex', 'main', '/home');

    expect(result).toBe('page source');
    expect(mockFetchExisting).toHaveBeenCalledWith(
      '/home',
      undefined,
      expect.objectContaining({ adoProject: 'ApexProj', repo: 'Apex', branch: 'main' }),
    );
  });
});
