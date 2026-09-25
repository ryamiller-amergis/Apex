import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExecutionSnapshot } from '../../../shared/types/agentRunLifecycle';
import {
  documentWorkflowRequiresRepository,
  isAiRunV2DocumentSpecification,
  type AiRunV2DocumentSpecification,
} from '../../../shared/types/aiRunV2DocumentSpec';
import type { BackgroundWorkflowClass } from '../../../shared/types/backgroundWorkflow';
import type { RepoReader } from '../../../shared/types/repoReader';
import {
  CursorExecutionWaitError,
  executeCursorExecutionCore,
  type CursorExecutionResult,
} from '../cursorExecutionCore';
import {
  createLocalCursorExecution,
  type WorkerCursorExecution,
} from '../aiRunsWorker/cursorExecution';
import {
  RepoServiceReader,
  resolveRepoReadServiceUrl,
} from '../repoRead/repoServiceReader';
import type { ArtifactFile } from './artifactUploader';
import type { ExecuteWorkload, ExecutionOutcome } from './worker';

const OUTPUT_DIRECTORY_PARTS = ['.ai-pilot', 'output'] as const;
const ARTIFACT_OUTPUT_PREFIX = 'output/';

type CreateExecution = (
  snapshot: Readonly<ExecutionSnapshot>,
  checkout?: RepoReader,
  signal?: AbortSignal,
) => Promise<WorkerCursorExecution>;

export type DocumentExecutionDependencies = Readonly<{
  openRepository?: (
    specification: AiRunV2DocumentSpecification,
    signal?: AbortSignal,
  ) => Promise<RepoReader>;
  createExecution?: CreateExecution;
  tempRoot?: string;
  now?: () => number;
}>;

function isExpectedOutputPath(
  workflowClass: BackgroundWorkflowClass,
  relativePath: string,
): boolean {
  if (relativePath.includes('\\') || relativePath.split('/').includes('..')) {
    return false;
  }
  const segments = relativePath.split('/');
  const name = segments[segments.length - 1] ?? '';
  switch (workflowClass) {
    case 'prd':
      return (
        name === 'PRD.md'
        || /\.prd\.md$/i.test(name)
        || /\.backlog\.json$/i.test(name)
      );
    case 'design-doc':
      if (
        segments.length > 2
        || (
          segments.length === 2
          && !/^[^/]+-design-spec$/i.test(segments[0])
        )
      ) {
        return false;
      }
      return (
        /[-.]design\.md$/i.test(name)
        || /[-.]tech-spec\.md$/i.test(name)
        || /[-.]assumptions\.md$/i.test(name)
      );
    case 'validation':
      if (segments.length !== 1) return false;
      return (
        name === 'review-scorecard.json'
        || name === 'review-scorecard.md'
      );
    case 'test-cases':
      if (segments.length !== 1) return false;
      return (
        /\.test-cases\.json$/i.test(name)
        || /\.test-cases\.md$/i.test(name)
        || /\.backlog\.json$/i.test(name)
      );
    case 'walkthrough-smart-tagging':
      if (segments.length !== 1) return false;
      return name === 'walkthrough-anchor-smart-tagging.json';
    default: {
      const unhandled: never = workflowClass;
      throw new Error(`Unsupported document workflow: ${String(unhandled)}`);
    }
  }
}

function assertSingleMatch(
  names: readonly string[],
  pattern: RegExp,
  label: string,
): void {
  if (names.filter((name) => pattern.test(name)).length !== 1) {
    throw new Error(`Document workflow did not produce exactly one ${label}`);
  }
}

function designStem(name: string, suffix: RegExp): string | null {
  const match = suffix.exec(name);
  return match?.[1]?.toLowerCase() ?? null;
}

