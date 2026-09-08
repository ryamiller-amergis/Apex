/**
 * Cursor Cloud Agent adapter. Vendor SDK details stay inside this module.
 * Completion is observed via getCloudAgentRun; a future signed webhook can
 * call the same applyTerminal seam in cloudAgentService.
 */
import { writeFileSync } from 'fs';
import path from 'path';
import { Agent } from '@cursor/sdk';
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
}

export interface LaunchCloudAgentResult {
  cloudAgentId: string;
  cursorRunId: string;
}

export interface CloudAgentRunObservation {
  status: string;
  prUrl: string | null;
  resultText: string | null;
}

function activityStatus(value: unknown): CloudAgentActivityEvent['status'] | undefined {
  if (typeof value !== 'string') return undefined;
  switch (value.toLowerCase()) {
    case 'creating':
    case 'running':
      return 'running';
    case 'finished':
    case 'completed':
      return 'completed';
    case 'error':
    case 'failed':
      return 'failed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return undefined;
  }
}

function displayToolName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'Tool';
  return value.trim().replace(/[_-]+/g, ' ');
}

/** Convert one vendor event into the small, user-safe drawer event contract. */
export function normalizeCloudAgentActivity(
  raw: unknown,
  sequence: number,
): CloudAgentActivityEvent[] {
  if (!raw || typeof raw !== 'object') return [];
  const event = raw as Record<string, unknown>;
  const type = event.type;

  if (type === 'assistant') {
    const message = event.message;
    if (!message || typeof message !== 'object') return [];
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((block, blockIndex) => {
      if (
        !block
        || typeof block !== 'object'
        || (block as { type?: unknown }).type !== 'text'
        || typeof (block as { text?: unknown }).text !== 'string'
      ) {
        return [];
      }
      const text = (block as { text: string }).text.trim();
      return text
        ? [{
            id: `${sequence}:assistant:${blockIndex}`,
            kind: 'assistant' as const,
            title: 'Agent update',
            detail: text.slice(0, 12_000),
          }]
        : [];
    });
  }

  if (type === 'thinking') {
    return [{
      id: `${sequence}:thinking`,
      kind: 'thinking',
      title: 'Analyzing',
      status: 'running',
    }];
  }

  if (type === 'tool_call') {
    const status = activityStatus(event.status) ?? 'running';
    const name = displayToolName(event.name);
    return [{
      id: `${sequence}:tool:${String(event.call_id ?? name)}:${status}`,
      kind: 'tool',
      title: name,
      detail: status === 'running'
        ? 'Started'
        : status === 'completed'
          ? 'Completed'
          : status === 'failed'
            ? 'Failed'
            : 'Cancelled',
      status,
    }];
  }

  if (type === 'task') {
    const detail = typeof event.text === 'string' ? event.text.trim().slice(0, 4_000) : '';
    return [{
      id: `${sequence}:task`,
      kind: 'task',
      title: typeof event.status === 'string' && event.status.trim()
        ? event.status.trim()
        : 'Task update',
      ...(detail ? { detail } : {}),
      status: activityStatus(event.status),
    }];
  }

  if (type === 'status') {
    const status = activityStatus(event.status);
    const detail = typeof event.message === 'string' ? event.message.trim().slice(0, 2_000) : '';
    return [{
      id: `${sequence}:status:${String(event.status ?? 'unknown')}`,
      kind: 'status',
      title: status === 'completed'
        ? 'Run completed'
        : status === 'failed'
          ? 'Run failed'
          : status === 'cancelled'
            ? 'Run cancelled'
            : 'Cloud agent running',
      ...(detail ? { detail } : {}),
      status,
    }];
  }

  if (type === 'request') {
    return [{
      id: `${sequence}:request:${String(event.request_id ?? 'unknown')}`,
      kind: 'status',
      title: 'Agent needs input',
      detail: 'Open the run in Cursor to respond.',
      status: 'running',
    }];
  }

  return [];
}

/** Cloud agents always use the team service-account key from CURSOR_API_KEY. */
export async function resolveCursorApiKey(_project: string): Promise<string> {
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (!apiKey) throw new Error('CURSOR_API_KEY is not set');
  return apiKey;
}

export interface CloudAgentLaunchTarget {
  skillProvider: SkillProvider;
  skillRepo: string;
  skillBranch: string;
  testOverride: string | null;
}

/**
 * Dev-only: CLOUD_AGENT_TEST_GITHUB_REPO=org/repo forces GitHub for launch
 * (service-account path). Work item / prompt stay unchanged.
 */
export function resolveCloudAgentLaunchTarget(
  input: Pick<LaunchCloudAgentInput, 'skillProvider' | 'skillRepo' | 'skillBranch'>,
): CloudAgentLaunchTarget {
  const testRepo = process.env.CLOUD_AGENT_TEST_GITHUB_REPO?.trim();
  if (testRepo) {
    return {
      skillProvider: 'github',
      skillRepo: testRepo,
      skillBranch: process.env.CLOUD_AGENT_TEST_GITHUB_BRANCH?.trim() || 'main',
      testOverride: `github:${testRepo}`,
    };
  }
  return {
    skillProvider: input.skillProvider,
    skillRepo: input.skillRepo,
    skillBranch: input.skillBranch,
    testOverride: null,
  };
}

