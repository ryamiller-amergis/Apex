/**
 * Local stand-in for the cursor-pool-worker Container Apps job. Runs the same
 * image with Docker on the developer's machine, so a product build can open a
 * real draft pull request before the job exists in dev.
 */
import { execFile } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const LOCAL_EXECUTION_PREFIX = 'apex-local-';
const DEFAULT_LOCAL_IMAGE = 'apex-cursor-worker:local';
const PROMPT_PATH = '/tmp/apex-prompt.txt';
/** Secrets are passed by name so their values never appear on the docker command line. */
const PASSTHROUGH_SECRETS = ['CURSOR_API_KEY', 'ADO_PAT', 'ADO_USER_TOKEN'] as const;

/** Local dev without a configured Container Apps job runs the worker in Docker. */
export function useLocalCursorContainer(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return !process.env.CURSOR_CONTAINER_JOB_NAME?.trim();
}

export function isLocalExecution(executionName: string): boolean {
  return executionName.startsWith(LOCAL_EXECUTION_PREFIX);
}

async function docker(args: string[], env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('docker', args, {
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env: env ?? process.env,
  });
}

export interface LocalContainerEnv {
  name: string;
  value: string;
}

/**
 * Creates the container, copies the prompt in, and starts it. The worker's
 * script reads AGENT_PROMPT, so the entrypoint loads it from the copied file.
 */
export async function startLocalCursorContainer(input: {
  executionName: string;
  prompt: string;
  env: LocalContainerEnv[];
  secrets: Partial<Record<(typeof PASSTHROUGH_SECRETS)[number], string | null | undefined>>;
}): Promise<void> {
  const image = process.env.CURSOR_LOCAL_WORKER_IMAGE?.trim() || DEFAULT_LOCAL_IMAGE;
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  const args = ['create', '--name', input.executionName, '--label', 'apex.local-cloud-agent=1'];
  for (const entry of input.env) {
    args.push('-e', `${entry.name}=${entry.value}`);
  }
  for (const name of PASSTHROUGH_SECRETS) {
    const value = input.secrets[name];
    if (!value) continue;
    childEnv[name] = value;
    args.push('-e', name);
  }
  args.push(
    '--entrypoint', '/bin/bash',
    image,
    '-c', `export AGENT_PROMPT="$(cat ${PROMPT_PATH})"; exec /usr/local/bin/cursor-run-cli`,
  );

  try {
    await docker(args, childEnv);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/No such image|pull access denied|Unable to find image/i.test(detail)) {
      throw new Error(
        `Local cloud-agent image ${image} is missing. Build it with: `
        + `docker build -f runners/cursor-pool-worker/Dockerfile -t ${image} .`,
      );
    }
    throw err;
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), 'apex-local-agent-'));
  const file = path.join(dir, 'prompt.txt');
  try {
    await writeFile(file, input.prompt, 'utf8');
    await docker(['cp', file, `${input.executionName}:${PROMPT_PATH}`]);
    await docker(['start', input.executionName]);
  } catch (err) {
    await docker(['rm', '-f', input.executionName]).catch(() => undefined);
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Container state as the Container Apps job words the poller already maps. */
export function localContainerJobStatus(state: string, exitCode: number): string {
  switch (state.trim().toLowerCase()) {
    case 'exited':
      return exitCode === 0 ? 'Succeeded' : 'Failed';
    case 'dead':
      return 'Failed';
    default:
      return 'Running';
  }
}

export async function getLocalContainerStatus(executionName: string): Promise<string> {
  try {
    const { stdout } = await docker([
      'inspect', '--format', '{{.State.Status}}|{{.State.ExitCode}}', executionName,
    ]);
    const [state, code] = stdout.trim().split('|');
    return localContainerJobStatus(state ?? '', Number(code ?? 0));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/No such (object|container)/i.test(detail)) return 'Failed';
    throw err;
  }
}

export async function getLocalContainerLogs(executionName: string, tail: string): Promise<string> {
  const { stdout, stderr } = await docker(['logs', '--tail', tail, executionName]);
  return [stdout, stderr].filter(Boolean).join('\n');
}

export async function stopLocalContainer(executionName: string): Promise<void> {
  await docker(['stop', executionName]);
}
