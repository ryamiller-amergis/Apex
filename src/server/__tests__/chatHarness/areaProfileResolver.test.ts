import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  HARNESS_AREA_IDS,
  type HarnessAreaId,
  type HarnessContextRef,
} from '../../../shared/types/chatHarness';
import { isFrozenHarnessSpec } from '../../../shared/types/durableInteractiveTurn';
import { INTERACTIVE_WORKFLOW_CLASSES } from '../../../shared/types/interactiveWorkflow';
import type { ProjectSkillConfig } from '../../../shared/types/projectSettings';
import {
  AREA_PROFILES,
  REPOSITORY_CODE_TOOLS,
  SCRUBBED_SHELL_ENV_KEYS,
  HarnessProfileError,
  assertAreaProfile,
  buildAreaProfileRegistry,
  getAreaProfile,
  type AreaProfile,
} from '../../services/chatHarness/areaProfiles';
import {
  resolveAreaProfile,
  toFrozenHarnessSpec,
  validateHarnessContext,
  type AreaProfileResolverDeps,
} from '../../services/chatHarness/areaProfileResolver';

const REPO_ROOT = resolve(__dirname, '../../../..');

function buildCompleteProjectSkillConfig(
  overrides: Partial<ProjectSkillConfig> = {},
): ProjectSkillConfig {
  return {
    id: 'settings-1',
    project: 'Apex',
    friendlyName: 'Apex Default',
    isDefault: true,
    skillProvider: 'github',
    skillRepo: 'org/apex',
    skillBranch: 'main',
    defaultModel: 'claude-sonnet-4-6',
    defaultEffort: 'medium',
    interviewSkillPath: '.cursor/skills/grill-with-docs/SKILL.md',
    interviewModel: 'claude-opus-4-6',
    interviewEffort: 'high',
    interviewSkillOptions: [
      {
        key: 'build-intake',
        enabled: true,
        path: '.cursor/skills/build-intake/SKILL.md',
        friendlyName: 'Build from prompt',
        model: 'claude-sonnet-4-6',
        effort: 'medium',
      },
    ],
    adrInterviewSkillPath: '.cursor/skills/adr-interview/SKILL.md',
    adrModel: 'claude-opus-4-6',
    adrEffort: 'high',
    prdAssistantSkillPath: '.cursor/skills/prd-spec-review/SKILL.md',
    prdAssistantModel: 'claude-sonnet-4-6',
    prdAssistantEffort: 'medium',
    designDocAssistantSkillPath: '.cursor/skills/design-spec-review/SKILL.md',
    designDocAssistantModel: 'claude-sonnet-4-6',
    designDocAssistantEffort: 'medium',
    calendarAssistantSkillPath: '.cursor/skills/calendar-assistant/SKILL.md',
    calendarAssistantModel: 'claude-sonnet-4-6',
    calendarAssistantEffort: 'low',
    testCaseSkillPath: '.cursor/skills/create-test-case/SKILL.md',
    testCaseModel: 'claude-sonnet-4-6',
    testCaseEffort: 'medium',
    standupSkillPath: '.cursor/skills/daily-standup/SKILL.md',
    standupModel: 'claude-sonnet-4-6',
    standupEffort: 'low',
    quickSkillPills: [
      {
        label: 'Brainstorm',
        skillPath: '.cursor/skills/brainstorm/SKILL.md',
        model: 'claude-sonnet-4-6',
        effort: 'medium',
      },
      {
        label: 'Ask Apex',
        skillPath: '.cursor/skills/app-knowledge/SKILL.md',
        model: 'claude-sonnet-4-6',
        effort: 'low',
      },
      {
        label: 'CAB Release',
        skillPath: '.cursor/skills/cab-release/SKILL.md',
        model: 'claude-sonnet-4-6',
        effort: 'medium',
      },
    ],
    ...overrides,
  };
}

function collectSeededPermissionKeys(): Set<string> {
  const migrationsDir = join(REPO_ROOT, 'migrations');
  const keys = new Set<string>();
  const keyPattern = /'([a-z][a-z0-9-]*(?::[a-z][a-z0-9_-]*)+)'/g;
  for (const file of readdirSync(migrationsDir)) {
    if (!file.endsWith('.sql')) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    if (!sql.includes('app_permissions')) continue;
    for (const match of sql.matchAll(keyPattern)) {
      keys.add(match[1]);
    }
  }
  return keys;
}

