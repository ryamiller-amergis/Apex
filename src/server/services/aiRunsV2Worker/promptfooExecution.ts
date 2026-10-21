/**
 * Runs a workflow evaluation Promptfoo suite on the document worker.
 *
 * Promptfoo runs in a child process. Its package posts one event home even
 * with telemetry off, so the child gets a proxy that points at a closed port
 * and none of the worker's credentials. The child is killed when the attempt
 * is aborted.
 */
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  isAiRunV2PromptfooSpecification,
  PROMPTFOO_DETERMINISTIC_ASSERTION_TYPES,
  PROMPTFOO_RESULTS_FILE,
  PROMPTFOO_SUMMARY_FILE,
  PROMPTFOO_SUMMARY_MAX_FAILURES,
  renderPromptfooTarget,
  type AiRunV2PromptfooSpecification,
  type PromptfooDeterministicAssertionType,
  type WorkflowEvaluationPromptfooFailure,
  type WorkflowEvaluationPromptfooSummary,
  type WorkflowEvaluationPromptfooTarget,
} from '../../../shared/types/aiRunV2EvaluationSpec';
import type { ExecuteWorkload, ExecutionOutcome } from './worker';

/** A closed local port: any request Promptfoo makes fails instead of leaving the container. */
export const PROMPTFOO_BLOCKED_PROXY = 'http://127.0.0.1:9';

const STDERR_TAIL_CHARS = 2_000;

/** What the worker sends the runner over IPC. */
export type PromptfooRunnerRequest = Readonly<{
  targets: Readonly<Record<WorkflowEvaluationPromptfooTarget, string>>;
  tests: ReadonlyArray<AiRunV2PromptfooSpecification['suite']['tests'][number]>;
}>;

export type PromptfooRunnerRow = Readonly<{
  testIdx?: number;
  description?: string;
  success: boolean;
  error?: string | null;
  failures: ReadonlyArray<Readonly<{ type?: string; reason?: string }>>;
}>;

export type PromptfooRunnerReply =
  | Readonly<{ ok: true; rows: readonly PromptfooRunnerRow[] }>
  | Readonly<{ ok: false; error: string }>;

export type RunPromptfooRunner = (input: {
  runnerPath: string;
  request: PromptfooRunnerRequest;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}) => Promise<PromptfooRunnerReply>;

export type PromptfooExecutionDependencies = Readonly<{
  /** Path of the runner script installed with the worker's pinned Promptfoo package. */
  runnerPath?: string;
  runRunner?: RunPromptfooRunner;
  tempRoot?: string;
  parentEnv?: NodeJS.ProcessEnv;
  now?: () => number;
}>;

type TestResult = Readonly<{
  description: string;
  target: WorkflowEvaluationPromptfooTarget;
  passed: boolean;
  failures: readonly WorkflowEvaluationPromptfooFailure[];
}>;

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('Execution deadline elapsed');
  error.name = 'AbortError';
  return error;
}

const PASSTHROUGH_ENV = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'];

/** Only what Node needs to start, plus Promptfoo's off switches. No worker credentials. */
export function promptfooRunnerEnvironment(
  configDir: string,
  parentEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH_ENV) {
    if (parentEnv[key] !== undefined) env[key] = parentEnv[key];
  }
  return {
    ...env,
    NODE_ENV: 'production',
    HTTPS_PROXY: PROMPTFOO_BLOCKED_PROXY,
    HTTP_PROXY: PROMPTFOO_BLOCKED_PROXY,
    https_proxy: PROMPTFOO_BLOCKED_PROXY,
    http_proxy: PROMPTFOO_BLOCKED_PROXY,
    NO_PROXY: '',
    no_proxy: '',
    PROMPTFOO_CONFIG_DIR: configDir,
    PROMPTFOO_DISABLE_TELEMETRY: '1',
    PROMPTFOO_DISABLE_SHARING: '1',
    PROMPTFOO_DISABLE_UPDATE: '1',
    PROMPTFOO_DISABLE_REMOTE_GENERATION: '1',
    PROMPTFOO_CACHE_ENABLED: 'false',
  };
}

export const forkPromptfooRunner: RunPromptfooRunner = ({ runnerPath, request, cwd, env, signal }) =>
  new Promise<PromptfooRunnerReply>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const child = fork(runnerPath, [], {
      cwd,
      env,
      execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'json',
    });
    let outcome: (() => void) | null = null;
    let exited = false;
    let settled = false;
    let stderr = '';
    // Settles only once the child is gone: the caller deletes `cwd` next, and
    // Windows refuses to remove a folder a live process is using.
    const settle = (): void => {
      if (settled || !outcome) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      outcome();
    };
    const finish = (result: () => void): void => {
      if (outcome) return;
      outcome = result;
      if (exited || child.pid === undefined) {
        settle();
        return;
      }
      child.kill('SIGKILL');
    };
    const onAbort = (): void => finish(() => reject(abortError(signal)));
    signal.addEventListener('abort', onAbort, { once: true });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
    });
    child.once('message', (message) => finish(() => resolve(message as PromptfooRunnerReply)));
    child.once('error', (error) => finish(() => reject(error)));
    child.once('exit', (code, exitSignal) => {
      exited = true;
      finish(() => reject(new Error(
        `Promptfoo runner exited before replying (code=${String(code)}, signal=${String(exitSignal)})`
          + (stderr.trim() ? `: ${stderr.trim()}` : ''),
      )));
      settle();
    });
    child.send(request, (error) => {
      if (error) finish(() => reject(error));
    });
  });

