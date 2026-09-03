/**
 * Cursor Cloud Agent adapter. Vendor SDK details stay inside this module.
 * Completion is observed via getCloudAgentRun; a future signed webhook can
 * call the same applyTerminal seam in cloudAgentService.
 */
import { writeFileSync } from 'fs';
import path from 'path';
import { Agent } from '@cursor/sdk';
import type { SkillProvider } from '../../shared/types/projectSettings';
import { fetchCursorApiKeyInfo, mintCursorUserSubToken } from './cursorSubTokenService';
import { resolveGitRemote } from './repoCacheService';

export interface LaunchCloudAgentInput {
  project: string;
  prompt: string;
  model: string;
  skillProvider: SkillProvider;
  skillRepo: string;
  skillBranch: string;
  /** Required for ADO — mints a user-scoped Cursor token for repo access. */
  userEmail?: string;
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

/** Cloud agents always use the team service-account key from CURSOR_API_KEY. */
export async function resolveCursorApiKey(_project: string): Promise<string> {
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (!apiKey) throw new Error('CURSOR_API_KEY is not set');
  return apiKey;
}

/**
 * ADO launches use a 1-hour user-scoped sub-token so Cursor validates repo
 * access like the UI (connected Azure DevOps user). GitHub keeps the service account.
 */
export async function resolveLaunchApiKey(input: LaunchCloudAgentInput): Promise<string> {
  const serviceAccountKey = await resolveCursorApiKey(input.project);
  if (input.skillProvider !== 'ado') {
    return serviceAccountKey;
  }
  const userEmail = input.userEmail?.trim();
  if (!userEmail) {
    throw new Error(
      'User email is required to launch Cloud Development on Azure DevOps repositories.',
    );
  }
  const minted = await mintCursorUserSubToken({
    serviceAccountApiKey: serviceAccountKey,
    forUserEmail: userEmail,
  });
  const [serviceAccountInfo, subTokenInfo] = await Promise.all([
    fetchCursorApiKeyInfo(serviceAccountKey).catch(() => null),
    fetchCursorApiKeyInfo(minted.accessToken),
  ]);
  console.log('[cloud-agent] sub-token minted', JSON.stringify({
    forUserEmail: userEmail,
    cursorUserId: minted.userId,
    teamId: minted.teamId,
    expiresAt: minted.expiresAt,
    serviceAccountKeyName: serviceAccountInfo?.apiKeyName ?? null,
    serviceAccountLooksUserScoped: Boolean(serviceAccountInfo?.userEmail),
    subTokenMeUserEmail: subTokenInfo.userEmail ?? null,
    subTokenMeUserId: subTokenInfo.userId ?? null,
  }));
  if (serviceAccountInfo?.userEmail) {
    throw new Error(
      'CURSOR_API_KEY is a personal user API key. Cloud Agent ADO launches need an agent-scoped team service account key to mint user sub-tokens.',
    );
  }
  if (!subTokenInfo.userEmail) {
    throw new Error(
      'Cursor sub-token is not user-scoped (GET /v1/me returned no userEmail). Check CURSOR_API_KEY is an agent-scoped service account and the Apex user is an active Cursor team member.',
    );
  }
  return minted.accessToken;
}

export function toCloudRepoUrl(remoteUrl: string): string {
  return remoteUrl.replace(/\.git$/i, '');
}

export function buildCloudRepoUrl(
  skillProvider: SkillProvider,
  project: string,
  skillRepo: string,
): string {
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
  // ADO auth uses user sub-tokens + explicit repos; named envs use team ADO service principal.
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
  const apiKey = await resolveLaunchApiKey(input);
  const authMode = input.skillProvider === 'ado' ? 'user-sub-token' : 'service-account';
  const cloud = buildCloudCreateOptions(input);
  const createInput = {
    apiKey,
    model: { id: input.model },
    cloud,
  };

  if (process.env.CLOUD_AGENT_DRY_RUN === 'true') {
    logDryRunPayload({
      project: input.project,
      skillProvider: input.skillProvider,
      skillRepo: input.skillRepo,
      skillBranch: input.skillBranch,
      userEmail: input.userEmail ?? null,
      authMode,
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
