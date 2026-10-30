/**
 * Skills an Agent task step can name. Agent task loads Skill files from the Apex repository, so
 * the list is `.cursor/skills/<name>/SKILL.md` there. Every Skill can run. A capability list is
 * optional and only adds extras such as Azure CLI. An unknown capability name stays unavailable.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PlaybookSkillOption } from '../../shared/types/playbook';
import {
  parsePlaybookSkillCapabilities,
  PlaybookExecutionCapabilityError,
} from './playbookExecutionCapabilityService';

const SKILLS_DIR = path.join('.cursor', 'skills');
const CACHE_TTL_MS = 60 * 1000;

let cache: { expiresAt: number; skills: PlaybookSkillOption[] } | null = null;

function frontmatterValue(frontmatter: string, key: string): string {
  const lines = frontmatter.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (index === -1) return '';
  const inline = lines[index].slice(key.length + 1).trim();
  if (inline && inline !== '>' && inline !== '|' && inline !== '>-' && inline !== '|-') {
    return inline.replace(/^['"]|['"]$/g, '');
  }
  const continuation: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (!/^\s+\S/.test(line)) break;
    continuation.push(line.trim());
  }
  return continuation.join(' ');
}

export function describePlaybookSkill(relativePath: string, content: string): PlaybookSkillOption {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
  const folder = path.basename(path.dirname(relativePath));
  let capabilities: string[] | null = null;
  let unavailableReason: string | undefined;
  try {
    capabilities = parsePlaybookSkillCapabilities(content);
  } catch (error) {
    if (!(error instanceof PlaybookExecutionCapabilityError)) throw error;
    unavailableReason = error.message;
  }
  return {
    path: relativePath,
    name: frontmatterValue(frontmatter, 'name') || folder,
    description: frontmatterValue(frontmatter, 'description'),
    capabilities,
    runnable: unavailableReason === undefined,
    ...(unavailableReason ? { unavailableReason } : {}),
  };
}

export async function listPlaybookSkillOptions(): Promise<PlaybookSkillOption[]> {
  if (cache && cache.expiresAt > Date.now()) return cache.skills;
  const root = path.resolve(process.cwd(), SKILLS_DIR);
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const skills: PlaybookSkillOption[] = [];
  for (const folder of entries) {
    const relativePath = [SKILLS_DIR, folder, 'SKILL.md'].join('/').replace(/\\/g, '/');
    try {
      const content = await fs.readFile(path.join(root, folder, 'SKILL.md'), 'utf8');
      skills.push(describePlaybookSkill(relativePath, content));
    } catch {
      // A folder without SKILL.md is not a Skill.
    }
  }
  skills.sort((a, b) => Number(b.runnable) - Number(a.runnable) || a.name.localeCompare(b.name));
  cache = { expiresAt: Date.now() + CACHE_TTL_MS, skills };
  return skills;
}
