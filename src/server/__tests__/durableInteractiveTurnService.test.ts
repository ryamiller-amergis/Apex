import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RepoReader } from '../../shared/types/repoReader';
import {
  loadDurableInteractiveSkill,
  resolveDurableMaxviewCapability,
  type BuiltInSkillRoot,
} from '../services/durableInteractiveTurnService';

function reader(
  readFile: RepoReader['readFile'],
): RepoReader {
  return {
    identity: {
      provider: 'github',
      project: 'Apex',
      repo: 'Apex',
      sha: 'abc123',
    },
    readFile,
    listDir: jest.fn().mockResolvedValue([]),
    searchCode: jest.fn().mockResolvedValue([]),
  };
}

describe('durable interactive skill loading', () => {
  let tempRoot: string;
  let builtInRoot: string;
  let roots: BuiltInSkillRoot[];

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-skill-'));
    builtInRoot = path.join(tempRoot, '.cursor', 'skills');
    fs.mkdirSync(builtInRoot, { recursive: true });
    roots = [
      {
        requestPrefix: '.cursor/skills',
        absolutePath: builtInRoot,
      },
    ];
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it.each([
    '../../secrets.txt',
    '.cursor/skills/../../../secrets.txt',
  ])('rejects traversal path %s before filesystem resolution', async (skillPath) => {
    await expect(
      loadDurableInteractiveSkill(
        {
          path: skillPath,
          registration: 'built-in',
          pinnedReader: null,
        },
        { builtInRoots: roots },
      ),
    ).rejects.toMatchObject({
      status: 422,
      code: 'INTERACTIVE_V2_SKILL_UNAVAILABLE',
    });
  });

  it('rejects an absolute path before filesystem resolution', async () => {
    const absolute = path.resolve(tempRoot, 'outside-skill.md');
    fs.writeFileSync(absolute, '# outside');

    await expect(
      loadDurableInteractiveSkill(
        {
          path: absolute,
          registration: 'built-in',
          pinnedReader: null,
        },
        { builtInRoots: roots },
      ),
    ).rejects.toMatchObject({
      status: 422,
      code: 'INTERACTIVE_V2_SKILL_UNAVAILABLE',
    });
  });

  it('rejects a parent symlink that escapes the allowlisted root', async () => {
    const outside = path.join(tempRoot, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'SKILL.md'), '# escaped');
    fs.symlinkSync(outside, path.join(builtInRoot, 'escape'), 'junction');

    await expect(
      loadDurableInteractiveSkill(
        {
          path: '.cursor/skills/escape/SKILL.md',
          registration: 'built-in',
          pinnedReader: null,
        },
        { builtInRoots: roots },
      ),
    ).rejects.toMatchObject({
      status: 422,
      code: 'INTERACTIVE_V2_SKILL_UNAVAILABLE',
    });
  });

  it('rejects an unknown unregistered skill without reading a local file', async () => {
    const skillDir = path.join(builtInRoot, 'unknown');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# unknown');

    await expect(
      loadDurableInteractiveSkill(
        {
          path: '.cursor/skills/unknown/SKILL.md',
          registration: 'unknown',
          pinnedReader: null,
        },
        { builtInRoots: roots },
      ),
    ).rejects.toMatchObject({
      status: 422,
      code: 'INTERACTIVE_V2_SKILL_UNAVAILABLE',
    });
  });

  it('does not fall back locally when a legitimate pinned skill read fails', async () => {
    const skillDir = path.join(builtInRoot, 'project-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# wrong local copy');
    const readFile = jest.fn().mockRejectedValue(new Error('pinned read failed'));

    await expect(
      loadDurableInteractiveSkill(
        {
          path: '.cursor/skills/project-skill/SKILL.md',
          registration: 'project',
          pinnedReader: reader(readFile),
        },
        { builtInRoots: roots },
      ),
    ).rejects.toMatchObject({
      status: 422,
      code: 'INTERACTIVE_V2_SKILL_UNAVAILABLE',
    });
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('loads a valid regular built-in skill from its explicit root', async () => {
    const skillDir = path.join(builtInRoot, 'safe');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# safe built-in');

    await expect(
      loadDurableInteractiveSkill(
        {
          path: '.cursor/skills/safe/SKILL.md',
          registration: 'built-in',
          pinnedReader: null,
        },
        { builtInRoots: roots },
      ),
    ).resolves.toEqual({
      path: '.cursor/skills/safe/SKILL.md',
      content: '# safe built-in',
    });
  });

  it('loads a valid registered project skill only through the pinned reader', async () => {
    const readFile = jest.fn().mockResolvedValue('# pinned project skill');

    await expect(
      loadDurableInteractiveSkill(
        {
          path: '.cursor/skills/project-skill/SKILL.md',
          registration: 'project',
          pinnedReader: reader(readFile),
        },
        { builtInRoots: roots },
      ),
    ).resolves.toEqual({
      path: '.cursor/skills/project-skill/SKILL.md',
      content: '# pinned project skill',
    });
    expect(readFile).toHaveBeenCalledWith(
      '.cursor/skills/project-skill/SKILL.md',
    );
  });
});

describe('durable MaxView capability resolution', () => {
  it('freezes enabled only when the requester flag and server config are ready', async () => {
    const evaluate = jest.fn().mockResolvedValue(true);
    const configured = jest.fn().mockReturnValue(true);

    await expect(
      resolveDurableMaxviewCapability(
        { userId: 'authorized-admin', project: 'Apex' },
        { evaluate, isConfigured: configured },
      ),
    ).resolves.toBe('enabled');
    expect(evaluate).toHaveBeenCalledWith('maxview-mcp', {
      userId: 'authorized-admin',
      project: 'Apex',
    });
    expect(configured).toHaveBeenCalledTimes(1);
  });

  it('returns explicit unavailable when the enabled capability lacks config', async () => {
    await expect(
      resolveDurableMaxviewCapability(
        { userId: 'user-1', project: 'Apex' },
        {
          evaluate: jest.fn().mockResolvedValue(true),
          isConfigured: jest.fn().mockReturnValue(false),
        },
      ),
    ).resolves.toBe('unavailable');
  });

  it.each([
    ['disabled', jest.fn().mockResolvedValue(false)],
    ['evaluation-error', jest.fn().mockRejectedValue(new Error('unavailable'))],
  ] as const)('returns disabled when the registration flag is %s', async (
    _case,
    evaluate,
  ) => {
    const configured = jest.fn().mockReturnValue(true);

    await expect(
      resolveDurableMaxviewCapability(
        { userId: 'user-1', project: 'Apex' },
        { evaluate, isConfigured: configured },
      ),
    ).resolves.toBe('disabled');
    expect(configured).not.toHaveBeenCalled();
  });
});