function collectRouteEnforcedPermissions(): Set<string> {
  const routesDir = join(REPO_ROOT, 'src', 'server', 'routes');
  const keys = new Set<string>();
  const literalPermission = /require(?:Any)?Permission\(([^)]+)\)/g;
  const quotedKey = /'([a-z][a-z0-9-]*(?::[a-z][a-z0-9_-]*)+)'/g;

  for (const file of readdirSync(routesDir)) {
    if (!file.endsWith('.ts')) continue;
    const content = readFileSync(join(routesDir, file), 'utf8');
    for (const call of content.matchAll(literalPermission)) {
      for (const match of call[1].matchAll(quotedKey)) {
        keys.add(match[1]);
      }
      if (call[1].includes('BRAINSTORM_CREATE')) {
        keys.add('brainstorm:create');
      }
      if (call[1].includes('BRAINSTORM_VIEW')) {
        keys.add('brainstorm:view');
      }
    }
  }
  return keys;
}

describe('VT-32 / TBI-008 DoD-0 / PBI-010 AC-0: resolveAreaProfile for all 12 areas', () => {
  const expectedWorkflowClasses: Readonly<Record<HarnessAreaId, string>> = {
    'agent-home': 'home-chat',
    interview: 'interview',
    adr: 'adr',
    'prd-assistant': 'assistant',
    'design-doc-assistant': 'assistant',
    'ask-apex': 'ask-apex',
    'calendar-work-item': 'home-chat',
    'qa-lab': 'home-chat',
    brainstorm: 'brainstorm',
    'cab-release': 'home-chat',
    'build-intake': 'interview',
    'standup-participant': 'home-chat',
  };

  it('registers all 12 HARNESS_AREA_IDS in AREA_PROFILES with no extras', () => {
    expect(AREA_PROFILES.size).toBe(12);
    expect([...AREA_PROFILES.keys()].sort()).toEqual([...HARNESS_AREA_IDS].sort());
  });

  it.each(HARNESS_AREA_IDS)(
    'resolves %s to a complete specification and valid FrozenHarnessSpec from project settings',
    async (area) => {
      const config = buildCompleteProjectSkillConfig();
      const deps: AreaProfileResolverDeps = {
        resolveSkillConfig: jest.fn().mockResolvedValue(config),
        getAppDefaultModel: jest.fn().mockResolvedValue(null),
        getAppDefaultSkill: jest.fn().mockResolvedValue(null),
        getEnv: () => undefined,
      };

      const resolved = await resolveAreaProfile(area, 'Apex', deps);

      expect(resolved.profile.area).toBe(area);
      expect(resolved.profile.version).toBeGreaterThanOrEqual(1);
      expect(resolved.project).toBe('Apex');
      expect(resolved.settingsId).toBe('settings-1');
      expect(resolved.workflowClass).toBe(expectedWorkflowClasses[area]);
      expect(INTERACTIVE_WORKFLOW_CLASSES).toContain(resolved.workflowClass);
      expect(resolved.model.trim().length).toBeGreaterThan(0);
      expect(resolved.permission.trim().length).toBeGreaterThan(0);
      expect(resolved.rating.endpoint.trim().length).toBeGreaterThan(0);
      expect(resolved.rating.storage.trim().length).toBeGreaterThan(0);
      expect(resolved.recreationCapChars).toBeGreaterThan(0);

      if (resolved.profile.requiresSkill) {
        expect(resolved.skill).not.toBeNull();
        expect(resolved.skill?.path.trim().length).toBeGreaterThan(0);
        expect(resolved.skill?.name.trim().length).toBeGreaterThan(0);
      }

      const frozen = toFrozenHarnessSpec(resolved);
      expect(isFrozenHarnessSpec(frozen)).toBe(true);
      expect(frozen.area).toBe(area);
      expect(frozen.version).toBe(resolved.profile.version);
      expect(frozen.operation).toBeUndefined();
      expect(frozen.safety).toEqual(resolved.safety);

      const summarizeFrozen = toFrozenHarnessSpec(resolved, {
        operation: 'summarize',
      });
      expect(isFrozenHarnessSpec(summarizeFrozen)).toBe(true);
      expect(summarizeFrozen.operation).toBe('summarize');
    },
  );

  it('uses app default (including env override) when project setting is absent, without hardcoding a literal', async () => {
    const config = buildCompleteProjectSkillConfig({
      interviewModel: null,
      defaultModel: null,
      interviewSkillPath: null,
      interviewSkillOptions: [],
    });
    const deps: AreaProfileResolverDeps = {
      resolveSkillConfig: jest.fn().mockResolvedValue(config),
      getAppDefaultModel: jest.fn().mockResolvedValue('app-configured-model'),
      getAppDefaultSkill: jest
        .fn()
        .mockResolvedValue('.cursor/skills/app-default-interview/SKILL.md'),
      getEnv: () => undefined,
    };

    const resolved = await resolveAreaProfile('interview', 'Apex', deps);

    expect(resolved.model).toBe('app-configured-model');
    expect(resolved.skill?.path).toBe('.cursor/skills/app-default-interview/SKILL.md');
    expect(resolved.skill?.source).toBe('app-default');
  });
});

