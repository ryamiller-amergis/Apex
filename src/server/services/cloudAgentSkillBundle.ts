/**
 * Reads the skill a Cloud Agent run uses from the project's skill repository,
 * so the prompt can carry it. The agent works in a clone that may not have
 * the skill at that path or branch.
 */
import { normalizeRepoRelativePath, skillNameFromPath } from '../../shared/skillPaths';
import type { ProjectSkillConfig } from '../../shared/types/projectSettings';
import type {
  CloudAgentSkillBundle,
  CloudAgentSkillBundleFile,
} from '../../shared/utils/developmentKickoff';
import * as skillCatalog from './skillCatalogFacade';

export const SKILL_BUNDLE_MAX_FILES = 12;
export const SKILL_BUNDLE_MAX_TOTAL_CHARS = 100_000;

const TEXT_FILE = /\.(md|mdx|json|txt|ya?ml)$/i;
const APEX_CONTRACT_FILE = 'apex-skill.json';

export class CloudAgentSkillLoadError extends Error {
  constructor(public readonly skillPath: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'CloudAgentSkillLoadError';
  }
}

function relativeToSkillFolder(filePath: string, folder: string): string {
  const normalized = normalizeRepoRelativePath(filePath);
  return normalized.startsWith(`${folder}/`) ? normalized.slice(folder.length + 1) : normalized;
}

/**
 * Returns null when the project has no skill repository settings.
 * Throws CloudAgentSkillLoadError when the skill itself cannot be read.
 * A sibling file that cannot be read, or does not fit the limits, is listed in `omitted`.
 */
export async function loadCloudAgentSkillBundle(input: {
  project: string;
  skillPath: string;
  skillConfig: Pick<ProjectSkillConfig, 'skillProvider' | 'skillRepo' | 'skillBranch'> | null | undefined;
}): Promise<CloudAgentSkillBundle | null> {
  const repo = input.skillConfig?.skillRepo?.trim();
  const provider = input.skillConfig?.skillProvider;
  if (!repo || !provider) return null;
  const branch = input.skillConfig?.skillBranch?.trim() || undefined;

  const normalized = normalizeRepoRelativePath(input.skillPath);
  const folder = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';

  let detail: Awaited<ReturnType<typeof skillCatalog.getSkill>>;
  try {
    detail = await skillCatalog.getSkill(input.project, repo, `/${normalized}`, branch, provider);
  } catch (err) {
    throw new CloudAgentSkillLoadError(input.skillPath, err);
  }
  if (!detail.content?.trim()) {
    throw new CloudAgentSkillLoadError(input.skillPath, new Error('The skill file is empty.'));
  }

  const files: CloudAgentSkillBundleFile[] = [{ path: 'SKILL.md', content: detail.content }];
  const omitted: string[] = [];
  let total = detail.content.length;

  const candidates = detail.supportingFiles.filter((file) => {
    const name = file.name;
    return name !== APEX_CONTRACT_FILE && TEXT_FILE.test(name);
  });
  const wanted = candidates.slice(0, SKILL_BUNDLE_MAX_FILES - 1);
  for (const file of candidates.slice(SKILL_BUNDLE_MAX_FILES - 1)) {
    omitted.push(relativeToSkillFolder(file.path, folder));
  }

  const reads = await Promise.allSettled(
    wanted.map((file) => skillCatalog.getSkillFile(input.project, repo, file.path, branch, provider)),
  );
  reads.forEach((read, index) => {
    const relative = relativeToSkillFolder(wanted[index].path, folder);
    if (read.status === 'rejected' || !read.value.trim()) {
      omitted.push(relative);
      return;
    }
    if (total + read.value.length > SKILL_BUNDLE_MAX_TOTAL_CHARS) {
      omitted.push(relative);
      return;
    }
    total += read.value.length;
    files.push({ path: relative, content: read.value });
  });

  return { skillName: skillNameFromPath(normalized), files, omitted };
}
