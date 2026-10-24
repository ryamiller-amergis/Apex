export const CAB_RELEASE_SKILL_PATH = '.cursor/skills/cab-release/SKILL.md';

export function isCabReleaseSkillPath(path: string | null | undefined): boolean {
  return (path ?? '')
    .replace(/\\/g, '/')
    .toLowerCase()
    .endsWith(CAB_RELEASE_SKILL_PATH.toLowerCase());
}
