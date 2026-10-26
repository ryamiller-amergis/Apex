jest.mock('../services/telemetry', () => ({ trackEvent: jest.fn() }));
jest.mock('../services/featureFlagService', () => ({ isFeatureEnabled: jest.fn() }));
jest.mock('../services/buildAccessService', () => ({ isBuildPairAllowed: jest.fn() }));
jest.mock('../services/userProjectAssignmentService', () => ({ getAssignmentsForProject: jest.fn() }));
jest.mock('../services/projectSettingsService', () => ({
  getSkillConfigById: jest.fn(),
  listSkillConfigsForProject: jest.fn(),
}));
jest.mock('../services/interviewService', () => ({ createInterview: jest.fn() }));
jest.mock('../services/chatAgentService', () => ({ createThread: jest.fn() }));

import { runPreflight, type PreflightPorts, type PipelineDefinitionSummary } from '../services/buildPreflight';
import { RepoReadUnavailableError } from '../services/buildPreflight/ports';
import { sha256Hex } from '../services/buildPreflight/hash';
import { yamlParameterNames } from '../services/buildPreflight/repoReader';
import { designSystemPathCandidates } from '../services/prototypeContextService';
import { redactText } from '../services/buildRedactionService';
import * as interviewService from '../services/interviewService';
import * as chatAgentService from '../services/chatAgentService';
import { BUILD_PROFILE_ROLES, type BuildProfile } from '../../shared/types/build';
import { emptyBuildProfile, type PreflightResult } from '../../shared/types/buildPreflight';
import type { ProjectSkillConfig } from '../../shared/types/projectSettings';

const MANIFEST = JSON.stringify({ typeCheck: 'npm run typecheck', lint: 'npm run lint', relatedTests: 'npm test -- --findRelatedTests', unitSuite: 'npm test' });

function baseFiles(): Record<string, string> {
  const files: Record<string, string> = {
    '.cursor/skills/design-system/SKILL.md': '# Design system',
    '.cursor/rules/react.mdc': 'rule a',
    '.cursor/rules/api.mdc': 'rule b',
    '.cursor/CODEMAP.md': '# Code map',
    '.cursor/environment.json': JSON.stringify({ install: 'npm ci' }),
    'quality.json': MANIFEST,
  };
  for (const role of BUILD_PROFILE_ROLES) files[`.cursor/skills/build-${role}/SKILL.md`] = `# ${role}`;
  return files;
}

function fullProfile(): BuildProfile {
  const p = emptyBuildProfile();
  for (const role of BUILD_PROFILE_ROLES) p.roles[role] = { skillPath: `.cursor/skills/build-${role}/SKILL.md`, model: null };
  p.roles.planner.model = 'planner-m';
  p.caps.costUsd = 25;
  p.qualityManifestPath = 'quality.json';
  p.deployPipelineId = 42;
  p.supportContactUserIds = ['u1', 'stale'];
  return p;
}

function fullRow(overrides: Partial<ProjectSkillConfig> = {}): ProjectSkillConfig {
  return {
    id: 'row-1',
    project: 'P',
    friendlyName: 'Main',
    isDefault: true,
    skillProvider: 'ado',
    skillRepo: 'apex',
    skillBranch: 'main',
    defaultModel: 'default-m',
    developmentModel: 'dev-m',
    interviewSkillOptions: [{ key: 'build-intake', path: '.cursor/skills/build-intake/SKILL.md', friendlyName: 'Build intake' }],
    buildProfile: fullProfile(),
    ...overrides,
  } as ProjectSkillConfig;
}

interface FakeSetup {
  row?: ProjectSkillConfig | null;
  files?: Record<string, string>;
  flags?: Record<string, boolean>;
  allowed?: boolean;
  assigned?: Record<string, string>;
  pipeline?: PipelineDefinitionSummary | null;
  knownSecrets?: string[];
}

