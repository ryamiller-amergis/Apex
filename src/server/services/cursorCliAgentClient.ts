import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { CloudAgentActivityEvent } from '../../shared/types/devWorkbench';
import type { SkillProvider } from '../../shared/types/projectSettings';
import {
  checkoutDefaultBranch,
  cleanupWorkspace,
  computeDiff,
  createFeatureBranch,
  getCurrentBranch,
  getWorkspaceDir,
  pushBranch,
} from './repoCheckoutService';
import { resolveGitRemote, type GitRemote } from './repoCacheService';
import { AzureDevOpsService } from './azureDevOps';
import { createPullRequest as createGitHubPullRequest } from './skillCatalogGitHub';
import { buildWorkItemReferenceText } from './workItemPrLinkService';

const CLI_AGENT_PREFIX = 'cli-agent-';
const CLI_RUN_PREFIX = 'cli-run-';
const MAX_ANSWER_LENGTH = 24_000;
const MAX_ERROR_LENGTH = 4_000;
const RUN_RETENTION_MS = 60 * 60_000;

type CliAgentStatus = 'running' | 'completed' | 'failed' | 'cancelled';

interface CliAgentRun {
  /** Null until the workspace is prepared and the CLI is actually spawned. */
  process: ChildProcessWithoutNullStreams | null;
  status: CliAgentStatus;
  answer: string;
  stderr: string;
  /** Reason a terminal run ended, so failures report more than a generic string. */
  terminalDetail: string;
  /** Created after the feature branch is pushed; shown on the run and session. */
  prUrl: string | null;
  events: CloudAgentActivityEvent[];
  waiters: Set<() => void>;
  /** Set only when this run materialized its own checkout, which it must remove. */
  checkoutSessionId: string | null;
}

export interface CursorCliAgentDependencies {
  createPullRequest: (input: {
    provider: SkillProvider;
    project: string;
    repo: string;
    baseBranch: string;
    branchName: string;
    workItemId: number;
  }) => Promise<string>;
}

async function createPullRequest(input: {
  provider: SkillProvider;
  project: string;
  repo: string;
  baseBranch: string;
  branchName: string;
  workItemId: number;
}): Promise<string> {
  const title = `[APEX] ${input.branchName.replace(/^feature\//, '')}`;
  const description = [
    'Automated implementation via APEX dev workbench.',
    '',
    `Work item: ${buildWorkItemReferenceText(input.workItemId)}`,
  ].join('\n');

  if (input.provider === 'github') {
    const slash = input.repo.indexOf('/');
    const org = slash > 0 ? input.repo.slice(0, slash) : undefined;
    const repo = slash > 0 ? input.repo.slice(slash + 1) : input.repo;
    return createGitHubPullRequest({
      org,
      repo,
      sourceBranch: input.branchName,
      targetBranch: input.baseBranch,
      title,
      description,
    });
  }

  return new AzureDevOpsService(input.project).createPullRequest({
    repo: input.repo,
    project: input.project,
    sourceBranch: input.branchName,
    targetBranch: input.baseBranch,
    title,
    description,
    workItemId: input.workItemId,
  });
}

const defaultDependencies: CursorCliAgentDependencies = {
  createPullRequest,
};

const runs = new Map<string, CliAgentRun>();

export function isCursorCliAgentId(id: string): boolean {
  return id.startsWith(CLI_AGENT_PREFIX);
}

function notify(run: CliAgentRun): void {
  const waiters = [...run.waiters];
  run.waiters.clear();
  for (const resolve of waiters) resolve();
}

function addEvent(run: CliAgentRun, event: CloudAgentActivityEvent): void {
  run.events.push(event);
  notify(run);
}

/**
 * The Windows CLI entry point is a .cmd shim that re-launches PowerShell, which
 * Node cannot spawn directly and which does not carry a piped stdin through.
 * The shim itself resolves to `versions/<latest>/node.exe index.js`, so run that
 * pair directly. CURSOR_AGENT_CLI_PATH overrides the whole lookup.
 */
function resolveCliCommand(): { executable: string; leadingArgs: string[] } {
  const override = process.env.CURSOR_AGENT_CLI_PATH?.trim();
  if (override) return { executable: override, leadingArgs: [] };
  if (process.platform !== 'win32') return { executable: 'agent', leadingArgs: [] };

  const versionsDir = path.join(
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
    'cursor-agent',
    'versions',
  );
  const versions = fs.existsSync(versionsDir)
    ? fs.readdirSync(versionsDir).sort().reverse()
    : [];
  for (const version of versions) {
    const node = path.join(versionsDir, version, 'node.exe');
    const entry = path.join(versionsDir, version, 'index.js');
    if (fs.existsSync(node) && fs.existsSync(entry)) {
      return { executable: node, leadingArgs: [entry] };
    }
  }
  throw new Error(
    `Cursor Agent CLI not found under ${versionsDir}. Set CURSOR_AGENT_CLI_PATH to the executable.`,
  );
}