describe('VT-33 / TBI-008 DoD-2 / PBI-010 AC-2: missing skill or model throws instead of using a default', () => {
  const skillRequiredAreas = HARNESS_AREA_IDS.filter(
    (area) => getAreaProfile(area).requiresSkill,
  );
  const skillOptionalAreas = HARNESS_AREA_IDS.filter(
    (area) => !getAreaProfile(area).requiresSkill,
  );

  it.each(skillRequiredAreas)(
    'throws missing-skill for %s when project and app default have no skill',
    async (area) => {
      const config = buildCompleteProjectSkillConfig({
        interviewSkillPath: null,
        interviewSkillOptions: [],
        adrInterviewSkillPath: null,
        prdAssistantSkillPath: null,
        designDocAssistantSkillPath: null,
        calendarAssistantSkillPath: null,
        testCaseSkillPath: null,
        standupSkillPath: null,
        quickSkillPills: [],
      });
      const deps: AreaProfileResolverDeps = {
        resolveSkillConfig: jest.fn().mockResolvedValue(config),
        getAppDefaultModel: jest.fn().mockResolvedValue(null),
        getAppDefaultSkill: jest.fn().mockResolvedValue(null),
        getEnv: () => undefined,
      };

      await expect(resolveAreaProfile(area, 'Apex', deps)).rejects.toMatchObject({
        name: 'HarnessProfileError',
        code: 'missing-skill',
      });
    },
  );

  it.each(skillOptionalAreas)(
    'resolves %s with skill=null when project and app default have no skill configured',
    async (area) => {
      const config = buildCompleteProjectSkillConfig({
        prdAssistantSkillPath: null,
        designDocAssistantSkillPath: null,
        calendarAssistantSkillPath: null,
        testCaseSkillPath: null,
        quickSkillPills: [],
      });
      const deps: AreaProfileResolverDeps = {
        resolveSkillConfig: jest.fn().mockResolvedValue(config),
        getAppDefaultModel: jest.fn().mockResolvedValue(null),
        getAppDefaultSkill: jest.fn().mockResolvedValue(null),
        getEnv: () => undefined,
      };

      const resolved = await resolveAreaProfile(area, 'Apex', deps);
      expect(resolved.skill).toBeNull();
      expect(resolved.model).toBeTruthy();
    },
  );

  it.each(HARNESS_AREA_IDS)(
    'throws missing-model for %s when project and app default have no model',
    async (area) => {
      const config = buildCompleteProjectSkillConfig({
        defaultModel: null,
        interviewModel: null,
        adrModel: null,
        prdAssistantModel: null,
        designDocAssistantModel: null,
        calendarAssistantModel: null,
        testCaseModel: null,
        standupModel: null,
        interviewSkillOptions: [
          {
            key: 'build-intake',
            enabled: true,
            path: '.cursor/skills/build-intake/SKILL.md',
            friendlyName: 'Build from prompt',
            model: null,
          },
        ],
        quickSkillPills: [
          { label: 'Brainstorm', skillPath: '.cursor/skills/brainstorm/SKILL.md', model: null },
          { label: 'Ask Apex', skillPath: '.cursor/skills/app-knowledge/SKILL.md', model: null },
          { label: 'CAB Release', skillPath: '.cursor/skills/cab-release/SKILL.md', model: null },
        ],
      });
      const deps: AreaProfileResolverDeps = {
        resolveSkillConfig: jest.fn().mockResolvedValue(config),
        getAppDefaultModel: jest.fn().mockResolvedValue(null),
        getAppDefaultSkill: jest.fn().mockResolvedValue(null),
        getEnv: () => undefined,
      };

      await expect(resolveAreaProfile(area, 'Apex', deps)).rejects.toMatchObject({
        name: 'HarnessProfileError',
        code: 'missing-model',
      });
    },
  );

  it('throws missing-model when project has no skill config row and no app default', async () => {
    const deps: AreaProfileResolverDeps = {
      resolveSkillConfig: jest.fn().mockResolvedValue(null),
      getAppDefaultModel: jest.fn().mockResolvedValue(null),
      getAppDefaultSkill: jest.fn().mockResolvedValue(null),
      getEnv: () => undefined,
    };

    await expect(
      resolveAreaProfile('agent-home', 'UnconfiguredProject', deps),
    ).rejects.toMatchObject({
      name: 'HarnessProfileError',
      code: 'missing-model',
    });
  });
});

