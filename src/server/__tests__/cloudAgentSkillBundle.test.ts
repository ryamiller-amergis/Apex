const mockGetSkill = jest.fn();
const mockGetSkillFile = jest.fn();

jest.mock('../services/skillCatalogFacade', () => ({
  getSkill: (...args: unknown[]) => mockGetSkill(...args),
  getSkillFile: (...args: unknown[]) => mockGetSkillFile(...args),
}));

import {
  CloudAgentSkillLoadError,
  loadCloudAgentSkillBundle,
  SKILL_BUNDLE_MAX_FILES,
  SKILL_BUNDLE_MAX_TOTAL_CHARS,
} from '../services/cloudAgentSkillBundle';

const skillConfig = { skillProvider: 'ado' as const, skillRepo: 'MaxView', skillBranch: 'main' };
const skillPath = '/.cursor/skills/dev-orchestrator/SKILL.md';
const folder = '/.cursor/skills/dev-orchestrator';

function detail(supporting: Array<{ name: string }>) {
  return {
    content: '# Orchestrator',
    supportingFiles: supporting.map((file) => ({ name: file.name, path: `${folder}/${file.name}` })),
  };
}

describe('loadCloudAgentSkillBundle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null when the project has no skill repository', async () => {
    await expect(loadCloudAgentSkillBundle({
      project: 'MaxView',
      skillPath,
      skillConfig: {},
    })).resolves.toBeNull();
    expect(mockGetSkill).not.toHaveBeenCalled();
  });

  it('reads SKILL.md and its text siblings from the configured branch', async () => {
    mockGetSkill.mockResolvedValue(detail([
      { name: 'coordinator.md' },
      { name: 'dev-plan-schema.json' },
      { name: 'apex-skill.json' },
      { name: 'diagram.png' },
    ]));
    mockGetSkillFile.mockImplementation(async (_p: string, _r: string, path: string) => `text of ${path}`);

    const bundle = await loadCloudAgentSkillBundle({ project: 'MaxView', skillPath, skillConfig });

    expect(mockGetSkill).toHaveBeenCalledWith('MaxView', 'MaxView', skillPath, 'main', 'ado');
    expect(bundle?.skillName).toBe('dev-orchestrator');
    expect(bundle?.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'coordinator.md',
      'dev-plan-schema.json',
    ]);
    expect(bundle?.omitted).toEqual([]);
  });

  it('accepts a skill path without a leading slash', async () => {
    mockGetSkill.mockResolvedValue(detail([]));
    await loadCloudAgentSkillBundle({
      project: 'MaxView',
      skillPath: '.cursor/skills/dev-orchestrator/SKILL.md',
      skillConfig,
    });
    expect(mockGetSkill).toHaveBeenCalledWith('MaxView', 'MaxView', skillPath, 'main', 'ado');
  });

  it('throws when the skill cannot be read', async () => {
    mockGetSkill.mockRejectedValue(new Error('TF401174: item not found'));
    await expect(loadCloudAgentSkillBundle({ project: 'MaxView', skillPath, skillConfig }))
      .rejects.toBeInstanceOf(CloudAgentSkillLoadError);
  });

  it('lists a sibling that cannot be read instead of failing the launch', async () => {
    mockGetSkill.mockResolvedValue(detail([{ name: 'a.md' }, { name: 'b.md' }]));
    mockGetSkillFile.mockImplementation(async (_p: string, _r: string, path: string) => {
      if (path.endsWith('a.md')) throw new Error('boom');
      return 'b text';
    });

    const bundle = await loadCloudAgentSkillBundle({ project: 'MaxView', skillPath, skillConfig });

    expect(bundle?.files.map((file) => file.path)).toEqual(['SKILL.md', 'b.md']);
    expect(bundle?.omitted).toEqual(['a.md']);
  });

  it('leaves out files past the file and size limits', async () => {
    const many = Array.from({ length: SKILL_BUNDLE_MAX_FILES + 2 }, (_, i) => ({ name: `f${i}.md` }));
    mockGetSkill.mockResolvedValue(detail(many));
    mockGetSkillFile.mockResolvedValue('x'.repeat(SKILL_BUNDLE_MAX_TOTAL_CHARS / 4));

    const bundle = await loadCloudAgentSkillBundle({ project: 'MaxView', skillPath, skillConfig });

    expect(bundle!.files.length).toBeLessThan(SKILL_BUNDLE_MAX_FILES);
    expect(bundle!.omitted).toEqual(expect.arrayContaining(['f11.md', 'f12.md', 'f13.md']));
    const total = bundle!.files.reduce((sum, file) => sum + file.content.length, 0);
    expect(total).toBeLessThanOrEqual(SKILL_BUNDLE_MAX_TOTAL_CHARS);
  });
});
