import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type { CloudAgentActivityEvent } from '../../shared/types/devWorkbench';

const execFileAsync = promisify(execFile);

export const CONTAINER_AGENT_PREFIX = 'container-agent-';

type JobTemplate = {
  containers?: Array<{
    name?: string;
    image?: string;
    command?: string[];
    args?: string[];
    env?: Array<{ name?: string; value?: string; secretRef?: string }>;
  }>;
};

function azCommand(): string {
  return process.platform === 'win32' ? 'az.cmd' : 'az';
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set to start a container CLI run`);
  return value;
}

export function isContainerAgentId(id: string): boolean {
  return id.startsWith(CONTAINER_AGENT_PREFIX);
}

/** Job status values become the same words the cloud-agent poller already understands. */
export function mapContainerJobStatus(status: string): string {
  switch (status.trim().toLowerCase()) {
    case 'succeeded':
      return 'finished';
    case 'failed':
      return 'failed';
    case 'stopped':
    case 'canceled':
    case 'cancelled':
      return 'cancelled';
    default:
      return 'running';
  }
}

/** Job log lines arrive as JSON, so a marker is followed by `"}`. */
export function parseContainerCliLogs(logs: string): {
  prUrl: string | null;
  noChanges: boolean;
  branchName: string | null;
  baseBranch: string | null;
  summary: string | null;
} {
  const pr = logs.match(/APEX_PR_URL=(https:\/\/[^\s"\\]+\/pullrequest\/\d+)/);
  const branch = logs.match(/APEX_BRANCH_PUSHED=([^\s"\\]+)/);
  const base = logs.match(/APEX_BASE_BRANCH=([^\s"\\]+)/);
  const summary = logs.match(/APEX_SUMMARY=([^"\\]*)/);
  return {
    prUrl: pr?.[1] ?? null,
    noChanges: logs.includes('APEX_RESULT no file changes'),
    branchName: branch?.[1] ?? null,
    baseBranch: base?.[1] ?? null,
    summary: summary?.[1]?.trim() || null,
  };
}

const ACTIVITY_KINDS = new Set(['assistant', 'thinking', 'tool', 'status', 'task']);
const ACTIVITY_STATUSES = new Set(['running', 'completed', 'failed', 'cancelled']);
const ACTIVITY_POLL_MS = 4_000;
/** `az containerapp job logs show` accepts at most 300 lines. */
const ACTIVITY_LOG_TAIL = '300';

function unwrapJobLogLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as { Log?: unknown; log?: unknown };
    const text = parsed.Log ?? parsed.log;
    if (typeof text === 'string') return text;
  } catch {
    return trimmed;
  }
  return trimmed;
}

function toActivityEvent(value: Record<string, unknown>): CloudAgentActivityEvent | null {
  if (typeof value.id !== 'string' || !value.id.trim()) return null;
  if (typeof value.title !== 'string' || !value.title.trim()) return null;
  if (typeof value.kind !== 'string' || !ACTIVITY_KINDS.has(value.kind)) return null;
  const event: CloudAgentActivityEvent = {
    id: value.id,
    kind: value.kind as CloudAgentActivityEvent['kind'],
    title: value.title.slice(0, 200),
  };
  if (typeof value.detail === 'string' && value.detail.trim()) {
    event.detail = value.detail.slice(0, 500);
  }
  if (typeof value.status === 'string' && ACTIVITY_STATUSES.has(value.status)) {
    event.status = value.status as CloudAgentActivityEvent['status'];
  }
  return event;
}

/** Compact activity lines the container prints while the CLI run is in progress. */
export function parseContainerActivityLogs(logs: string): CloudAgentActivityEvent[] {
  const events: CloudAgentActivityEvent[] = [];
  for (const line of logs.split(/\r?\n/)) {
    const text = unwrapJobLogLine(line);
    const marker = 'APEX_ACTIVITY ';
    const at = text.indexOf(marker);
    if (at < 0) continue;
    try {
      const parsed = JSON.parse(text.slice(at + marker.length)) as Record<string, unknown>;
      const event = toActivityEvent(parsed);
      if (event) events.push(event);
    } catch {
      // A truncated log line is not an activity event.
    }
  }
  return events;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function buildContainerExecutionTemplate(
  template: JobTemplate,
  input: {
    image: string;
    repoUrl: string;
    baseBranch: string;
    branchName: string;
    model: string;
    prompt: string;
    adoPat: string;
    workItemId?: number;
    workItemTitle?: string;
    authorName?: string;
    authorEmail?: string;
    skillName?: string;
    adoUserToken?: string | null;
  },
): JobTemplate {
  const container = template.containers?.[0];
  if (!container) throw new Error('Cursor worker job template has no container');
  const replaced = new Set([
    'ADO_PAT',
    'REPO_URL',
    'AGENT_BASE_BRANCH',
    'AGENT_BRANCH',
    'AGENT_MODEL',
    'AGENT_PROMPT',
    'AGENT_WORK_ITEM_ID',
    'AGENT_WORK_ITEM_TITLE',
    'AGENT_AUTHOR_NAME',
    'AGENT_AUTHOR_EMAIL',
    'AGENT_SKILL',
    'ADO_USER_TOKEN',
  ]);
  const env = (container.env ?? []).filter((entry) => !entry.name || !replaced.has(entry.name));
  env.push(
    { name: 'REPO_URL', value: input.repoUrl },
    { name: 'AGENT_BASE_BRANCH', value: input.baseBranch },
    { name: 'AGENT_BRANCH', value: input.branchName },
    { name: 'AGENT_MODEL', value: input.model },
    { name: 'AGENT_PROMPT', value: input.prompt },
    { name: 'ADO_PAT', value: input.adoPat },
  );
  if (input.workItemId) {
    env.push({ name: 'AGENT_WORK_ITEM_ID', value: String(input.workItemId) });
  }
  const workItemTitle = oneLine(input.workItemTitle);
  const authorName = oneLine(input.authorName);
  const authorEmail = oneLine(input.authorEmail);
  if (workItemTitle) env.push({ name: 'AGENT_WORK_ITEM_TITLE', value: workItemTitle });
  if (authorName) env.push({ name: 'AGENT_AUTHOR_NAME', value: authorName });
  if (authorEmail) env.push({ name: 'AGENT_AUTHOR_EMAIL', value: authorEmail });
  if (input.skillName) env.push({ name: 'AGENT_SKILL', value: input.skillName });
  if (input.adoUserToken) env.push({ name: 'ADO_USER_TOKEN', value: input.adoUserToken });
  return {
    ...template,
    containers: [{
      ...container,
      image: input.image,
      command: ['/bin/bash', '/usr/local/bin/cursor-run-cli'],
      args: [],
      env,
    }],
  };
}

function oneLine(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/[\r\n]+/g, ' ').trim();
  return trimmed || undefined;
}

function branchNameFor(workItemId: number | undefined): string {
  const suffix = randomBytes(3).toString('hex');
  return `feature/apex-${workItemId ?? 'run'}-${suffix}`;
}

async function executionLogs(executionName: string, tail: string): Promise<string> {
  const jobName = requireEnv('CURSOR_CONTAINER_JOB_NAME');
  const resourceGroup = requireEnv('CURSOR_CONTAINER_JOB_RESOURCE_GROUP');
  return az([
    'containerapp', 'job', 'logs', 'show',
    '--name', jobName,
    '--resource-group', resourceGroup,
    '--execution', executionName,
    '--container', 'cursor-pool-worker',
    '--tail', tail,
  ]);
}

async function az(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(azCommand(), args, {
    // az on Windows is az.cmd. Node refuses to spawn a .cmd without a shell (EINVAL).
    shell: process.platform === 'win32',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

export async function launchCursorContainerCli(input: {
  prompt: string;
  model: string;
  skillBranch: string;
  workItemId?: number;
  workItemTitle?: string;
  authorName?: string;
  authorEmail?: string;
  skillName?: string;
  adoUserToken?: string | null;
  repoUrl: string;
}): Promise<{ cloudAgentId: string; cursorRunId: string; jobName: string; branchName: string }> {
  const jobName = requireEnv('CURSOR_CONTAINER_JOB_NAME');
  const resourceGroup = requireEnv('CURSOR_CONTAINER_JOB_RESOURCE_GROUP');
  const image = requireEnv('CURSOR_CONTAINER_JOB_IMAGE');
  const adoPat = requireEnv('ADO_PAT');
  const branchName = branchNameFor(input.workItemId);

  const shown = await az([
    'containerapp', 'job', 'show',
    '--name', jobName,
    '--resource-group', resourceGroup,
    '--query', 'properties.template',
    '-o', 'json',
  ]);
  const template = buildContainerExecutionTemplate(JSON.parse(shown) as JobTemplate, {
    image,
    repoUrl: input.repoUrl,
    baseBranch: input.skillBranch,
    branchName,
    model: input.model,
    prompt: input.prompt,
    adoPat,
    workItemId: input.workItemId,
    workItemTitle: input.workItemTitle,
    authorName: input.authorName,
    authorEmail: input.authorEmail,
    skillName: input.skillName,
    adoUserToken: input.adoUserToken,
  });

  const dir = await mkdtemp(path.join(os.tmpdir(), 'apex-container-cli-'));
  const file = path.join(dir, 'execution.json');
  try {
    await writeFile(file, JSON.stringify(template), 'utf8');
    const started = await az([
      'containerapp', 'job', 'start',
      '--name', jobName,
      '--resource-group', resourceGroup,
      '--yaml', file,
    ]);
    const parsed = JSON.parse(started) as { name?: string };
    if (!parsed.name) throw new Error('Container job start did not return an execution name');
    return {
      cloudAgentId: `${CONTAINER_AGENT_PREFIX}${parsed.name}`,
      cursorRunId: parsed.name,
      jobName,
      branchName,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function getCursorContainerCliRun(executionName: string): Promise<{
  status: string;
  prUrl: string | null;
  resultText: string | null;
  branchName: string | null;
  baseBranch: string | null;
  summary: string | null;
}> {
  const jobName = requireEnv('CURSOR_CONTAINER_JOB_NAME');
  const resourceGroup = requireEnv('CURSOR_CONTAINER_JOB_RESOURCE_GROUP');
  const status = (await az([
    'containerapp', 'job', 'execution', 'show',
    '--name', jobName,
    '--resource-group', resourceGroup,
    '--job-execution-name', executionName,
    '--query', 'properties.status',
    '-o', 'tsv',
  ])).trim();
  let mapped = mapContainerJobStatus(status);
  let prUrl: string | null = null;
  let resultText: string | null = null;
  let branchName: string | null = null;
  let baseBranch: string | null = null;
  let summary: string | null = null;
  if (mapped === 'failed') resultText = 'Container CLI run failed. See the job execution logs.';
  try {
    const logs = await executionLogs(executionName, '200');
    const parsed = parseContainerCliLogs(logs);
    prUrl = parsed.prUrl;
    branchName = parsed.branchName;
    baseBranch = parsed.baseBranch;
    summary = parsed.summary;
    if (parsed.noChanges) resultText = 'The agent finished without changing files.';
    if (mapped === 'running' && (parsed.prUrl || parsed.noChanges)) mapped = 'finished';
  } catch (err) {
    console.warn('[container-cli] could not read job logs', err instanceof Error ? err.message : err);
  }
  return { status: mapped, prUrl, resultText, branchName, baseBranch, summary };
}

function isTerminalContainerStatus(status: string): boolean {
  return status === 'finished' || status === 'failed' || status === 'cancelled';
}

export async function* streamCursorContainerCliRun(
  executionName: string,
): AsyncGenerator<CloudAgentActivityEvent> {
  const seen = new Set<string>();
  let terminalReads = 0;
  for (;;) {
    let status = 'running';
    try {
      const jobName = requireEnv('CURSOR_CONTAINER_JOB_NAME');
      const resourceGroup = requireEnv('CURSOR_CONTAINER_JOB_RESOURCE_GROUP');
      const raw = (await az([
        'containerapp', 'job', 'execution', 'show',
        '--name', jobName,
        '--resource-group', resourceGroup,
        '--job-execution-name', executionName,
        '--query', 'properties.status',
        '-o', 'tsv',
      ])).trim();
      status = mapContainerJobStatus(raw);
    } catch (err) {
      console.warn('[container-cli] could not read job status', err instanceof Error ? err.message : err);
    }

    let logs = '';
    try {
      logs = await executionLogs(executionName, ACTIVITY_LOG_TAIL);
    } catch (err) {
      console.warn('[container-cli] could not read job logs', err instanceof Error ? err.message : err);
    }
    for (const event of parseContainerActivityLogs(logs)) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      yield event;
    }

    if (!isTerminalContainerStatus(status) || terminalReads < 1) {
      if (isTerminalContainerStatus(status)) terminalReads += 1;
      await sleep(ACTIVITY_POLL_MS);
      continue;
    }
    if (seen.size === 0) {
      const observed = await getCursorContainerCliRun(executionName);
      yield {
        id: `${executionName}:status`,
        kind: 'status',
        title: 'Container CLI run',
        detail: observed.prUrl ?? observed.resultText ?? observed.status,
        status: observed.status === 'finished'
          ? 'completed'
          : observed.status === 'cancelled'
            ? 'cancelled'
            : observed.status === 'failed'
              ? 'failed'
              : 'running',
      };
    }
    return;
  }
}

export async function cancelCursorContainerCliRun(executionName: string): Promise<void> {
  const jobName = requireEnv('CURSOR_CONTAINER_JOB_NAME');
  const resourceGroup = requireEnv('CURSOR_CONTAINER_JOB_RESOURCE_GROUP');
  await az([
    'containerapp', 'job', 'stop',
    '--name', jobName,
    '--resource-group', resourceGroup,
    '--job-execution-name', executionName,
  ]);
}