/** Cloud Agent launches always use the team service-account key. */
export async function resolveLaunchApiKey(input: LaunchCloudAgentInput): Promise<string> {
  return resolveCursorApiKey(input.project);
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

/** Public HTTPS URL for Cursor — no local clone credentials. */
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

function firstPrUrl(git: { branches?: Array<{ prUrl?: string }> } | undefined): string | null {
  const found = git?.branches?.find((branch) => branch.prUrl);
  return found?.prUrl ?? null;
}

// TEMPORARY LOCAL DEBUG — remove before committing.
// CLOUD_AGENT_DRY_RUN=true logs the launch payload and skips the vendor call.
const DRY_RUN_LOG_PATH = path.join(process.cwd(), 'apex-cloud-agent-dry-run.log');

function logDryRunPayload(payload: unknown): void {
  const json = JSON.stringify(payload, null, 2);
  writeFileSync(DRY_RUN_LOG_PATH, `${json}\n`, 'utf8');
  console.log(`[cloud-agent] DRY RUN — payload not sent to Cursor. Full payload: ${DRY_RUN_LOG_PATH}`);
  console.log(json);
}

function resolveCloudEnvironment(
  _project: string,
  skillProvider: SkillProvider,
): { type: 'cloud'; name: string } | undefined {
  const fromEnv = process.env.CLOUD_AGENT_CURSOR_ENV_NAME?.trim();
  if (!fromEnv) return undefined;
  // Named envs carry repo/branch config; skip them for ADO unless explicitly enabled.
  if (skillProvider === 'ado' && process.env.CLOUD_AGENT_ADO_USE_NAMED_ENV !== 'true') {
    return undefined;
  }
  return { type: 'cloud', name: fromEnv };
}

function buildCloudCreateOptions(input: {
  project: string;
  skillProvider: SkillProvider;
  skillRepo: string;
  skillBranch: string;
}): {
  env?: { type: 'cloud'; name: string };
  repos?: Array<{ url: string; startingRef: string }>;
  autoCreatePR: boolean;
} {
  const cloudEnv = resolveCloudEnvironment(input.project, input.skillProvider);
  if (cloudEnv) {
    // Cursor rejects env.name + repos together — named env carries repo/branch config.
    return { env: cloudEnv, autoCreatePR: true };
  }
  const repoUrl = buildCloudRepoUrl(input.skillProvider, input.project, input.skillRepo);
  return {
    repos: [{ url: repoUrl, startingRef: input.skillBranch }],
    autoCreatePR: true,
  };
}

export async function launchCloudAgent(
  input: LaunchCloudAgentInput,
): Promise<LaunchCloudAgentResult> {
  const target = resolveCloudAgentLaunchTarget(input);
  const effectiveInput: LaunchCloudAgentInput = { ...input, ...target };
  if (target.testOverride) {
    console.log('[cloud-agent] test github override', JSON.stringify({
      override: target.testOverride,
      branch: target.skillBranch,
      configuredProvider: input.skillProvider,
      configuredRepo: input.skillRepo,
    }));
  }
  const apiKey = await resolveLaunchApiKey(effectiveInput);
  const cloud = buildCloudCreateOptions(effectiveInput);
  const createInput = {
    apiKey,
    model: { id: input.model },
    cloud,
  };

  if (process.env.CLOUD_AGENT_DRY_RUN === 'true') {
    logDryRunPayload({
      project: input.project,
      skillProvider: effectiveInput.skillProvider,
      skillRepo: effectiveInput.skillRepo,
      skillBranch: effectiveInput.skillBranch,
      testOverride: target.testOverride,
      authMode: 'service-account',
      cloudEnv: cloud.env ?? null,
      repoMode: cloud.repos ? 'explicit' : 'named-environment',
      agentCreate: { ...createInput, apiKey: apiKey ? `set (${apiKey.length} chars)` : 'missing' },
      promptLength: input.prompt.length,
      prompt: input.prompt,
    });
    throw new Error('Cloud Agent dry run — payload logged, nothing sent to Cursor.');
  }

  const agent = await Agent.create(createInput);
  const run = await agent.send(input.prompt);
  return {
    cloudAgentId: agent.agentId,
    cursorRunId: run.id,
  };
}

export async function getCloudAgentRun(input: {
  project: string;
  cloudAgentId: string;
  cursorRunId: string;
}): Promise<CloudAgentRunObservation> {
  const apiKey = await resolveCursorApiKey(input.project);
  const run = await Agent.getRun(input.cursorRunId, {
    runtime: 'cloud',
    agentId: input.cloudAgentId,
    apiKey,
  });
  return {
    status: run.status,
    prUrl: firstPrUrl(run.git),
    resultText: typeof run.result === 'string' ? run.result : null,
  };
}

export async function* streamCloudAgentRun(input: {
  project: string;
  cloudAgentId: string;
  cursorRunId: string;
}): AsyncGenerator<CloudAgentActivityEvent> {
  const apiKey = await resolveCursorApiKey(input.project);
  const run = await Agent.getRun(input.cursorRunId, {
    runtime: 'cloud',
    agentId: input.cloudAgentId,
    apiKey,
  });
  if (!run.supports('stream')) {
    throw new Error(run.unsupportedReason('stream') || 'Cloud Agent activity stream is unavailable.');
  }

  let sequence = 0;
  for await (const event of run.stream()) {
    for (const activity of normalizeCloudAgentActivity(event, sequence++)) {
      yield activity;
    }
  }
}

export async function cancelCursorCloudAgentRun(input: {
  project: string;
  cloudAgentId: string;
  cursorRunId: string;
}): Promise<void> {
  const apiKey = await resolveCursorApiKey(input.project);
  await Agent.cancelRun(input.cursorRunId, {
    runtime: 'cloud',
    agentId: input.cloudAgentId,
    apiKey,
  });
}