function assertCompleteDesignTriplets(names: readonly string[]): void {
  const designs = new Set(
    names
      .map((name) => designStem(name, /^(.*?)[-.]design\.md$/i))
      .filter((value): value is string => value !== null),
  );
  const techSpecs = new Set(
    names
      .map((name) => designStem(name, /^(.*?)[-.]tech-spec\.md$/i))
      .filter((value): value is string => value !== null),
  );
  const assumptions = new Set(
    names
      .map((name) => designStem(name, /^(.*?)[-.]assumptions\.md$/i))
      .filter((value): value is string => value !== null),
  );
  if (
    designs.size === 0
    || designs.size !== techSpecs.size
    || designs.size !== assumptions.size
    || [...designs].some(
      (stem) => !techSpecs.has(stem) || !assumptions.has(stem),
    )
  ) {
    throw new Error(
      'Document workflow did not produce complete design-doc output triplets',
    );
  }
}

function assertExpectedOutputSet(
  workflowClass: BackgroundWorkflowClass,
  names: readonly string[],
): void {
  switch (workflowClass) {
    case 'prd':
      assertSingleMatch(names, /(?:^PRD\.md$|\.prd\.md$)/i, 'PRD markdown');
      assertSingleMatch(names, /\.backlog\.json$/i, 'backlog JSON');
      return;
    case 'design-doc':
      assertCompleteDesignTriplets(names);
      return;
    case 'validation':
      if (
        names.length !== 2
        || !names.includes('review-scorecard.json')
        || !names.includes('review-scorecard.md')
      ) {
        throw new Error(
          'Document workflow did not produce both validation scorecard files',
        );
      }
      return;
    case 'test-cases':
      assertSingleMatch(names, /\.test-cases\.json$/i, 'test-case JSON');
      assertSingleMatch(names, /\.test-cases\.md$/i, 'test-case markdown');
      assertSingleMatch(names, /\.backlog\.json$/i, 'patched backlog JSON');
      return;
    case 'walkthrough-smart-tagging':
      if (
        names.length !== 1
        || names[0] !== 'walkthrough-anchor-smart-tagging.json'
      ) {
        throw new Error(
          'Document workflow did not produce the smart-tagging JSON',
        );
      }
      return;
    default: {
      const unhandled: never = workflowClass;
      throw new Error(`Unsupported document workflow: ${String(unhandled)}`);
    }
  }
}

function contentType(relativePath: string): string {
  if (/\.json$/i.test(relativePath)) return 'application/json';
  if (/\.md$/i.test(relativePath)) return 'text/markdown; charset=utf-8';
  return 'application/octet-stream';
}

