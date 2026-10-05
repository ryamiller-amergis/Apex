/**
 * My Work cloud-agent adapter. A run is one Container Apps execution that
 * clones the repo and runs the Cursor CLI. It does not call the Cloud Agents SDK.
 */
import type { SkillProvider } from '../../shared/types/projectSettings';
import type { CloudAgentActivityEvent } from '../../shared/types/devWorkbench';
import { resolveGitRemote } from './repoCacheService';
import {
  cancelCursorContainerCliRun,
  getCursorContainerCliRun,
  isContainerAgentId,
  launchCursorContainerCli,
  streamCursorContainerCliRun,
} from './cursorContainerCliService';

export interface LaunchCloudAgentInput {
  project: string;
  prompt: string;
  model: string;
  skillProvider: SkillProvider;
  skillRepo: string;
  skillBranch: string;
  workItemId?: number;
  workItemTitle?: string;
  initiatorName?: string;
  initiatorEmail?: string;
  /** Configured development skill. The container CLI invokes it as `/name`. */
  skillName?: string;
  /** Azure DevOps token for the developer who started the run. Used only to open the pull request. */
  adoUserToken?: string | null;
}

export interface LaunchCloudAgentResult {
  cloudAgentId: string;
  cursorRunId: string;
  jobName: string;
  branchName?: string;
}

export interface CloudAgentRunObservation {
  status: string;
  prUrl: string | null;
  resultText: string | null;
  branchName?: string | null;
  baseBranch?: string | null;
  summary?: string | null;
  /** The agent changed no files, so no branch was pushed. */
  noChanges?: boolean;
  /** `APEX_RUN_SETTLED` is in the logs, after the CLI exit and branch markers. */
  settled?: boolean;
}

export function toCloudRepoUrl(remoteUrl: string): string {
  return remoteUrl.replace(/\.git$/i, '');
}

function buildGitHubCloudRepoUrl(skillRepo: string): string {
  const slash = skillRepo.indexOf('/');
  const configuredOrg = process.env.GITHUB_ORG?.trim() || '';
  const org = slash > 0 ? skillRepo.slice(0, slash).trim() : configuredOrg;
  const repository = slash > 0 ? skillRepo.slice(slash + 1).trim() : skillRepo.trim();
  if (!org || !repository) {
    throw new Error(
      'GitHub repo must be owner/name (e.g. amergis/Apex) or set GITHUB_ORG for repo-only values.',
    );
  }
  return `https://github.com/${encodeURIComponent(org)}/${encodeURIComponent(repository)}`;
}

/** Public HTTPS URL for the container clone. No local credentials. */
export function buildCloudRepoUrl(
  skillProvider: SkillProvider,
  project: string,
  skillRepo: string,
): string {
  if (skillProvider === 'github') {
    return buildGitHubCloudRepoUrl(skillRepo);
  }
  const remote = resolveGitRemote(skillProvider, project, skillRepo);
  return toCloudRepoUrl(remote.url);
}

export async function launchCloudAgent(
  input: LaunchCloudAgentInput,
): Promise<LaunchCloudAgentResult> {
  const repoUrl = buildCloudRepoUrl(input.skillProvider, input.project, input.skillRepo);
  return launchCursorContainerCli({
    prompt: input.prompt,
    model: input.model,
    skillBranch: input.skillBranch,
    workItemId: input.workItemId,
    workItemTitle: input.workItemTitle,
    authorName: input.initiatorName,
    authorEmail: input.initiatorEmail,
    skillName: input.skillName,
    adoUserToken: input.adoUserToken,
    repoUrl,
  });
}

export async function getCloudAgentRun(input: {
  project: string;
  cloudAgentId: string;
  cursorRunId: string;
}): Promise<CloudAgentRunObservation> {
  if (!isContainerAgentId(input.cloudAgentId)) {
    throw new Error('This run was not started as a container CLI job.');
  }
  return getCursorContainerCliRun(input.cursorRunId);
}

export async function* streamCloudAgentRun(input: {
  project: string;
  cloudAgentId: string;
  cursorRunId: string;
}): AsyncGenerator<CloudAgentActivityEvent> {
  if (!isContainerAgentId(input.cloudAgentId)) {
    throw new Error('This run was not started as a container CLI job.');
  }
  yield* streamCursorContainerCliRun(input.cursorRunId);
}

export async function cancelCursorCloudAgentRun(input: {
  project: string;
  cloudAgentId: string;
  cursorRunId: string;
}): Promise<void> {
  if (!isContainerAgentId(input.cloudAgentId)) {
    throw new Error('This run was not started as a container CLI job.');
  }
  await cancelCursorContainerCliRun(input.cursorRunId);
}