describe('VT-34 / TBI-008 DoD-1 & DoD-3 / PBI-010 AC-1: registry validation, unknown areas, permissions, and ratings', () => {
  it('throws a validation error naming permission when a profile has no permission (assertAreaProfile and buildAreaProfileRegistry)', () => {
    const base = getAreaProfile('agent-home');
    const missingPermission = { ...base, permission: '' } as unknown as AreaProfile;

    expect(() => assertAreaProfile(missingPermission)).toThrow(HarnessProfileError);
    try {
      assertAreaProfile(missingPermission);
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessProfileError);
      const profileError = error as HarnessProfileError;
      expect(profileError.code).toBe('invalid-profile');
      expect(profileError.field).toBe('permission');
      expect(profileError.message).toMatch(/permission/i);
    }

    expect(() => buildAreaProfileRegistry([missingPermission])).toThrow(
      HarnessProfileError,
    );
    expect(() => buildAreaProfileRegistry([missingPermission])).toThrow(
      /permission/i,
    );
  });

  it('rejects a profile whose settingSources is non-empty or whose write tool auto-allows', () => {
    const base = getAreaProfile('prd-assistant');
    const badSettings = {
      ...base,
      safety: { ...base.safety, settingSources: ['project'] },
    } as unknown as AreaProfile;

    expect(() => assertAreaProfile(badSettings)).toThrow(HarnessProfileError);

    const badWriteMode = {
      ...base,
      writeConfirmation: base.writeConfirmation.map((rule) => ({
        ...rule,
        mode: 'allow' as const,
      })),
    } as unknown as AreaProfile;

    expect(() => assertAreaProfile(badWriteMode)).toThrow(HarnessProfileError);
  });

  it.each(['ui-lab', 'nonexistent', '', '   '])(
    'throws unknown-area for invalid area id %j',
    async (unknownArea) => {
      expect(() => getAreaProfile(unknownArea)).toThrow(HarnessProfileError);
      try {
        getAreaProfile(unknownArea);
      } catch (error) {
        expect((error as HarnessProfileError).code).toBe('unknown-area');
      }

      await expect(
        resolveAreaProfile(unknownArea, 'Apex', {
          resolveSkillConfig: jest.fn().mockResolvedValue(buildCompleteProjectSkillConfig()),
        }),
      ).rejects.toMatchObject({
        name: 'HarnessProfileError',
        code: 'unknown-area',
      });
    },
  );

  it('names a real server-enforced permission and existing rating endpoint + storage in every profile (DoD-3)', () => {
    const seededPermissions = collectSeededPermissionKeys();
    const enforcedPermissions = collectRouteEnforcedPermissions();

    for (const area of HARNESS_AREA_IDS) {
      const profile = getAreaProfile(area);
      expect(seededPermissions.has(profile.permission)).toBe(true);
      expect(enforcedPermissions.has(profile.permission)).toBe(true);
      expect(profile.rating.endpoint).toMatch(
        /^PUT \/api\/projects\/:projectId\/workflow-evaluations\/(message-feedback\/:messageId|skill-ratings)$/,
      );
      expect(['workflow_message_feedback', 'skill_signals']).toContain(
        profile.rating.storage,
      );
    }
  });

  it('declares writeConfirmation with mode="ask" and a confirmEndpoint for every writes:true custom tool (VT-31 prep)', () => {
    for (const area of HARNESS_AREA_IDS) {
      const profile = getAreaProfile(area);
      const writeTools = profile.customTools.filter((tool) => tool.writes);

      for (const tool of writeTools) {
        const confirmation = profile.writeConfirmation.find(
          (entry) => entry.tool === tool.name,
        );
        expect(confirmation).toBeDefined();
        expect(confirmation?.writes).toBe(true);
        expect(confirmation?.mode).toBe('ask');
        expect(confirmation?.confirmEndpoint.trim().length).toBeGreaterThan(0);
      }
    }

    // Key TBI-012 custom tool declarations
    expect(
      getAreaProfile('brainstorm').customTools.some((t) => t.writes),
    ).toBe(true);
    expect(
      getAreaProfile('prd-assistant').customTools.some((t) => t.writes),
    ).toBe(true);
    expect(
      getAreaProfile('design-doc-assistant').customTools.some((t) => t.writes),
    ).toBe(true);
    expect(
      getAreaProfile('calendar-work-item').customTools.some((t) => t.writes),
    ).toBe(true);
    expect(
      getAreaProfile('agent-home').customTools.some((t) => t.writes),
    ).toBe(true);
    expect(
      getAreaProfile('qa-lab').customTools.some((t) => t.writes),
    ).toBe(true);
    expect(
      getAreaProfile('cab-release').customTools.some(
        (t) => t.name === 'cab-request' && t.writes,
      ),
    ).toBe(true);
  });
});

