import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { buildSkillSeedChanges, readNewProjectSkillPack, seedNewProjectSkills } from '../services/newProjectSkillSeedService';

describe('newProjectSkillSeedService', () => {
  it('writes each skill into the portable folder and the Cursor folder', () => {
    expect(buildSkillSeedChanges([
      { relativePath: 'product-foundation/SKILL.md', content: '# Product' },
    ])).toEqual([
      { path: '/.agents/skills/product-foundation/SKILL.md', content: '# Product' },
      { path: '/.cursor/skills/product-foundation/SKILL.md', content: '# Product' },
    ]);
  });

  it('does not push again when the canonical skill file is already in the repo', async () => {
    const push = jest.fn();
    await seedNewProjectSkills({
      alreadySeeded: async () => true,
      push,
      readPack: async () => [{ relativePath: 'product-foundation/SKILL.md', content: '# Product' }],
    });
    expect(push).not.toHaveBeenCalled();
  });

  it('pushes both copies from the pack', async () => {
    const push = jest.fn().mockResolvedValue(undefined);
    await seedNewProjectSkills({
      alreadySeeded: async () => false,
      push,
      readPack: async () => [{ relativePath: 'product-foundation/SKILL.md', content: '# Product' }],
    });
    expect(push).toHaveBeenCalledWith([
      { path: '/.agents/skills/product-foundation/SKILL.md', content: '# Product' },
      { path: '/.cursor/skills/product-foundation/SKILL.md', content: '# Product' },
    ]);
  });

  it('reads SKILL.md files from a pack directory and skips other files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-pack-'));
    await fs.mkdir(path.join(root, 'product-foundation'), { recursive: true });
    await fs.writeFile(path.join(root, 'README.md'), 'ignore');
    await fs.writeFile(path.join(root, 'product-foundation', 'SKILL.md'), '# Product');

    await expect(readNewProjectSkillPack(root)).resolves.toEqual([
      { relativePath: 'product-foundation/SKILL.md', content: '# Product' },
    ]);
    await fs.rm(root, { recursive: true, force: true });
  });
});
