import { skillNameFromPath } from '../skillPaths';
import type { ProjectSkillConfig } from '../types/projectSettings';

export const DEFAULT_DEVELOPMENT_SKILL_PATH = '.cursor/skills/dev-orchestrator/SKILL.md';
export const DEFAULT_DEVELOPMENT_MODEL = 'composer-2.5';

export interface ResolvedDevelopmentSettings {
  skillPath: string;
  skillName: string | null;
  model: string;
  configuredSkillPath: string | null;
  configuredModel: string | null;
}

export function resolveDevelopmentSettings(
  skillConfig: Pick<ProjectSkillConfig, 'developmentSkillPath' | 'developmentModel'> | null | undefined,
): ResolvedDevelopmentSettings {
  const configuredSkillPath = skillConfig?.developmentSkillPath?.trim() || null;
  const configuredModel = skillConfig?.developmentModel?.trim() || null;
  const skillPath = configuredSkillPath || DEFAULT_DEVELOPMENT_SKILL_PATH;
  return {
    skillPath,
    skillName: skillNameFromPath(skillPath),
    model: configuredModel || DEFAULT_DEVELOPMENT_MODEL,
    configuredSkillPath,
    configuredModel,
  };
}

const CLI_SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Skill name safe to pass as a `/name` invocation on the Cursor CLI. */
export function developmentCliSkillName(
  settings: Pick<ResolvedDevelopmentSettings, 'configuredSkillPath' | 'skillName'>,
): string | null {
  if (!settings.configuredSkillPath) return null;
  const name = settings.skillName?.trim() || null;
  if (!name || !CLI_SKILL_NAME_RE.test(name)) return null;
  return name;
}

/** Puts `/skill-name` at the start of the prompt the CLI receives. */
export function prefixDevelopmentSkillInvocation(
  prompt: string,
  settings: Pick<ResolvedDevelopmentSettings, 'configuredSkillPath' | 'skillName'>,
): string {
  const name = developmentCliSkillName(settings);
  if (!name) return prompt;
  const invocation = `/${name}`;
  if (prompt.startsWith(`${invocation}\n`) || prompt === invocation) return prompt;
  return `${invocation}\n\n${prompt}`;
}

export function buildCloudDevelopmentKickoffSection(
  settings: ResolvedDevelopmentSettings,
): string {
  const skillLabel = settings.skillName ?? settings.skillPath;
  const headline = settings.configuredSkillPath
    ? `This project is configured to use the **${skillLabel}** development skill.`
    : `No development skill is configured for this project. Defaulting to **${skillLabel}**.`;
  const modelLine = settings.configuredModel
    ? `Model override: \`${settings.model}\`.`
    : `Default model: \`${settings.model}\` (no model override).`;
  // An unconfigured default may not exist in the target repository.
  const loadLine = settings.configuredSkillPath
    ? `Load the skill from the repository and follow it exactly.`
    : `Load the skill from the repository and follow it exactly if it exists there. If it does not, implement from the design artifacts below and follow the repository's existing conventions.`;

  return [
    `## Development skill`,
    ``,
    headline,
    `- Skill path: \`${settings.skillPath}\``,
    `- ${modelLine}`,
    ``,
    loadLine,
    `Run unit, e2e, and WCAG checks before opening a pull request.`,
  ].join('\n');
}
