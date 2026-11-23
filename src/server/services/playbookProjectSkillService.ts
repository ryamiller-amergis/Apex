import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import type { PlaybookSkillOption } from '../../shared/types/playbook';
import { db } from '../db/drizzle';
import {
  projectPlaybookSkillFiles,
  projectPlaybookSkillVersions,
  projectPlaybookSkills,
} from '../db/schema';
import { bundleHashV1, type SkillBundleCompanion } from './playbookSkillBundle';
import { declaredSkillType, parsePlaybookSkillFrontmatter } from './playbookSkillFrontmatter';

const PROJECT_SKILL_PATH =
  /^project-skills\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/SKILL\.md$/i;

const MAX_SKILL_BYTES = 200_000;
/** Attached reference and instruction files. Matches the database check on project_playbook_skill_files. */
export const MAX_COMPANION_BYTES = 1_000_000;

export function projectSkillVersionIdFromPath(skillPath: string): string | null {
  const match = skillPath.replace(/\\/g, '/').match(PROJECT_SKILL_PATH);
  return match?.[1] ?? null;
}

export function projectSkillPath(versionId: string): string {
  return `project-skills/${versionId}/SKILL.md`;
}

export interface StoredProjectSkill {
  content: string;
  companions: SkillBundleCompanion[];
}

export async function loadStoredProjectSkill(versionId: string): Promise<StoredProjectSkill | null> {
  const version = await db.query.projectPlaybookSkillVersions.findFirst({
    where: eq(projectPlaybookSkillVersions.id, versionId),
    with: { files: true },
  });
  if (!version) return null;
  return {
    content: version.content,
    companions: version.files.map((file) => ({
      path: file.fileName,
      content: file.content,
      classification: file.classification,
    })),
  };
}

function contentSha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function listProjectPlaybookSkillOptions(project: string): Promise<PlaybookSkillOption[]> {
  const skills = await db.query.projectPlaybookSkills.findMany({
    where: eq(projectPlaybookSkills.project, project),
    with: {
      versions: {
        where: eq(projectPlaybookSkillVersions.status, 'published'),
        orderBy: desc(projectPlaybookSkillVersions.versionNumber),
        limit: 1,
      },
    },
  });
  const options: PlaybookSkillOption[] = [];
  for (const skill of skills) {
    const version = skill.versions[0];
    if (!version) continue;
    let description = '';
    try {
      description = parsePlaybookSkillFrontmatter(version.content).description;
    } catch {
      description = '';
    }
    options.push({
      path: projectSkillPath(version.id),
      name: skill.name,
      description,
      capabilities: null,
      runnable: true,
      group: 'project',
      skillType: declaredSkillType(version.content),
    });
  }
  options.sort((a, b) => a.name.localeCompare(b.name));
  return options;
}

export class ProjectPlaybookSkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectPlaybookSkillError';
  }
}

export async function saveProjectPlaybookSkill(input: {
  project: string;
  content: string;
  createdBy: string;
  companions?: SkillBundleCompanion[];
  status?: 'draft' | 'published';
  /** The incident move is the one skill allowed to declare a capability. */
  allowCapabilities?: boolean;
}): Promise<{ skillId: string; versionId: string; path: string }> {
  const frontmatter = parsePlaybookSkillFrontmatter(input.content);
  if (frontmatter.declaresCapabilities && !input.allowCapabilities) {
    throw new ProjectPlaybookSkillError('A new project skill cannot declare playbook capabilities.');
  }
  if (Buffer.byteLength(input.content, 'utf8') > MAX_SKILL_BYTES) {
    throw new ProjectPlaybookSkillError('The skill is over 200,000 bytes.');
  }
  if (!input.allowCapabilities && !frontmatter.skillType) {
    throw new ProjectPlaybookSkillError('The skill needs a type: autonomous or interactive.');
  }
  const companions = input.companions ?? [];
  const companionName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.[A-Za-z0-9]{1,16}$/;
  for (const companion of companions) {
    if (!companionName.test(companion.path) || companion.path.toUpperCase() === 'SKILL.MD') {
      throw new ProjectPlaybookSkillError(`"${companion.path}" is not a valid companion file name.`);
    }
    if (companion.classification !== 'instruction' && companion.classification !== 'reference') {
      throw new ProjectPlaybookSkillError(`"${companion.path}" must be an instruction or a reference.`);
    }
    if (companion.content.includes('\u0000')) {
      throw new ProjectPlaybookSkillError(`"${companion.path}" is not a text file.`);
    }
    if (Buffer.byteLength(companion.content, 'utf8') > MAX_COMPANION_BYTES) {
      throw new ProjectPlaybookSkillError(`"${companion.path}" is over 1 MB.`);
    }
  }
  const existing = await db.query.projectPlaybookSkills.findFirst({
    where: and(
      eq(projectPlaybookSkills.project, input.project),
      eq(projectPlaybookSkills.name, frontmatter.name),
    ),
    columns: { id: true },
  });
  const skillId = existing?.id ?? (await db.insert(projectPlaybookSkills).values({
    project: input.project,
    name: frontmatter.name,
    createdBy: input.createdBy,
  }).returning({ id: projectPlaybookSkills.id }))[0].id;

  const latest = await db.query.projectPlaybookSkillVersions.findFirst({
    where: eq(projectPlaybookSkillVersions.skillId, skillId),
    orderBy: desc(projectPlaybookSkillVersions.versionNumber),
    columns: { versionNumber: true },
  });
  const versionNumber = (latest?.versionNumber ?? 0) + 1;
  const versionId = randomUUID();
  const bundleSha256 = bundleHashV1({
    skillVersionId: versionId,
    skillContent: input.content,
    companions,
  });
  await db.insert(projectPlaybookSkillVersions).values({
    id: versionId,
    skillId,
    versionNumber,
    content: input.content,
    skillType: frontmatter.skillType,
    outputKind: frontmatter.outputKind,
    contentSha256: contentSha256(input.content),
    bundleSha256,
    status: input.status ?? 'published',
    createdBy: input.createdBy,
  });
  if (companions.length > 0) {
    await db.insert(projectPlaybookSkillFiles).values(companions.map((companion) => ({
      versionId,
      fileName: companion.path,
      content: companion.content,
      classification: companion.classification,
    })));
  }
  return { skillId, versionId, path: projectSkillPath(versionId) };
}

