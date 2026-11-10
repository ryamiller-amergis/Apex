import { Agent, type ToolName } from '@cursor/sdk';
import type {
  LocalAgentOptions,
  McpServerConfig,
} from '@cursor/sdk/dist/cjs/options.js';
import { buildCursorModelSelection } from '../agentEffortResolver';
import { git, safeArgs } from '../../utils/asyncGit';
import { WORKTREE_GIT_TIMEOUT_MS } from '../repoGitSettings';
import {
  tryApplyDeterministicCopyEdit,
  type DeterministicCopyEditResult,
} from './buildRevisionDeterministicEdit';

const REVISION_EDIT_TOOLS = ['read', 'edit', 'grep', 'glob', 'ls'] as const;
const DEFAULT_REVISION_EDIT_MODEL = 'composer-2.5';
// Cursor can spend most of a 45-second window locating the existing UI
// surface on a cold workspace. Keep the edit bounded, but allow enough time
// to inspect and update a small set of existing files.
const DEFAULT_REVISION_EDIT_TIMEOUT_MS = 3 * 60_000;

export interface RevisionEditAgentInput {
  buildRunId?: string;
  workspacePath: string;
  baseCommit: string;
  feedback: string;
  revisionNumber: number;
  recoveredDraft?: boolean;
  /** Failing check output from the previous attempt on this draft. */
  repairContext?: string;
  modelId?: string;
  signal?: AbortSignal;
}

export type RevisionEditAgentResult =
  | { kind: 'edited'; agentCorrelationRef: string | null }
  | {
      kind: 'escalate';
      reason: string;
      agentCorrelationRef: string | null;
    };

export interface RevisionEditAgentProvider {
  edit(input: RevisionEditAgentInput): Promise<RevisionEditAgentResult>;
}

export interface RevisionEditAgentRuntimeInput {
  cwd: string;
  prompt: string;
  modelId?: string;
  tools: readonly string[];
  settingSources: readonly string[];
  mcpServers: Readonly<Record<string, never>>;
  signal: AbortSignal;
}

export interface RevisionEditAgentRuntime {
  run(input: RevisionEditAgentRuntimeInput): Promise<{
    agentCorrelationRef: string | null;
    output: string;
  }>;
}

interface LocalRevisionEditAgentDependencies {
  runtime?: RevisionEditAgentRuntime;
  readHeadCommit?: (workspacePath: string) => Promise<string>;
  hasWorkspaceChanges?: (workspacePath: string) => Promise<boolean>;
  tryDeterministicEdit?: (input: {
    workspacePath: string;
    feedback: string;
  }) => Promise<DeterministicCopyEditResult>;
  timeoutMs?: number;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(
        typeof signal.reason === 'string'
          ? signal.reason
          : 'Revision edit agent cancelled.'
      );
}