async function listDocumentOutputPaths(
  outputDirectory: string,
  workflowClass: BackgroundWorkflowClass,
): Promise<string[]> {
  const found: string[] = [];

  async function visit(directory: string, relativeDirectory = ''): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = [relativeDirectory, entry.name]
        .filter(Boolean)
        .join('/');
      const target = path.join(directory, entry.name);
      const metadata = await fs.lstat(target);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Refusing symbolic-link document output: ${relativePath}`);
      }
      if (metadata.isDirectory()) {
        if (
          workflowClass !== 'design-doc'
          || relativeDirectory
          || !/^[^/]+-design-spec$/i.test(entry.name)
        ) {
          throw new Error(`Refusing unexpected document output directory: ${relativePath}`);
        }
        await visit(target, relativePath);
        continue;
      }
      if (
        metadata.isFile()
        && isExpectedOutputPath(workflowClass, relativePath)
      ) {
        found.push(relativePath);
      }
    }
  }

  await visit(outputDirectory);
  return found.sort();
}

/**
 * Read only the named output contract. Inputs, repository data, `.git`, and
 * every unrelated workspace file remain local and are deleted with the attempt.
 */
export async function collectDocumentArtifacts(
  workspacePath: string,
  workflowClass: BackgroundWorkflowClass,
): Promise<ArtifactFile[]> {
  const outputDirectory = path.join(workspacePath, ...OUTPUT_DIRECTORY_PARTS);
  const outputPaths = await listDocumentOutputPaths(
    outputDirectory,
    workflowClass,
  );
  assertExpectedOutputSet(workflowClass, outputPaths);

  const artifacts: ArtifactFile[] = [];
  for (const relativePath of outputPaths) {
    const target = path.join(outputDirectory, ...relativePath.split('/'));
    const metadata = await fs.lstat(target);
    if (
      metadata.isSymbolicLink()
      || !metadata.isFile()
      || metadata.nlink > 1
    ) {
      throw new Error(`Refusing non-regular document output: ${relativePath}`);
    }
    artifacts.push({
      path: `${ARTIFACT_OUTPUT_PREFIX}${relativePath}`,
      content: await fs.readFile(target),
      contentType: contentType(relativePath),
    });
  }
  return artifacts;
}

async function prepareDocumentWorkspace(
  specification: AiRunV2DocumentSpecification,
  tempRoot: string,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) throw abortError();
  const workspacePath = await fs.mkdtemp(
    path.join(tempRoot, 'apex-document-attempt-'),
  );
  try {
    await fs.mkdir(
      path.join(workspacePath, ...OUTPUT_DIRECTORY_PARTS),
      { recursive: true },
    );
    if (signal.aborted) throw abortError();
    const frozenSkillPath = path.join(
      workspacePath,
      '.cursor',
      'frozen-skill',
      'SKILL.md',
    );
    await fs.mkdir(path.dirname(frozenSkillPath), { recursive: true });
    await fs.writeFile(frozenSkillPath, specification.skillContent, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    if (signal.aborted) throw abortError();
    for (const input of specification.scratchInputs) {
      if (signal.aborted) throw abortError();
      const target = path.resolve(workspacePath, ...input.path.split('/'));
      const relative = path.relative(workspacePath, target);
      if (
        relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)
      ) {
        throw new Error(`Scratch input escaped the attempt workspace: ${input.path}`);
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, input.content, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
    }
    if (signal.aborted) throw abortError();
    return workspacePath;
  } catch (error) {
    await fs.rm(workspacePath, { recursive: true, force: true });
    throw error;
  }
}

async function openDocumentRepository(
  specification: AiRunV2DocumentSpecification,
  signal?: AbortSignal,
): Promise<RepoReader> {
  const identity = {
    provider: specification.provider as 'ado' | 'github',
    project: specification.projectId,
    repo: specification.repository as string,
    sha: specification.groundedSha as string,
  };

  const serviceUrl = resolveRepoReadServiceUrl();
  if (serviceUrl) {
    const reader = new RepoServiceReader({
      identity,
      baseUrl: serviceUrl,
      signal,
    });
    await raceOperation(reader.listDir(''), signal);
    return reader;
  }

  throw new Error(
    'The document worker has no worker-visible repository reader for the pinned SHA',
  );
}

function executionSnapshot(
  specification: AiRunV2DocumentSpecification,
  workspacePath: string,
): ExecutionSnapshot {
  const prompt = [
    specification.prompt,
    '',
    '# Frozen execution skill',
    `Source path: ${specification.skillPath}`,
    `SHA-256: ${specification.skillSha256}`,
    '',
    specification.skillContent,
    '',
    'The skill above is the immutable version selected for this run. Follow it exactly and do not load another version.',
  ].join('\n');
  return {
    prompt,
    model: specification.model,
    ...(specification.effort === null
      ? {}
      : { effort: specification.effort }),
    workspaceRef: workspacePath,
    ...(specification.groundedSha
      ? { groundedSha: specification.groundedSha }
      : {}),
    ...(specification.repository
      ? { repository: specification.repository }
      : {}),
    ...(specification.provider ? { provider: specification.provider } : {}),
    workflowClass: specification.workflowClass,
    skillPath: specification.skillPath,
    projectId: specification.projectId,
    threadId: specification.threadId,
  };
}

function isSuccessfulWait(result: CursorExecutionResult): boolean {
  return (
    result.waitResult.status === 'finished'
    || result.waitResult.status === 'completed'
    || result.waitResult.status === 'success'
  );
}

function abortError(): Error {
  const error = new Error('Document execution aborted');
  error.name = 'AbortError';
  return error;
}

async function raceOperation<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) throw abortError();
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => rejectAbort(abortError());
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function executeWithAbort(
  execution: WorkerCursorExecution,
  run: () => Promise<CursorExecutionResult>,
  signal: AbortSignal,
): Promise<CursorExecutionResult> {
  if (signal.aborted) throw abortError();

  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    void execution.run.cancel?.().catch(() => undefined);
    rejectAbort(abortError());
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([run(), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function createDocumentExecute(
  dependencies: DocumentExecutionDependencies = {},
): ExecuteWorkload {
  const openRepository =
    dependencies.openRepository ?? openDocumentRepository;
  const createExecution =
    dependencies.createExecution ?? createLocalCursorExecution;
  const tempRoot = dependencies.tempRoot ?? os.tmpdir();
  const now = dependencies.now ?? Date.now;

  return async ({
    specification: unknownSpecification,
    command,
    checkpoints,
    signal,
  }): Promise<ExecutionOutcome> => {
    if (!isAiRunV2DocumentSpecification(unknownSpecification)) {
      throw new Error('Command referenced an invalid document specification');
    }
    const actualSkillSha = createHash('sha256')
      .update(unknownSpecification.skillContent)
      .digest('hex');
    if (actualSkillSha !== unknownSpecification.skillSha256.toLowerCase()) {
      throw new Error('Command referenced document skill content with a mismatched hash');
    }
    if (command.workloadLane !== 'document') {
      throw new Error('Document worker received a non-document command');
    }
    if (signal.aborted) throw abortError();

    const specification = unknownSpecification;
    const startedAt = now();
    await raceOperation(
      checkpoints.publishProgress('workspace', 'preparing'),
      signal,
    );
    const workspacePath = await prepareDocumentWorkspace(
      specification,
      tempRoot,
      signal,
    );
    let execution: WorkerCursorExecution | undefined;
    try {
      const snapshot = executionSnapshot(specification, workspacePath);
      const repository = documentWorkflowRequiresRepository(
        specification.workflowClass,
      )
        ? await raceOperation(openRepository(specification, signal), signal)
        : undefined;
      if (signal.aborted) throw abortError();

      await raceOperation(
        checkpoints.publishProgress('workspace', 'ready'),
        signal,
      );
      execution = await raceOperation(
        createExecution(snapshot, repository, signal),
        signal,
      );
      await raceOperation(
        checkpoints.publishProgress('execution', 'running'),
        signal,
      );

      let sequence = 0;
      const result = await executeWithAbort(
        execution,
        () =>
          executeCursorExecutionCore({
            snapshot,
            run: execution!.run,
            context: {
              runId: command.runId,
              sourceInstance: 'ai-runs-v2-document-worker',
            },
            sink: {
              publish: (event, envelope) => {
                if (
                  event.type !== 'phase'
                  && event.type !== 'tool_call'
                  && event.type !== 'tool_status'
                  && event.type !== 'error'
                ) {
                  return;
                }
                return checkpoints.publishProgress(
                  envelope.phase,
                  envelope.status,
                  envelope.detail,
                );
              },
            },
            hooks: {
              beforeStreamEvent: () => {
                if (signal.aborted) throw abortError();
              },
            },
            nextSequence: () => ++sequence,
          }),
        signal,
      );
      if (!isSuccessfulWait(result)) {
        throw new Error('Cursor document execution did not finish successfully');
      }

      await raceOperation(
        checkpoints.publishProgress('artifacts', 'collecting'),
        signal,
      );
      const files = await raceOperation(
        collectDocumentArtifacts(
          workspacePath,
          specification.workflowClass,
        ),
        signal,
      );
      return {
        files,
        durationMs: Math.max(0, now() - startedAt),
        ...(result.text.trim() ? { detail: result.text.trim().slice(0, 500) } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
      };
    } catch (error) {
      if (error instanceof CursorExecutionWaitError) {
        throw error;
      }
      throw error;
    } finally {
      if (signal.aborted) {
        await execution?.run.cancel?.().catch(() => undefined);
      }
      await execution?.dispose().catch(() => undefined);
      await fs.rm(workspacePath, { recursive: true, force: true });
    }
  };
}
