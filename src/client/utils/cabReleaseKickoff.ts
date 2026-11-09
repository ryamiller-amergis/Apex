export { CAB_RELEASE_SKILL_PATH } from '../../shared/utils/cabReleaseSkill';
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

export function normalizeReleaseVersion(value: string): string {
  return value.match(/\d+\.\d+\.\d+(?:\.\d+)?/)?.[0] ?? '';
}

export function normalizeReleaseBranch(value: string): string {
  const version = normalizeReleaseVersion(value);
  return version ? `Release/${version}` : '';
}

export function defaultPreviousReleaseBranch(versions: string[], targetVersion: string): string {
  const normalizedTarget = normalizeReleaseVersion(targetVersion);
  const ordered = versions
    .map(normalizeReleaseVersion)
    .filter(Boolean)
    .sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }),
  );
  const index = ordered.findIndex((version) => version === normalizedTarget);
  if (index > 0) return normalizeReleaseBranch(ordered[index - 1]);
  return '';
}

export function buildCabReleaseKickoffMessage(input: CabReleaseKickoffInput): string {
  const targetVersion = normalizeReleaseVersion(input.targetVersion);
  if (!targetVersion) {
    throw new Error(`Invalid CAB release version: ${input.targetVersion}`);
  }
  const previousReleaseBranch = normalizeReleaseBranch(input.previousReleaseBranch);
  if (!previousReleaseBranch) {
    throw new Error(`Invalid previous release branch: ${input.previousReleaseBranch}`);
  }
  const relatedIds = input.relatedWorkItemIds.filter((id) => Number.isFinite(id) && id > 0);
  const relatedLine = relatedIds.length > 0
    ? relatedIds.join(',')
    : '(none — do not invent a development prod-cd fallback unless I later supply IDs)';
  const snowChoice = input.snowMode === 'run'
    ? 'Run (queue definition 595 SNOW - Create CAB Release Request / mv-application-prod-snow.yml)'
    : 'Dry-run (queue definition 670 SNOW - Create CAB Request - Test / mv-application-qa-snow.yml)';
  const cutChoice = input.cutReleaseBranch
    ? 'Yes — after snow succeeds, create Release/{version} from current development through the CAB broker. Do not git push.'
    : 'No — do not create or push the git branch after snow succeeds';

  return [
    `Run /cab-release for Apex release ${targetVersion}.`,
    '',
    `Target version: ${targetVersion}`,
    `Previous shipped release branch: ${previousReleaseBranch}`,
    `Apex Release Epic id: ${input.apexReleaseEpicId}`,
    `Apex Related work item IDs: ${relatedLine}`,
    `Snow mode: ${snowChoice}`,
    `Cut Release/${targetVersion} from development after snow succeeds: ${cutChoice}`,
    '',
    'Treat the snow mode and cut-branch answers as already confirmed. Do not create the git branch before snow succeeds.',
    'Print skill script stdout back to me: draft path, wiki URL, snow run URL, CHG, Teams paste, and any git cut output.',
  ].join('\n');
}
