export const CAB_RELEASE_SKILL_PATH = '.cursor/skills/cab-release/SKILL.md';
export const CAB_RELEASE_SKILL_NAME = 'cab-release';
export const RELEASE_CAB_REQUEST_FLAG = 'release-cab-request';

export type CabSnowMode = 'dry-run' | 'run';

export interface CabReleaseKickoffInput {
  targetVersion: string;
  apexReleaseEpicId: number;
  relatedWorkItemIds: number[];
  previousReleaseBranch: string;
  snowMode: CabSnowMode;
  cutReleaseBranch: boolean;
}

export interface CreateCabRequestFormValues {
  previousReleaseBranch: string;
  snowMode: CabSnowMode;
  cutReleaseBranch: boolean;
}

export function normalizeReleaseBranch(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.toLowerCase().startsWith('release/')) return `Release/${trimmed.slice('release/'.length)}`;
  return `Release/${trimmed}`;
}

export function defaultPreviousReleaseBranch(sortedVersions: string[], targetVersion: string): string {
  const index = sortedVersions.findIndex((version) => version === targetVersion);
  if (index > 0) return normalizeReleaseBranch(sortedVersions[index - 1]);
  if (sortedVersions.length > 0 && sortedVersions[0] !== targetVersion) {
    return normalizeReleaseBranch(sortedVersions[sortedVersions.length - 1]);
  }
  return '';
}

export function buildCabReleaseKickoffMessage(input: CabReleaseKickoffInput): string {
  const relatedIds = input.relatedWorkItemIds.filter((id) => Number.isFinite(id) && id > 0);
  const relatedLine = relatedIds.length > 0
    ? relatedIds.join(',')
    : '(none — do not invent a development prod-cd fallback unless I later supply IDs)';
  const snowChoice = input.snowMode === 'run'
    ? 'Run (queue definition 595 SNOW - Create CAB Release Request / mv-application-prod-snow.yml)'
    : 'Dry-run (queue definition 670 SNOW - Create CAB Request - Test / mv-application-qa-snow.yml)';
  const cutChoice = input.cutReleaseBranch
    ? 'Yes — after snow succeeds, create and push Release/{version} from current development'
    : 'No — do not create or push the git branch after snow succeeds';

  return [
    `Run /cab-release for Apex release ${input.targetVersion}.`,
    '',
    `Target version: ${input.targetVersion}`,
    `Previous shipped release branch: ${input.previousReleaseBranch}`,
    `Apex Release Epic id: ${input.apexReleaseEpicId}`,
    `Apex Related work item IDs: ${relatedLine}`,
    `Snow mode: ${snowChoice}`,
    `Cut Release/${input.targetVersion} from development after snow succeeds: ${cutChoice}`,
    '',
    'Treat the snow mode and cut-branch answers as already confirmed. Do not create the git branch before snow succeeds.',
    'Print skill script stdout back to me: draft path, wiki URL, snow run URL, CHG, Teams paste, and any git cut output.',
  ].join('\n');
}