describe('Safety rules (3-rule table-driven verification across all 12 areas)', () => {
  it('exports the 9 forbidden env var keys for scrubbed shell environments', () => {
    expect(SCRUBBED_SHELL_ENV_KEYS).toEqual([
      'CURSOR_API_KEY',
      'REDIS_KEY',
      'AI_RUNS_RUNNER_CALLBACK_TOKEN',
      'REPO_READ_SERVICE_TOKEN',
      'APPLICATIONINSIGHTS_CONNECTION_STRING',
      'AZURE_CLIENT_ID',
      'AI_PLATFORM_V2_IDENTITY_CLIENT_ID',
      'IDENTITY_ENDPOINT',
      'IDENTITY_HEADER',
    ]);
  });

  it.each(HARNESS_AREA_IDS)(
    'enforces all 3 safety rules on %s (settingSources=[], shell=none with Shell disallowed, repositoryCode=none excludes repo tools)',
    (area) => {
      const profile = getAreaProfile(area);

      // Rule 1: Repository settings never load
      expect(profile.safety.settingSources).toEqual([]);

      // Rule 2: Shell is disabled until SDK supports explicit env scrubbing
      expect(profile.safety.shell).toBe('none');
      expect(profile.disallowedTools).toContain('Shell');
      expect(profile.toolAllowlist).not.toContain('Shell');

      // Rule 3: repositoryCode='none' areas exclude all repository read/search tools
      if (area === 'interview' || area === 'build-intake') {
        expect(profile.safety.repositoryCode).toBe('none');
        for (const repoTool of REPOSITORY_CODE_TOOLS) {
          expect(profile.toolAllowlist).not.toContain(repoTool);
          expect(profile.disallowedTools).toContain(repoTool);
        }
      } else {
        expect(profile.safety.repositoryCode).toBe('read');
      }
    },
  );
});

describe('validateHarnessContext', () => {
  it('accepts omitted or null context and accepts declared context kinds', () => {
    const prdProfile = getAreaProfile('prd-assistant');
    expect(() => validateHarnessContext(prdProfile, undefined)).not.toThrow();
    expect(() => validateHarnessContext(prdProfile, null)).not.toThrow();
    expect(() =>
      validateHarnessContext(prdProfile, { kind: 'prd', id: 'prd-123' }),
    ).not.toThrow();

    const homeProfile = getAreaProfile('agent-home');
    expect(() => validateHarnessContext(homeProfile, undefined)).not.toThrow();
  });

  it('throws invalid-context when context kind is not accepted by the profile', () => {
    const prdProfile = getAreaProfile('prd-assistant');
    const wrongContext: HarnessContextRef = { kind: 'adr', id: 'adr-1' };

    expect(() => validateHarnessContext(prdProfile, wrongContext)).toThrow(
      HarnessProfileError,
    );
    try {
      validateHarnessContext(prdProfile, wrongContext);
    } catch (error) {
      expect((error as HarnessProfileError).code).toBe('invalid-context');
    }

    const homeProfile = getAreaProfile('agent-home');
    expect(() =>
      validateHarnessContext(homeProfile, { kind: 'prd', id: 'prd-1' }),
    ).toThrow(HarnessProfileError);
  });
});