function fakePorts(setup: FakeSetup = {}) {
  const files = setup.files ?? baseFiles();
  const flags: Record<string, boolean> = { 'build-from-prompt': true, 'playbook-interview-step': true, ...setup.flags };
  const log = jest.fn();
  const ports: PreflightPorts = {
    loadSettings: jest.fn(async () => (setup.row === undefined ? fullRow() : setup.row)),
    isPairAllowed: jest.fn(async () => setup.allowed ?? true),
    isFlagEnabled: jest.fn(async (flag: string) => flags[flag] ?? false),
    listAssignedUsers: jest.fn(async () => new Map(Object.entries(setup.assigned ?? { u1: 'Ada Admin' }))),
    readFile: jest.fn(async (_c, path: string) => files[path] ?? null),
    listFolder: jest.fn(async (_c, folder: string) => {
      const inFolder = Object.keys(files).filter((p) => p.startsWith(`${folder}/`));
      return inFolder.length > 0 ? inFolder.map((p) => `/${p}`) : null;
    }),
    readPipeline: jest.fn(async () =>
      setup.pipeline === undefined
        ? { enabled: true, repositoryName: 'apex', repositoryId: 'guid', parameterNames: ['commitSha'] }
        : setup.pipeline,
    ),
    redact: (text) => redactText(text, { knownSecrets: () => setup.knownSecrets ?? [] }),
    now: () => new Date('2026-10-26T12:00:00Z'),
    log,
  };
  return { ports, log };
}

const INPUT = { project: 'P', repository: 'apex', userId: 'requester' };

function codes(result: PreflightResult): string[] {
  return result.ok ? [] : result.refusals.map((r) => r.code);
}

function refused(result: PreflightResult) {
  if (result.ok) throw new Error('expected a refusal');
  return result.refusals;
}

describe('TBI-006 DoD-1 / PBI-005 AC-0 — complete profile passes (VT-13)', () => {
  it('returns a deeply frozen configuration with a hash for every file', async () => {
    const result = await runPreflight(INPUT, fakePorts().ports);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { config } = result;
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => { (config.caps as { costUsd: number }).costUsd = 1; }).toThrow();
    expect(() => { (config.roles.planner as { model: string }).model = 'x'; }).toThrow();

    for (const role of BUILD_PROFILE_ROLES) expect(config.roles[role].skillSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(config.standards.designSystem.sha256).toBe(sha256Hex('# Design system'));
    expect(config.standards.codingRules.map((r) => r.path)).toEqual(['.cursor/rules/api.mdc', '.cursor/rules/react.mdc']);
    expect(config.standards.codeMap.sha256).toBe(sha256Hex('# Code map'));
    expect(config.qualityManifest.sha256).toBe(sha256Hex(MANIFEST));
    expect(config.qualityManifest.commands.unitSuite).toBe('npm test');
    expect(config.agentEnvironment.path).toBe('.cursor/environment.json');
    expect(config.pipeline.definitionId).toBe(42);
    expect(config.caps).toEqual({ costUsd: 25, elapsedMinutesPerRevision: 240, maxRevisions: 5, maxParallelism: 4, repairAttempts: 2 });
  });

  it('PBI-004 AC-0: freezes the planner skill and model; PBI-004 AC-2: implementer uses the development model', async () => {
    const result = await runPreflight(INPUT, fakePorts().ports);
    if (!result.ok) throw new Error('expected ok');
    expect(result.config.roles.planner).toMatchObject({ skillPath: '.cursor/skills/build-planner/SKILL.md', model: 'planner-m', modelSource: 'profile' });
    expect(result.config.roles.implementer).toMatchObject({ model: 'dev-m', modelSource: 'developmentModel' });
    expect(result.config.roles.check).toMatchObject({ model: 'default-m', modelSource: 'defaultModel' });
  });

  it('a changed file gives a different hash', async () => {
    const files = { ...baseFiles(), '.cursor/CODEMAP.md': '# Code map v2' };
    const a = await runPreflight(INPUT, fakePorts().ports);
    const b = await runPreflight(INPUT, fakePorts({ files }).ports);
    if (!a.ok || !b.ok) throw new Error('expected ok');
    expect(a.config.standards.codeMap.sha256).not.toBe(b.config.standards.codeMap.sha256);
  });
});

