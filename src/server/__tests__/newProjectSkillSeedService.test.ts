import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { parseProductBuildBrief } from '../../shared/types/productBuild';
import {
  PRODUCT_DISCOVERY_SKILL_PATH,
  PRODUCT_FOUNDATION_SKILL_PATH,
  PRODUCT_IMPLEMENTATION_SKILL_PATH,
  buildSkillSeedChanges,
  readNewProjectSkillPack,
  seedNewProjectSkills,
} from '../services/newProjectSkillSeedService';

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

  it('names the discovery and implementation skills seeded with the foundation', () => {
    expect(PRODUCT_FOUNDATION_SKILL_PATH).toBe('.agents/skills/product-foundation/SKILL.md');
    expect(PRODUCT_DISCOVERY_SKILL_PATH).toBe('.agents/skills/product-discovery/SKILL.md');
    expect(PRODUCT_IMPLEMENTATION_SKILL_PATH).toBe('.agents/skills/product-implementation/SKILL.md');
  });

  it('reads the full pack in path order', async () => {
    const files = await readNewProjectSkillPack();
    expect(files.map((file) => file.relativePath)).toEqual([
      'product-discovery/SKILL.md',
      'product-foundation/SKILL.md',
      'product-implementation/SKILL.md',
    ]);

    const discovery = files[0].content;
    expect(discovery).toContain('PRODUCT.md');
    expect(discovery).toContain('.ai-pilot/output/product-build-brief.json');
    expect(discovery).toContain('One question at a time');
    expect(discovery).toContain('does not approve the code');
    const example = discovery.match(/```json\r?\n([\s\S]*?)\r?\n```/);
    expect(example).not.toBeNull();
    expect(parseProductBuildBrief(example?.[1] ?? '')).toMatchObject({ kind: 'initial', singlePr: { fitsSinglePr: true } });

    expect(files[1].content).toContain('not the first pull request');
    expect(files[2].content).toContain('docs/product/BUILD_BRIEF.md');
    expect(files[2].content).toContain('Do not commit, push, or open a pull request.');
  });

  it('seeds only the files in a partial pack and does not invent the rest', async () => {
    const push = jest.fn().mockResolvedValue(undefined);
    await seedNewProjectSkills({
      alreadySeeded: async () => false,
      push,
      readPack: async () => [
        { relativePath: 'product-foundation/SKILL.md', content: '# Foundation' },
        { relativePath: 'product-discovery/SKILL.md', content: '# Discovery' },
      ],
    });
    expect(push).toHaveBeenCalledWith([
      { path: '/.agents/skills/product-foundation/SKILL.md', content: '# Foundation' },
      { path: '/.cursor/skills/product-foundation/SKILL.md', content: '# Foundation' },
      { path: '/.agents/skills/product-discovery/SKILL.md', content: '# Discovery' },
      { path: '/.cursor/skills/product-discovery/SKILL.md', content: '# Discovery' },
    ]);
  });
});