async function runUntilAborted<T>(
  operation: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function buildEditPrompt(input: RevisionEditAgentInput): string {
  return [
    `You are applying revision ${input.revisionNumber} to an existing web application.`,
    'Apply the requested UI or UX change directly. This includes layout, copy, color, theme, tokens, spacing, and interaction.',
    'Do not ask the requester to confirm a visual change, and do not describe it instead of making it.',
    'Work quickly: use grep and glob to find the files that render the affected UI, make the change, and stop.',
    'The preview is often under 1000 pixels wide beside a side navigation. A max width of the large breakpoint, or margin auto on an element whose width is 100%, will not look like a change.',
    'To center a page, cap the content under 960 pixels and set alignSelf to center on that flex child.',
    'Packages already listed in package.json files may be imported; check that every imported module path and export exists before using it.',
    ...(input.recoveredDraft
      ? [
          'The workspace already contains a draft of this change. Inspect it and correct invalid imports, identifiers, or incomplete edits before stopping; do not duplicate the change.',
        ]
      : []),
    ...(input.repairContext
      ? ['', 'The draft failed these checks:', input.repairContext]
      : []),
    'You may inspect and edit files, but you cannot run commands, use the web, call MCP tools, or delegate work.',
    'Do not change APIs, schemas, authentication, authorization, dependencies, infrastructure, integrations, environment configuration, or server behavior.',
    'If the request needs any of those changes, inspect enough to confirm that and do not edit files.',
    '',
    'Requested change:',
    input.feedback,
    '',
    'Finish with exactly one JSON object:',
    '{"outcome":"edited"}',
    'or',
    '{"outcome":"escalate","reason":"short concrete reason"}',
  ].join('\n');
}

function extractDecision(output: string): unknown {
  const trimmed = output.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.lastIndexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function parseDecision(
  output: string,
  agentCorrelationRef: string | null
): RevisionEditAgentResult {
  const decision = extractDecision(output) as {
    outcome?: unknown;
    reason?: unknown;
  } | null;
  if (decision?.outcome === 'edited') {
    return { kind: 'edited', agentCorrelationRef };
  }
  if (
    decision?.outcome === 'escalate' &&
    typeof decision.reason === 'string' &&
    decision.reason.trim()
  ) {
    return {
      kind: 'escalate',
      reason: decision.reason.trim().slice(0, 500),
      agentCorrelationRef,
    };
  }
  return {
    kind: 'escalate',
    reason: 'The edit agent could not confirm a contained UI change.',
    agentCorrelationRef,
  };
}

async function readHeadCommit(workspacePath: string): Promise<string> {
  return (
    await git(safeArgs(workspacePath, ['rev-parse', 'HEAD']), {
      cwd: workspacePath,
      timeout: WORKTREE_GIT_TIMEOUT_MS,
    })
  ).trim();
}

async function hasWorkspaceChanges(workspacePath: string): Promise<boolean> {
  const status = await git(
    safeArgs(workspacePath, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]),
    { cwd: workspacePath, timeout: WORKTREE_GIT_TIMEOUT_MS }
  );
  return status.trim().length > 0;
}

const cursorRuntime: RevisionEditAgentRuntime = {
  async run(input) {
    if (input.signal.aborted) throw abortReason(input.signal);
    const apiKey = process.env.CURSOR_API_KEY?.trim();
    if (!apiKey) throw new Error('CURSOR_API_KEY is required');
    const modelId =
      input.modelId ??
      (await (await import('../appSettingsService')).getDefaultModel());
    const local = {
      cwd: input.cwd,
      settingSources: [],
      enableAgentRetries: false,
      // The scratch checkout is already isolated, limited to non-shell edit
      // tools, and removed after the attempt. Cursor's Windows sandbox denies
      // those tools access to this generated workspace.
      sandboxOptions: { enabled: false },
      customTools: {},
    } satisfies LocalAgentOptions;
    const agent = await Agent.create({
      apiKey,
      model: buildCursorModelSelection(modelId),
      tools: [...REVISION_EDIT_TOOLS] as ToolName[],
      mode: 'agent',
      local,
      mcpServers: {} as Record<string, McpServerConfig>,
    });
    try {
      const run = await agent.send(input.prompt);
      const cancelOnAbort = () => {
        void run.cancel().catch(() => undefined);
      };
      input.signal.addEventListener('abort', cancelOnAbort, { once: true });
      let output = '';
      try {
        if (input.signal.aborted) {
          cancelOnAbort();
          throw abortReason(input.signal);
        }
        if (run.supports('stream')) {
          for await (const event of run.stream()) {
            if (event.type !== 'assistant') continue;
            for (const block of event.message.content) {
              if (block.type === 'text') output += block.text;
            }
          }
        }
      } finally {
        input.signal.removeEventListener('abort', cancelOnAbort);
      }
      const agentId = (agent as unknown as { id?: string | null }).id ?? null;
      return {
        agentCorrelationRef: agentId ? `agent:cursor-local:${agentId}` : null,
        output,
      };
    } finally {
      await agent[Symbol.asyncDispose]().catch(() => undefined);
    }
  },
};

export function createLocalCursorRevisionEditAgentProvider(
  dependencies: LocalRevisionEditAgentDependencies = {}
): RevisionEditAgentProvider {
  const runtime = dependencies.runtime ?? cursorRuntime;
  const loadHead = dependencies.readHeadCommit ?? readHeadCommit;
  const isDirty = dependencies.hasWorkspaceChanges ?? hasWorkspaceChanges;
  const tryDeterministicEdit =
    dependencies.tryDeterministicEdit ?? tryApplyDeterministicCopyEdit;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_REVISION_EDIT_TIMEOUT_MS;

  return {
    async edit(input) {
      const head = await loadHead(input.workspacePath);
      if (head !== input.baseCommit) {
        throw new Error(
          'Fast-edit scratch checkout is not at the exact base commit.'
        );
      }
      if (!input.recoveredDraft && (await isDirty(input.workspacePath))) {
        throw new Error('Fast-edit scratch checkout must start clean.');
      }
      const deterministic = input.recoveredDraft
        ? ({ kind: 'not_applicable' } as const)
        : await tryDeterministicEdit({
            workspacePath: input.workspacePath,
            feedback: input.feedback,
          });
      if (deterministic.kind !== 'not_applicable') {
        return {
          kind: 'edited',
          agentCorrelationRef: 'deterministic:literal-copy',
        };
      }
      const timeoutController = new AbortController();
      const timeout = setTimeout(() => {
        timeoutController.abort(
          new Error(`Revision edit agent timed out after ${timeoutMs}ms.`)
        );
      }, timeoutMs);
      const forwardCancellation = () => {
        timeoutController.abort(
          input.signal ? abortReason(input.signal) : undefined
        );
      };
      input.signal?.addEventListener('abort', forwardCancellation, {
        once: true,
      });
      if (input.signal?.aborted) forwardCancellation();
      let result: Awaited<ReturnType<RevisionEditAgentRuntime['run']>>;
      try {
        result = await runUntilAborted(
          runtime.run({
            cwd: input.workspacePath,
            prompt: buildEditPrompt(input),
            modelId: input.modelId ?? DEFAULT_REVISION_EDIT_MODEL,
            tools: REVISION_EDIT_TOOLS,
            settingSources: [],
            mcpServers: {},
            signal: timeoutController.signal,
          }),
          timeoutController.signal
        );
      } finally {
        clearTimeout(timeout);
        input.signal?.removeEventListener('abort', forwardCancellation);
      }
      return parseDecision(result.output, result.agentCorrelationRef);
    },
  };
}

export const localCursorRevisionEditAgentProvider =
  createLocalCursorRevisionEditAgentProvider();