describe('PBI-005 AC-1 — missing code map (VT-14)', () => {
  it('refuses with one plain message naming the code map and the Project Admin', async () => {
    const files = baseFiles();
    delete files['.cursor/CODEMAP.md'];
    const refusals = refused(await runPreflight(INPUT, fakePorts({ files }).ports));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ code: 'code_map_missing', item: 'code map', fixer: 'project_admin' });
    expect(refusals[0].message).toContain('code map');
    expect(refusals[0].message).toContain('Project Admin for P');
    expect(refusals[0].message).toContain('Ada Admin');
  });
});

describe('PBI-005 AC-2 — several items missing at once (VT-15)', () => {
  it('lists every refusal in one result, in check-table order', async () => {
    const files = baseFiles();
    delete files['.cursor/CODEMAP.md'];
    delete files['.cursor/skills/design-system/SKILL.md'];
    delete files['.cursor/environment.json'];
    const result = await runPreflight(INPUT, fakePorts({ files, assigned: {} }).ports);
    expect(codes(result)).toEqual(['support_contact_missing', 'design_system_missing', 'code_map_missing', 'agent_environment_missing']);
  });
});

describe('PBI-005 AC-3 — interview step flag off (VT-16)', () => {
  it('refuses and creates no interview or thread', async () => {
    const result = await runPreflight(INPUT, fakePorts({ flags: { 'playbook-interview-step': false } }).ports);
    expect(codes(result)).toEqual(['flag_interview_step_off']);
    expect(refused(result)[0].fixer).toBe('platform_admin');
    expect(interviewService.createInterview).not.toHaveBeenCalled();
    expect(chatAgentService.createThread).not.toHaveBeenCalled();
  });
});

