const mockWhere = jest.fn().mockResolvedValue(undefined);
const mockSet = jest.fn(() => ({ where: mockWhere }));
const mockUpdate = jest.fn(() => ({ set: mockSet }));

jest.mock('../db/drizzle', () => ({ db: { update: (...args: unknown[]) => mockUpdate(...(args as [])) } }));
jest.mock('../services/projectSettingsService', () => ({
  getSkillConfigById: jest.fn(),
  listSkillConfigsForProject: jest.fn(),
}));
jest.mock('../services/userProjectAssignmentService', () => ({ getAssignmentsForProject: jest.fn() }));
jest.mock('../services/telemetry', () => ({ trackEvent: jest.fn() }));

import {
  BuildProfileError,
  loadSettingsForRepository,
  resolveBuildProfile,
  saveBuildProfile,
  type BuildProfileSettingsRow,
} from '../services/buildProfileService';
import * as projectSettingsService from '../services/projectSettingsService';
import * as assignmentService from '../services/userProjectAssignmentService';
import { emptyBuildProfile } from '../../shared/types/buildPreflight';
import type { BuildProfile } from '../../shared/types/build';
import type { ProjectSkillConfig } from '../../shared/types/projectSettings';

const mockGetById = projectSettingsService.getSkillConfigById as jest.Mock;
const mockList = projectSettingsService.listSkillConfigsForProject as jest.Mock;
const mockAssignments = assignmentService.getAssignmentsForProject as jest.Mock;

function profileWith(patch: (p: BuildProfile) => void): BuildProfile {
  const profile = emptyBuildProfile();
  patch(profile);
  return profile;
}

function row(overrides: Partial<ProjectSkillConfig> = {}): ProjectSkillConfig {
  return {
    id: 'row-1',
    project: 'P',
    friendlyName: 'Main',
    isDefault: true,
    skillRepo: 'apex',
    skillBranch: 'main',
    ...overrides,
  } as ProjectSkillConfig;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAssignments.mockResolvedValue([
    { id: 'a1', userId: 'u1', displayName: 'Ada', email: 'ada@x', project: 'P', assignedAt: '' },
  ]);
});

describe('TBI-005 resolveBuildProfile — model fallback chain (VT-05, DoD-1, DoD-3)', () => {
  const models: BuildProfileSettingsRow = {
    buildProfile: null,
    interviewModel: 'interview-m',
    developmentModel: 'dev-m',
    testCaseModel: 'test-m',
    defaultModel: 'default-m',
  };

  it('PBI-004 AC-2: implementer uses developmentModel when its own model is unset', () => {
    const r = resolveBuildProfile(models);
    expect(r.roles.implementer).toMatchObject({ model: 'dev-m', modelSource: 'developmentModel' });
  });

  it('PBI-004 AC-2: implementer uses defaultModel when developmentModel is also unset', () => {
    const r = resolveBuildProfile({ ...models, developmentModel: null });
    expect(r.roles.implementer).toMatchObject({ model: 'default-m', modelSource: 'defaultModel' });
  });

  it('intake uses interviewModel, then defaultModel', () => {
    expect(resolveBuildProfile(models).roles.intake.modelSource).toBe('interviewModel');
    expect(resolveBuildProfile({ ...models, interviewModel: '  ' }).roles.intake.modelSource).toBe('defaultModel');
  });

  it('qa uses testCaseModel, then defaultModel', () => {
    expect(resolveBuildProfile(models).roles.qa.modelSource).toBe('testCaseModel');
    expect(resolveBuildProfile({ ...models, testCaseModel: null }).roles.qa.modelSource).toBe('defaultModel');
  });

  it('planner and check use defaultModel only', () => {
    const r = resolveBuildProfile(models);
    expect(r.roles.planner).toMatchObject({ model: 'default-m', modelSource: 'defaultModel' });
    expect(r.roles.check).toMatchObject({ model: 'default-m', modelSource: 'defaultModel' });
  });

  it('a profile model wins over every fallback', () => {
    const r = resolveBuildProfile({
      ...models,
      buildProfile: profileWith((p) => { p.roles.implementer.model = 'own-m'; }),
    });
    expect(r.roles.implementer).toMatchObject({ model: 'own-m', modelSource: 'profile' });
  });

  it('a role with no resolvable model is listed as unresolved and no value is invented', () => {
    const r = resolveBuildProfile({ buildProfile: null, interviewModel: 'interview-m' });
    expect(r.roles.planner).toMatchObject({ model: null, modelSource: null });
    expect(r.roles.planner.unresolved).toEqual(['skillPath', 'model']);
    expect(r.roles.intake.unresolved).toEqual(['skillPath']);
    expect(r.unresolvedRoles).toEqual(['intake', 'planner', 'implementer', 'qa', 'check']);
  });

  it('applies cap defaults and leaves the cost cap unresolved', () => {
    const r = resolveBuildProfile({ buildProfile: profileWith((p) => {
      p.caps = { costUsd: null, elapsedMinutesPerRevision: null, maxRevisions: null, maxParallelism: null };
    }) });
    expect(r.caps).toEqual({ costUsd: null, elapsedMinutesPerRevision: 240, maxRevisions: 5, maxParallelism: 4 });
    expect(r.capsUnresolved).toEqual(['costUsd']);
  });
});