function isRunnerReply(value: unknown): value is PromptfooRunnerReply {
  if (!value || typeof value !== 'object') return false;
  const reply = value as Record<string, unknown>;
  if (reply.ok === false) return typeof reply.error === 'string';
  return reply.ok === true && Array.isArray(reply.rows);
}

function assertionType(
  type: string | undefined,
  test: AiRunV2PromptfooSpecification['suite']['tests'][number],
): PromptfooDeterministicAssertionType {
  return (PROMPTFOO_DETERMINISTIC_ASSERTION_TYPES as readonly string[]).includes(type ?? '')
    ? type as PromptfooDeterministicAssertionType
    : test.assert[0].type;
}

function toTestResults(
  specification: AiRunV2PromptfooSpecification,
  rows: readonly PromptfooRunnerRow[],
): TestResult[] {
  return specification.suite.tests.map((test, index) => {
    const row = rows.find((candidate) => candidate.testIdx === index)
      ?? rows.find((candidate) => candidate.description === test.description);
    if (!row) {
      return {
        description: test.description,
        target: test.target,
        passed: false,
        failures: [{
          test: test.description,
          assertion: test.assert[0].type,
          reason: 'Promptfoo returned no result for this test.',
        }],
      };
    }
    const failures: WorkflowEvaluationPromptfooFailure[] = row.failures.map((failure) => ({
      test: test.description,
      assertion: assertionType(failure.type, test),
      reason: failure.reason?.trim() || 'Assertion failed.',
    }));
    if (!row.success && failures.length === 0) {
      failures.push({
        test: test.description,
        assertion: test.assert[0].type,
        reason: row.error?.trim() || 'Test failed.',
      });
    }
    return { description: test.description, target: test.target, passed: row.success, failures };
  });
}

function jsonFile(name: string, value: unknown) {
  return {
    path: `output/${name}`,
    content: `${JSON.stringify(value, null, 2)}\n`,
    contentType: 'application/json',
  };
}

export function createPromptfooExecute(
  dependencies: PromptfooExecutionDependencies = {},
): ExecuteWorkload {
  const runRunner = dependencies.runRunner ?? forkPromptfooRunner;
  const tempRoot = dependencies.tempRoot ?? os.tmpdir();
  const parentEnv = dependencies.parentEnv ?? process.env;
  const now = dependencies.now ?? Date.now;

  return async ({ specification, command, checkpoints, signal }): Promise<ExecutionOutcome> => {
    if (!isAiRunV2PromptfooSpecification(specification)) {
      throw new Error('Command referenced an invalid Promptfoo specification');
    }
    if (command.workloadLane !== 'document') {
      throw new Error('Document worker received a non-document command');
    }
    const suiteSha = createHash('sha256').update(JSON.stringify(specification.suite)).digest('hex');
    if (suiteSha !== specification.suiteSha256.toLowerCase()) {
      throw new Error('Command referenced a Promptfoo suite with a mismatched hash');
    }
    if (!dependencies.runnerPath) {
      throw new Error('This worker has no Promptfoo runner installed');
    }
    if (signal.aborted) throw abortError(signal);

    const startedAt = now();
    await checkpoints.publishProgress('execution', 'running');
    const workDir = await fs.mkdtemp(path.join(tempRoot, 'apex-promptfoo-'));
    let reply: PromptfooRunnerReply;
    try {
      const configDir = path.join(workDir, 'config');
      await fs.mkdir(configDir);
      reply = await runRunner({
        runnerPath: dependencies.runnerPath,
        request: {
          targets: {
            artifact: renderPromptfooTarget(specification.artifactPackage, 'artifact'),
            backlog: renderPromptfooTarget(specification.artifactPackage, 'backlog'),
          },
          tests: specification.suite.tests,
        },
        cwd: workDir,
        env: promptfooRunnerEnvironment(configDir, parentEnv),
        signal,
      });
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
    if (!isRunnerReply(reply)) {
      throw new Error('Promptfoo runner sent an unreadable reply');
    }
    if (!reply.ok) {
      throw new Error(`Promptfoo could not run the suite: ${reply.error}`);
    }

    await checkpoints.publishProgress('artifacts', 'collecting');
    const tests = toTestResults(specification, reply.rows);
    const passedCount = tests.filter((test) => test.passed).length;
    const failures = tests.flatMap((test) => test.failures);
    const durationMs = Math.max(0, now() - startedAt);
    const summary: WorkflowEvaluationPromptfooSummary = {
      suiteRef: specification.suite.ref,
      suiteSha256: specification.suiteSha256,
      artifactHash: specification.evaluation.artifactHash,
      passed: passedCount === tests.length,
      totals: { tests: tests.length, passed: passedCount, failed: tests.length - passedCount },
      failures: failures.slice(0, PROMPTFOO_SUMMARY_MAX_FAILURES),
      durationMs,
    };
    return {
      files: [
        jsonFile(PROMPTFOO_SUMMARY_FILE, summary),
        jsonFile(PROMPTFOO_RESULTS_FILE, { suiteRef: specification.suite.ref, tests }),
      ],
      durationMs,
      detail: `${passedCount}/${tests.length} Promptfoo tests passed`,
    };
  };
}
