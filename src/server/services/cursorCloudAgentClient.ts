/**
 * My Work cloud-agent adapter. A start is a Cursor SDK cloud agent.
 * Status, activity, and cancel read that same agent. This path does not
 * launch a container job.
 */
import { Agent, type Run, type SDKMessage } from '@cursor/sdk';
import type { SkillProvider } from '../../shared/types/projectSettings';
import type { CloudAgentActivityEvent } from '../../shared/types/devWorkbench';
import { resolveGitRemote } from './repoCacheService';

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
  /** Configured development skill. The prompt already invokes it. */
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
  /** The Cursor run has left the running state. */
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

/** Public HTTPS URL Cursor clones. No local credentials. */
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

function cursorApiKey(): string {
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('CURSOR_API_KEY is not set on the server.');
  }
  return apiKey;
}

function loadCloudRun(cloudAgentId: string, cursorRunId: string): Promise<Run> {
  return Agent.getRun(cursorRunId, {
    runtime: 'cloud',
    agentId: cloudAgentId,
    apiKey: cursorApiKey(),
  });
}

function isTerminalStatus(status: Run['status']): boolean {
  return status === 'finished' || status === 'error' || status === 'cancelled';
}

export function observeCloudRun(run: Run): CloudAgentRunObservation {
  const branches = run.git?.branches ?? [];
  const withPr = branches.find((branch) => branch.prUrl);
  const withBranch = branches.find((branch) => branch.branch);
  const prUrl = withPr?.prUrl ?? null;
  const branchName = withBranch?.branch ?? withPr?.branch ?? null;
  const resultText = run.status === 'error'
    ? (run.error?.message ?? run.result ?? null)
    : (run.result ?? null);
  return {
    status: run.status,
    prUrl,
    resultText,
    branchName,
    baseBranch: null,
    summary: run.result ?? null,
    noChanges: run.status === 'finished' && !branchName && !prUrl,
    settled: isTerminalStatus(run.status),
  };
}

export async function launchCloudAgent(
  input: LaunchCloudAgentInput,
): Promise<LaunchCloudAgentResult> {
  const repoUrl = buildCloudRepoUrl(input.skillProvider, input.project, input.skillRepo);
  const agent = await Agent.create({
    apiKey: cursorApiKey(),
    model: { id: input.model.trim() || 'composer-2.5' },
    name: input.workItemTitle,
    cloud: {
      repos: [{ url: repoUrl, startingRef: input.skillBranch }],
      autoCreatePR: true,
      skipReviewerRequest: true,
    },
  });
  try {
    const run = await agent.send(input.prompt);
    return {
      cloudAgentId: agent.agentId,
      cursorRunId: run.id,
      jobName: 'cursor-sdk',
    };
  } finally {
    await agent[Symbol.asyncDispose]();
  }
}

export async function getCloudAgentRun(input: {
  project: string;
  cloudAgentId: string;
  cursorRunId: string;
}): Promise<CloudAgentRunObservation> {
  const run = await loadCloudRun(input.cloudAgentId, input.cursorRunId);
  return observeCloudRun(run);
}

function clip(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

/** One Cursor SDK stream message becomes one drawer row. */
export function sdkMessageToActivity(
  message: SDKMessage,
  index: number,
): CloudAgentActivityEvent | null {
  switch (message.type) {
    case 'assistant': {
      const text = message.message.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (!text.trim()) return null;
      return {
        id: `assistant:${message.run_id}:${index}`,
        kind: 'assistant',
        title: 'Assistant',
        detail: clip(text, 500),
      };
    }
    case 'thinking':
      if (!message.text.trim()) return null;
      return {
        id: `thinking:${message.run_id}:${index}`,
        kind: 'thinking',
        title: 'Thinking',
        detail: clip(message.text, 500),
      };
    case 'tool_call':
      return {
        id: `tool:${message.call_id}:${message.status}`,
        kind: 'tool',
        title: message.name,
        detail: message.status === 'error' ? 'Failed' : message.status === 'completed' ? 'Completed' : 'Running',
        status: message.status === 'error' ? 'failed' : message.status,
      };
    case 'status':
      return {
        id: `status:${message.run_id}:${message.status}:${index}`,
        kind: 'status',
        title: message.message?.trim() || message.status,
        status: message.status === 'ERROR' ? 'failed' : message.status === 'CANCELLED' ? 'cancelled' : message.status === 'FINISHED' ? 'completed' : 'running',
      };
    case 'task':
      if (!message.text?.trim()) return null;
      return {
        id: `task:${message.run_id}:${index}`,
        kind: 'task',
        title: clip(message.text, 200),
      };
    default:
      return null;
  }
}

export async function* streamCloudAgentRun(input: {
  project: string;
  cloudAgentId: string;
  cursorRunId: string;
}): AsyncGenerator<CloudAgentActivityEvent> {
  const run = await loadCloudRun(input.cloudAgentId, input.cursorRunId);
  if (!run.supports('stream')) {
    throw new Error(run.unsupportedReason('stream') ?? 'This Cursor run cannot be streamed.');
  }
  let index = 0;
  for await (const message of run.stream()) {
    const event = sdkMessageToActivity(message, index);
    index += 1;
    if (event) yield event;
  }
}

export async function cancelCursorCloudAgentRun(input: {
  project: string;
  cloudAgentId: string;
  cursorRunId: string;
}): Promise<void> {
  const run = await loadCloudRun(input.cloudAgentId, input.cursorRunId);
  if (!run.supports('cancel')) {
    throw new Error(run.unsupportedReason('cancel') ?? 'This Cursor run cannot be cancelled.');
  }
  await run.cancel();
}