describe('TBI-006 DoD-0 — each refusal condition has a plain message', () => {
  it('VT-17: build flag off and pair not allow-listed name a Platform Admin', async () => {
    const off = refused(await runPreflight(INPUT, fakePorts({ flags: { 'build-from-prompt': false } }).ports));
    expect(off).toEqual([expect.objectContaining({ code: 'flag_build_off', fixer: 'platform_admin', fixerLabel: 'a Platform Admin' })]);
    const pair = refused(await runPreflight(INPUT, fakePorts({ allowed: false }).ports));
    expect(pair).toEqual([expect.objectContaining({ code: 'pair_not_allow_listed', fixer: 'platform_admin' })]);
    expect(pair[0].message).toContain('allow-list');
  });

  it('VT-18: no settings row; GitHub provider', async () => {
    const none = await runPreflight(INPUT, fakePorts({ row: null }).ports);
    expect(codes(none)).toEqual(['repository_not_configured']);
    const gh = await runPreflight(INPUT, fakePorts({ row: fullRow({ skillProvider: 'github' }) }).ports);
    expect(codes(gh)).toEqual(['provider_unsupported']);
  });

  it('VT-19: planner has no skill; implementer skill file is missing', async () => {
    const profile = fullProfile();
    profile.roles.planner.skillPath = null;
    const files = baseFiles();
    delete files['.cursor/skills/build-implementer/SKILL.md'];
    const refusals = refused(await runPreflight(INPUT, fakePorts({ row: fullRow({ buildProfile: profile }), files }).ports));
    expect(refusals.map((r) => [r.code, r.item])).toEqual([
      ['role_unresolved', 'planner skill'],
      ['role_skill_missing', 'implementer skill'],
    ]);
  });

  it('a role with no resolvable model is refused, never defaulted', async () => {
    const result = await runPreflight(INPUT, fakePorts({ row: fullRow({ defaultModel: null, developmentModel: null }) }).ports);
    expect(refused(result).map((r) => r.item)).toEqual(['intake model', 'implementer model', 'qa model', 'check model']);
  });

  it('VT-20: no enabled build-intake option; option path differs', async () => {
    const absent = await runPreflight(INPUT, fakePorts({ row: fullRow({ interviewSkillOptions: [{ key: 'build-intake', enabled: false, path: '.cursor/skills/build-intake/SKILL.md', friendlyName: 'x' }] }) }).ports);
    expect(codes(absent)).toEqual(['intake_profile_missing']);
    const differs = await runPreflight(INPUT, fakePorts({ row: fullRow({ interviewSkillOptions: [{ key: 'build-intake', path: '.cursor/skills/other/SKILL.md', friendlyName: 'x' }] }) }).ports);
    expect(codes(differs)).toEqual(['intake_profile_missing']);
  });

  it('VT-21: contacts all unassigned or none saved; stale contacts are left out', async () => {
    expect(codes(await runPreflight(INPUT, fakePorts({ assigned: {} }).ports))).toEqual(['support_contact_missing']);
    const profile = fullProfile();
    profile.supportContactUserIds = [];
    expect(codes(await runPreflight(INPUT, fakePorts({ row: fullRow({ buildProfile: profile }) }).ports))).toEqual(['support_contact_missing']);
    const ok = await runPreflight(INPUT, fakePorts().ports);
    if (!ok.ok) throw new Error('expected ok');
    expect(ok.config.supportContacts).toEqual([{ userId: 'u1', displayName: 'Ada Admin' }]);
  });

  it('VT-22: cost cap unset', async () => {
    const profile = fullProfile();
    profile.caps.costUsd = null;
    expect(codes(await runPreflight(INPUT, fakePorts({ row: fullRow({ buildProfile: profile }) }).ports))).toEqual(['caps_unresolved']);
  });

  it('VT-23: design system uses prototypeContextService candidate order, with no bundled fallback', async () => {
    const third = designSystemPathCandidates(null)[2];
    const files = baseFiles();
    delete files['.cursor/skills/design-system/SKILL.md'];
    files[third] = '# third';
    const { ports } = fakePorts({ files });
    const result = await runPreflight(INPUT, ports);
    if (!result.ok) throw new Error('expected ok');
    expect(result.config.standards.designSystem.path).toBe(third);
    const read = (ports.readFile as jest.Mock).mock.calls.map((c) => c[1]);
    expect(read.filter((p: string) => designSystemPathCandidates(null).includes(p))).toEqual(designSystemPathCandidates(null).slice(0, 3));

    const configured = fullRow({ prototypeDesignSystemPath: '.agents/skills/brand/SKILL.md' });
    const files2 = baseFiles();
    delete files2['.cursor/skills/design-system/SKILL.md'];
    const none = await runPreflight(INPUT, fakePorts({ row: configured, files: files2 }).ports);
    expect(codes(none)).toEqual(['design_system_missing']);
    expect(refused(none)[0].message).toContain(designSystemPathCandidates('.agents/skills/brand/SKILL.md')[0]);
  });

  it('VT-24: no rules, environment without install, manifest missing, manifest without lint', async () => {
    const files = baseFiles();
    delete files['.cursor/rules/react.mdc'];
    delete files['.cursor/rules/api.mdc'];
    files['.cursor/rules/README.md'] = 'not a rule';
    files['.cursor/environment.json'] = JSON.stringify({ snapshot: 'x' });
    expect(codes(await runPreflight(INPUT, fakePorts({ files }).ports))).toEqual(['coding_rules_missing', 'agent_environment_missing']);

    const noManifest = baseFiles();
    delete noManifest['quality.json'];
    expect(codes(await runPreflight(INPUT, fakePorts({ files: noManifest }).ports))).toEqual(['quality_manifest_missing']);

    const noLint = { ...baseFiles(), 'quality.json': JSON.stringify({ typeCheck: 'a', relatedTests: 'b', unitSuite: 'c' }) };
    const incomplete = refused(await runPreflight(INPUT, fakePorts({ files: noLint }).ports));
    expect(incomplete).toEqual([expect.objectContaining({ code: 'quality_manifest_incomplete' })]);
    expect(incomplete[0].message).toContain('lint');
  });

  it('VT-25: pipeline not found, disabled, other repository, no parameter; a valid one passes', async () => {
    const cases: Array<[PipelineDefinitionSummary | null, string]> = [
      [null, 'deploy pipeline'],
      [{ enabled: false, repositoryName: 'apex', repositoryId: null, parameterNames: ['commitSha'] }, 'deploy pipeline (disabled)'],
      [{ enabled: true, repositoryName: 'other', repositoryId: 'g', parameterNames: ['branch'] }, 'deploy pipeline (other repository)'],
      [{ enabled: true, repositoryName: 'apex', repositoryId: 'g', parameterNames: ['env'] }, 'deploy pipeline parameter'],
    ];
    for (const [pipeline, item] of cases) {
      const refusals = refused(await runPreflight(INPUT, fakePorts({ pipeline }).ports));
      expect(refusals).toEqual([expect.objectContaining({ code: 'pipeline_unusable', item })]);
    }
    const unset = fullProfile();
    unset.deployPipelineId = null;
    expect(codes(await runPreflight(INPUT, fakePorts({ row: fullRow({ buildProfile: unset }) }).ports))).toEqual(['pipeline_unusable']);
    expect((await runPreflight(INPUT, fakePorts({ pipeline: { enabled: true, repositoryName: 'APEX', repositoryId: 'g', parameterNames: ['branch'] } }).ports)).ok).toBe(true);
  });
});