describe('TBI-005 resolveBuildProfile — completeness and speed (VT-12, NFR)', () => {
  it('a full row resolves under 100 ms; a row missing two skills lists exactly those roles', () => {
    const full = profileWith((p) => {
      for (const role of Object.keys(p.roles) as Array<keyof BuildProfile['roles']>) {
        p.roles[role] = { skillPath: `.cursor/skills/${role}/SKILL.md`, model: 'm' };
      }
      p.caps.costUsd = 10;
    });
    const started = performance.now();
    const resolved = resolveBuildProfile({ buildProfile: full });
    expect(performance.now() - started).toBeLessThan(100);
    expect(resolved.unresolvedRoles).toEqual([]);

    const partial = profileWith((p) => {
      Object.assign(p.roles, full.roles);
      p.roles.qa = { skillPath: null, model: 'm' };
      p.roles.check = { skillPath: null, model: 'm' };
    });
    expect(resolveBuildProfile({ buildProfile: partial }).unresolvedRoles).toEqual(['qa', 'check']);
  });
});

describe('TBI-005 saveBuildProfile (VT-01, DoD-0)', () => {
  it('PBI-004 AC-0: persists only the profile and its audit columns', async () => {
    mockGetById.mockResolvedValue(row({ developmentModel: 'dev-m' }));
    const profile = profileWith((p) => {
      p.roles.planner = { skillPath: '.cursor/skills/planner/SKILL.md', model: 'planner-m' };
      p.supportContactUserIds = ['u1'];
    });

    const saved = await saveBuildProfile({ settingsId: 'row-1', profile, actorOid: 'actor' });

    expect(mockSet).toHaveBeenCalledTimes(1);
    const written = (mockSet.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(Object.keys(written).sort()).toEqual(['buildProfile', 'buildProfileUpdatedAt', 'buildProfileUpdatedBy']);
    expect(written.buildProfile).toBe(profile);
    expect(written.buildProfileUpdatedBy).toBe('actor');
    expect(saved.resolution.roles.planner).toMatchObject({ skillPath: '.cursor/skills/planner/SKILL.md', model: 'planner-m' });
    expect(saved.supportContacts).toEqual([{ userId: 'u1', displayName: 'Ada' }]);
  });

  it('PBI-004 AC-1: refuses an empty contact list and writes nothing', async () => {
    mockGetById.mockResolvedValue(row());
    await expect(
      saveBuildProfile({ settingsId: 'row-1', profile: emptyBuildProfile(), actorOid: 'actor' }),
    ).rejects.toMatchObject({ kind: 'invalid_contacts', fieldErrors: { supportContactUserIds: 'At least one support contact is required.' } });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('refuses a contact who is not assigned to the project (VT-10)', async () => {
    mockGetById.mockResolvedValue(row());
    const profile = profileWith((p) => { p.supportContactUserIds = ['stranger']; });
    await expect(saveBuildProfile({ settingsId: 'row-1', profile, actorOid: null })).rejects.toBeInstanceOf(BuildProfileError);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns not_found for a missing row', async () => {
    mockGetById.mockResolvedValue(null);
    await expect(
      saveBuildProfile({ settingsId: 'nope', profile: emptyBuildProfile(), actorOid: null }),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });
});

describe('loadSettingsForRepository', () => {
  it('matches the repository ignoring case, like the allow-list', async () => {
    mockList.mockResolvedValue([row({ id: 'a', skillRepo: 'Other' }), row({ id: 'b', skillRepo: 'Apex' })]);
    await expect(loadSettingsForRepository('P', 'apex')).resolves.toMatchObject({ id: 'b' });
    await expect(loadSettingsForRepository('P', 'missing')).resolves.toBeNull();
  });
});
