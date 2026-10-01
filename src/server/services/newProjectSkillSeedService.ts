import fs from 'fs/promises';
import path from 'path';

export const PRODUCT_FOUNDATION_SKILL_PATH = '.agents/skills/product-foundation/SKILL.md';
export const SETUP_CHAT_MODEL = 'gemini-3.8-flash';
export const CANONICAL_SKILL_ROOT = '.agents/skills';
export const CURSOR_SKILL_ROOT = '.cursor/skills';

export interface SkillPackFile {
  relativePath: string;
  content: string;
}

export interface SkillSeedChange {
  path: string;
  content: string;
}

export function buildSkillSeedChanges(files: SkillPackFile[]): SkillSeedChange[] {
  const changes: SkillSeedChange[] = [];
  for (const file of files) {
    const relative = file.relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    changes.push(
      { path: `/${CANONICAL_SKILL_ROOT}/${relative}`, content: file.content },
      { path: `/${CURSOR_SKILL_ROOT}/${relative}`, content: file.content },
    );
  }
  return changes;
}

export async function readNewProjectSkillPack(root = path.join(process.cwd(), 'new-project-skills')): Promise<SkillPackFile[]> {
  const files: SkillPackFile[] = [];
  await walk(root, root, files);
  return files;
}

async function walk(dir: string, root: string, files: SkillPackFile[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, root, files);
      continue;
    }
    if (entry.name !== 'SKILL.md') continue;
    const relativePath = path.relative(root, full).split(path.sep).join('/');
    files.push({ relativePath, content: await fs.readFile(full, 'utf8') });
  }
}

export async function seedNewProjectSkills(adapters: {
  alreadySeeded: () => Promise<boolean>;
  push: (changes: SkillSeedChange[]) => Promise<void>;
  readPack?: () => Promise<SkillPackFile[]>;
}): Promise<void> {
  if (await adapters.alreadySeeded()) return;
  const files = await (adapters.readPack ?? readNewProjectSkillPack)();
  if (files.length === 0) {
    throw new Error('The new-project skill pack is empty');
  }
  await adapters.push(buildSkillSeedChanges(files));
}