describe('TBI-006 DoD-2 — secret scan (VT-26)', () => {
  it('refuses a manifest command holding a known secret and names the field, not the value', async () => {
    const secret = 'sup3r-secret-value-123';
    const files = { ...baseFiles(), 'quality.json': JSON.stringify({ typeCheck: 'a', lint: `lint --key ${secret}`, relatedTests: 'b', unitSuite: 'c' }) };
    const refusals = refused(await runPreflight(INPUT, fakePorts({ files, knownSecrets: [secret] }).ports));
    expect(refusals).toEqual([expect.objectContaining({ code: 'secret_in_snapshot', item: 'secret in qualityManifest.commands.lint' })]);
    expect(JSON.stringify(refusals)).not.toContain(secret);
  });

  it('refuses a token-shaped command and passes a clean config full of hex digests', async () => {
    const files = { ...baseFiles(), 'quality.json': JSON.stringify({ typeCheck: 'a', lint: 'lint token=abcdef123456', relatedTests: 'b', unitSuite: 'c' }) };
    expect(codes(await runPreflight(INPUT, fakePorts({ files }).ports))).toEqual(['secret_in_snapshot']);
    const clean = await runPreflight(INPUT, fakePorts().ports);
    expect(clean.ok).toBe(true);
  });
});

describe('PBI-005 security NFR — no host or token in refusal text (VT-27)', () => {
  it('a reader error with host and token gives check_unavailable with neither; the log is redacted', async () => {
    const { ports, log } = fakePorts();
    ports.readFile = jest.fn(async () => {
      throw new RepoReadUnavailableError(new Error('connect failed https://dev.azure.com/org Bearer abcdefghijklmnop'));
    });
    const refusals = refused(await runPreflight(INPUT, ports));
    expect(refusals.every((r) => r.code === 'check_unavailable')).toBe(true);
    const text = JSON.stringify(refusals);
    expect(text).not.toContain('dev.azure.com');
    expect(text).not.toContain('abcdefghijklmnop');
    expect(log).toHaveBeenCalled();
    expect(log.mock.calls.map((c) => c[0]).join('\n')).not.toContain('abcdefghijklmnop');
  });
});

describe('PBI-005 performance NFR — 10 second budget (VT-28)', () => {
  afterEach(() => jest.useRealTimers());

  it('a read that never resolves becomes check_unavailable; other checks still report', async () => {
    jest.useFakeTimers();
    const { ports } = fakePorts({ allowed: false });
    ports.readFile = jest.fn((_c, path: string) =>
      path === '.cursor/CODEMAP.md' ? new Promise<string | null>(() => undefined) : Promise.resolve(baseFiles()[path] ?? null),
    );
    const pending = runPreflight(INPUT, ports);
    await jest.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(codes(result)).toEqual(['pair_not_allow_listed', 'check_unavailable']);
    expect(refused(result)[1].item).toBe('code map');
  });
});

describe('VT-30 — content hash', () => {
  it('identical text gives identical digests; changed text differs; 64 lowercase hex', () => {
    expect(sha256Hex('abc')).toBe(sha256Hex('abc'));
    expect(sha256Hex('abc')).not.toBe(sha256Hex('abd'));
    expect(sha256Hex('abc')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('pipeline YAML parameter parsing', () => {
  it('reads names under a top-level parameters list', () => {
    const yaml = ['trigger: none', 'parameters:', '  - name: commitSha', '    type: string', "  - name: 'branch'", 'stages: []', '  - name: ignored'].join('\n');
    expect(yamlParameterNames(yaml)).toEqual(['commitSha', 'branch']);
  });
});