async function foundationSkillsDir(): Promise<string | null> {
  const candidates = [
    path.resolve(process.cwd(), 'foundation-skills', 'foundation'),
    path.resolve(__dirname, '..', '..', '..', 'foundation-skills', 'foundation'),
    path.resolve(__dirname, '..', '..', 'foundation-skills', 'foundation'),
  ];
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate)).isDirectory()) return candidate;
    } catch {
      // This layout does not have the folder.
    }
  }
  return null;
}

async function readFoundationSkill(folder: string): Promise<{ content: string; companions: SkillBundleCompanion[] } | null> {
  const root = await foundationSkillsDir();
  if (!root) return null;
  const dir = path.join(root, folder);
  let content: string;
  try {
    content = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
  if (!/^playbook-capabilities:/m.test(content)) {
    content = content.replace(/^---\r?\n/, '---\nplaybook-capabilities: [azure-cli]\n');
  }
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    names = [];
  }
  const companions: SkillBundleCompanion[] = [];
  for (const name of names.sort()) {
    if (name === 'SKILL.md' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.md$/.test(name)) continue;
    const bytes = await fs.readFile(path.join(dir, name));
    if (bytes.byteLength > MAX_SKILL_BYTES) continue;
    companions.push({
      path: name,
      content: bytes.toString('utf8'),
      classification: name === 'RESOURCE_CATALOG.md' ? 'reference' : 'instruction',
    });
  }
  return { content, companions };
}

/** Copy the MaxView incident skill into that project's library once. */
export async function ensureMaxviewIncidentProjectSkill(project: string, createdBy: string): Promise<void> {
  if (!/maxview/i.test(project)) return;
  const existing = await db.query.projectPlaybookSkills.findFirst({
    where: and(
      eq(projectPlaybookSkills.project, project),
      eq(projectPlaybookSkills.name, 'maxview-incident-investigation'),
    ),
    columns: { id: true },
  });
  if (existing) return;
  const source = await readFoundationSkill('maxview-incident-investigation');
  if (!source) return;
  await saveProjectPlaybookSkill({
    project,
    content: source.content,
    createdBy,
    companions: source.companions,
    status: 'published',
    allowCapabilities: true,
  });
}

export interface ProjectSkillLibraryFile {
  id: string;
  fileName: string;
  classification: 'instruction' | 'reference';
  content: string;
}

export interface ProjectSkillLibraryVersion {
  id: string;
  versionNumber: number;
  status: 'draft' | 'published';
  skillType: string | null;
  outputKind: string | null;
  content: string;
  createdBy: string;
  createdAt: string;
  files: ProjectSkillLibraryFile[];
}

export interface ProjectSkillLibraryItem {
  id: string;
  name: string;
  description: string;
  versions: ProjectSkillLibraryVersion[];
}

export async function listProjectSkillLibrary(project: string): Promise<ProjectSkillLibraryItem[]> {
  const skills = await db.query.projectPlaybookSkills.findMany({
    where: eq(projectPlaybookSkills.project, project),
    with: {
      versions: {
        orderBy: desc(projectPlaybookSkillVersions.versionNumber),
        with: { files: true },
      },
    },
  });
  return skills
    .map((skill) => {
      const latest = skill.versions[0];
      let description = '';
      if (latest) {
        try {
          description = parsePlaybookSkillFrontmatter(latest.content).description;
        } catch {
          description = '';
        }
      }
      return {
        id: skill.id,
        name: skill.name,
        description,
        versions: skill.versions.map((version) => ({
          id: version.id,
          versionNumber: version.versionNumber,
          status: version.status,
          skillType: version.skillType,
          outputKind: version.outputKind,
          content: version.content,
          createdBy: version.createdBy,
          createdAt: version.createdAt,
          files: version.files.map((file) => ({
            id: file.id,
            fileName: file.fileName,
            classification: file.classification,
            content: file.content,
          })),
        })),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