function retainTail(current: string, chunk: Buffer, limit: number): string {
  return `${current}${chunk.toString('utf8')}`.slice(-limit);
}

function releaseCheckout(run: CliAgentRun, runId: string): void {
  if (!run.checkoutSessionId) return;
  try {
    cleanupWorkspace(run.checkoutSessionId);
  } catch (err) {
    console.warn('[cli-agent] checkout cleanup failed', JSON.stringify({
      runId,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
  run.checkoutSessionId = null;
}

function finalizeRun(
  runId: string,
  status: Exclude<CliAgentStatus, 'running'>,
  detail: string,
): void {
  const run = runs.get(runId);
  if (!run || run.status !== 'running') return;
  run.status = status;
  run.terminalDetail = detail;
  if (status === 'failed') {
    console.error('[cli-agent] run failed', JSON.stringify({ runId, detail }));
  }
  addEvent(run, {
    id: `${runId}:terminal`,
    kind: status === 'completed' ? 'assistant' : 'status',
    title: status === 'completed' ? 'Implementation summary' : `CLI Agent run ${status}`,
    ...(detail ? { detail } : {}),
    status,
  });
  releaseCheckout(run, runId);
  const cleanup = setTimeout(() => runs.delete(runId), RUN_RETENTION_MS);
  cleanup.unref();
}

function buildAgentPrompt(input: { prompt: string; repo: string; branch: string }): string {
  return [
    'Implement this Azure DevOps work item.',
    `The workspace root is a checkout of \`${input.repo}\` on feature branch \`${input.branch}\`.`,
    'Read the source directly, edit the files required for the work item, and verify the implementation.',
    'Do not commit, push, or open a pull request. Apex commits, pushes, and opens the PR after you finish.',
    'Return a concise summary of the implementation and verification. Call out any blocked or incomplete work.',
    '',
    '## Supplied work item context',
    '',
    input.prompt,
  ].join('\n');
}

/**
 * Workspace the CLI edits. CURSOR_AGENT_CLI_WORKSPACE points at an existing
 * clone; otherwise the project's configured repo is materialized through the
 * same cache-backed checkout path My Work uses, and removed when the run ends.
 */
async function resolveAgentWorkspace(
  run: CliAgentRun,
  runId: string,
  input: {
    project: string;
    skillProvider: SkillProvider;
    skillRepo: string;
    skillBranch: string;
    workItemId: number;
    workItemTitle: string;
  },
): Promise<{
  workspace: string;
  checkoutSessionId: string | null;
  branchName: string;
  remote: GitRemote;
}> {
  const override = process.env.CURSOR_AGENT_CLI_WORKSPACE?.trim();
  const checkoutSessionId = override ? null : `${CLI_AGENT_PREFIX}${randomUUID()}`;
  const workspace = override ?? getWorkspaceDir(checkoutSessionId!);
  const remote = resolveGitRemote(input.skillProvider, input.project, input.skillRepo);

  if (checkoutSessionId) {
    addEvent(run, {
      id: `${runId}:clone:start`,
      kind: 'status',
      title: 'Step 1 — Cloning repository',
      detail: `${input.skillRepo} @ ${input.skillBranch} into a temporary workspace.`,
      status: 'running',
    });
    await checkoutDefaultBranch({
      project: input.project,
      repo: input.skillRepo,
      branch: input.skillBranch,
      sessionId: checkoutSessionId,
      provider: input.skillProvider,
    });
    addEvent(run, {
      id: `${runId}:clone:done`,
      kind: 'status',
      title: 'Step 1 — Repository cloned',
      detail: 'Temporary workspace only — your local repo is untouched.',
      status: 'completed',
    });
  }

  addEvent(run, {
    id: `${runId}:branch:start`,
    kind: 'status',
    title: 'Step 2 — Creating feature branch',
    detail: `Branching off ${input.skillBranch}. Nothing is written to ${input.skillBranch}.`,
    status: 'running',
  });
  const branchName = await createFeatureBranch(
    workspace,
    input.workItemId,
    input.workItemTitle,
    input.skillBranch,
    remote,
  );
  // The agent must never be handed a workspace sitting on the base branch.
  if (branchName === input.skillBranch) {
    throw new Error(
      `Refusing to run: feature branch resolved to the base branch ${input.skillBranch}.`,
    );
  }
  const checkedOut = await getCurrentBranch(workspace);
  if (checkedOut !== branchName) {
    throw new Error(
      `Refusing to run: expected branch ${branchName} but the workspace is on ${checkedOut}.`,
    );
  }
  addEvent(run, {
    id: `${runId}:branch:done`,
    kind: 'status',
    title: `Step 2 — On branch ${branchName}`,
    detail: `Verified checked out from ${input.skillBranch}. All edits land here.`,
    status: 'completed',
  });

  return { workspace, checkoutSessionId, branchName, remote };
}

export async function launchCursorCliAgent(input: {
  project: string;
  prompt: string;
  model: string;
  skillProvider: SkillProvider;
  skillRepo: string;
  skillBranch: string;
  workItemId: number;
  workItemTitle: string;
}, deps: CursorCliAgentDependencies = defaultDependencies): Promise<{
  cloudAgentId: string;
  cursorRunId: string;
  branchName: string;
}> {
  const cloudAgentId = `${CLI_AGENT_PREFIX}${randomUUID()}`;
  const cursorRunId = `${CLI_RUN_PREFIX}${randomUUID()}`;

  // Registered before the checkout so clone and branch steps stream to the
  // drawer instead of happening invisibly before the run exists.
  const run: CliAgentRun = {
    process: null,
    status: 'running',
    answer: '',
    stderr: '',
    terminalDetail: '',
    prUrl: null,
    events: [{
      id: `${cursorRunId}:started`,
      kind: 'status',
      title: 'Preparing workspace',
      detail: `${input.skillRepo} · base branch ${input.skillBranch}`,
      status: 'running',
    }],
    waiters: new Set(),
    checkoutSessionId: null,
  };
  runs.set(cursorRunId, run);

  let workspace: string;
  let branchName: string;
  let remote: GitRemote;
  try {
    const prepared = await resolveAgentWorkspace(run, cursorRunId, input);
    workspace = prepared.workspace;
    branchName = prepared.branchName;
    remote = prepared.remote;
    run.checkoutSessionId = prepared.checkoutSessionId;
  } catch (error) {
    finalizeRun(
      cursorRunId,
      'failed',
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }

  const { executable, leadingArgs } = resolveCliCommand();
  // No --mode: the CLI only accepts plan|ask there, and omitting it is the
  // full agent mode that can edit files. -p keeps write and shell tools.
  const child = spawn(executable, [
    ...leadingArgs,
    '-p',
    '--workspace',
    workspace,
    '--trust',
    '--approve-mcps',
    '--output-format',
    'text',
    '--model',
    input.model,
  ], {
    cwd: workspace,
    env: process.env,
    windowsHide: true,
    stdio: 'pipe',
  });

  run.process = child;
  addEvent(run, {
    id: `${cursorRunId}:agent:start`,
    kind: 'status',
    title: 'Step 3 — Cursor CLI running (agent mode)',
    detail: `Implementing on ${branchName}.`,
    status: 'running',
  });

  child.stdout.on('data', (chunk: Buffer) => {
    run.answer = retainTail(run.answer, chunk, MAX_ANSWER_LENGTH);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    run.stderr = retainTail(run.stderr, chunk, MAX_ERROR_LENGTH);
  });
  child.once('error', (error) => {
    finalizeRun(cursorRunId, 'failed', error.message);
  });
  // A CLI that exits before reading the prompt breaks the pipe. Without this
  // handler the write error is unhandled and takes down the Apex process.
  child.stdin.on('error', (error: Error) => {
    finalizeRun(cursorRunId, 'failed', `Could not send the prompt to the CLI: ${error.message}`);
  });
  child.once('close', (code) => {
    void (async () => {
      if (run.status !== 'running') return;
      if (code !== 0) {
        finalizeRun(
          cursorRunId,
          'failed',
          run.stderr.trim() || `Cursor Agent CLI exited with code ${code ?? 'unknown'}.`,
        );
        return;
      }

      const answer = run.answer.trim();
      try {
        // The agent can move HEAD. Confirm the feature branch is still checked
        // out before anything is committed, so work can never land on the base
        // branch.
        const checkedOut = await getCurrentBranch(workspace);
        if (checkedOut !== branchName) {
          finalizeRun(
            cursorRunId,
            'failed',
            `Nothing was pushed: the workspace ended on ${checkedOut}, not ${branchName}.`,
          );
          return;
        }
        addEvent(run, {
          id: `${cursorRunId}:verify`,
          kind: 'status',
          title: `Step 4 — Verified still on ${branchName}`,
          detail: `Base branch ${input.skillBranch} received no commits.`,
          status: 'completed',
        });

        const { changedFiles } = await computeDiff(workspace);
        if (changedFiles.length === 0) {
          addEvent(run, {
            id: `${cursorRunId}:nochanges`,
            kind: 'status',
            title: 'Step 5 — No file changes',
            detail: 'Nothing to commit, so no branch was pushed.',
            status: 'completed',
          });
          run.answer = [
            answer || 'The CLI Agent run completed without a summary.',
            'No files changed, so nothing was committed or pushed.',
          ].join('\n\n');
          finalizeRun(cursorRunId, 'completed', run.answer);
          return;
        }

        addEvent(run, {
          id: `${cursorRunId}:publishing`,
          kind: 'status',
          title: `Step 5 — Committing and pushing ${branchName}`,
          detail: `${changedFiles.length} file(s) changed. Pushing to origin/${branchName}.`,
          status: 'running',
        });
        await pushBranch(workspace, branchName, remote);
        addEvent(run, {
          id: `${cursorRunId}:published`,
          kind: 'status',
          title: `Step 5 — Pushed origin/${branchName}`,
          detail: 'The feature branch is ready for a pull request.',
          status: 'completed',
        });

        addEvent(run, {
          id: `${cursorRunId}:pr:creating`,
          kind: 'status',
          title: 'Step 6 — Creating pull request',
          detail: `${branchName} → ${input.skillBranch}`,
          status: 'running',
        });
        run.prUrl = await deps.createPullRequest({
          provider: input.skillProvider,
          project: input.project,
          repo: input.skillRepo,
          baseBranch: input.skillBranch,
          branchName,
          workItemId: input.workItemId,
        });
        addEvent(run, {
          id: `${cursorRunId}:pr:created`,
          kind: 'status',
          title: 'Step 6 — Pull request created',
          detail: run.prUrl,
          status: 'completed',
        });

        run.answer = [
          answer || 'The CLI Agent run completed without a summary.',
          `${changedFiles.length} file(s) committed and pushed to \`${branchName}\`.`,
          `Pull request: ${run.prUrl}`,
        ].join('\n\n');
        finalizeRun(cursorRunId, 'completed', run.answer);
      } catch (error) {
        finalizeRun(
          cursorRunId,
          'failed',
          `Implementation finished, but publishing ${branchName} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    })();
  });

  child.stdin.end(buildAgentPrompt({
    prompt: input.prompt,
    repo: input.skillRepo,
    branch: branchName,
  }));
  return { cloudAgentId, cursorRunId, branchName };
}

function requireRun(cursorRunId: string): CliAgentRun {
  const run = runs.get(cursorRunId);
  if (!run) {
    throw new Error('CLI Agent run is unavailable; the Apex server may have restarted.');
  }
  return run;
}

export function getCursorCliAgentRun(cursorRunId: string): {
  status: CliAgentStatus;
  prUrl: string | null;
  resultText: string | null;
} {
  const run = requireRun(cursorRunId);
  return {
    status: run.status,
    prUrl: run.prUrl,
    resultText: run.status === 'completed'
      ? run.answer.trim()
      : run.status === 'failed'
        ? run.terminalDetail || run.stderr.trim() || 'Cursor Agent CLI failed.'
        : null,
  };
}

export async function* streamCursorCliAgentRun(
  cursorRunId: string,
): AsyncGenerator<CloudAgentActivityEvent> {
  const run = requireRun(cursorRunId);
  let index = 0;
  while (true) {
    while (index < run.events.length) {
      yield run.events[index++];
    }
    if (run.status !== 'running') return;
    await new Promise<void>((resolve) => run.waiters.add(resolve));
  }
}

export function cancelCursorCliAgentRun(cursorRunId: string): void {
  const run = requireRun(cursorRunId);
  if (run.status !== 'running') return;
  run.status = 'cancelled';
  run.process?.kill();
  addEvent(run, {
    id: `${cursorRunId}:cancelled`,
    kind: 'status',
    title: 'CLI Agent run cancelled',
    status: 'cancelled',
  });
  releaseCheckout(run, cursorRunId);
}
