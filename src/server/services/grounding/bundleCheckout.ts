/**
 * Database-free pieces of grounding bundle checkout, shared by the App Service
 * bundle store and the interactive actor host (which must not import the
 * database).
 */
import { execFile } from 'child_process';
import { readFile, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import type { SkillProvider } from '../../../shared/types/projectSettings';
import type {
  BundleKey,
  RepositoryIdentity,
} from '../../../shared/types/grounding';

const execFileAsync = promisify(execFile);

export const GROUNDING_BUNDLE_GIT_TIMEOUT_MS = 5 * 60 * 1000;
export const GROUNDING_WORKSPACE_READY_MARKER = 'apex-grounding-ready';

export type GitRunner = (
  args: string[],
  options?: { cwd?: string; signal?: AbortSignal; maxBuffer?: number }
) => Promise<string>;

export const defaultRunGit: GitRunner = async (args, options) => {
  const { stdout } = await execFileAsync('git', args, {
    cwd: options?.cwd,
    signal: options?.signal,
    windowsHide: true,
    maxBuffer: options?.maxBuffer ?? 10 * 1024 * 1024,
    timeout: GROUNDING_BUNDLE_GIT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  return stdout;
};

function safeSegment(value: string, label: string): string {
  const segment = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
  if (!segment || segment === '.' || segment === '..') {
    throw new Error(`Invalid repository ${label}`);
  }
  return segment;
}

export function safeSha(value: string): string {
  const sha = value.trim().toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) {
    throw new Error('Invalid repository SHA');
  }
  return sha;
}

export function bundleKey(identity: RepositoryIdentity): BundleKey {
  const provider = safeSegment(String(identity.provider), 'provider');
  const project = safeSegment(identity.project, 'project');
  const repo = safeSegment(identity.repo, 'repo');
  const sha = safeSha(identity.sha);
  return `${provider}/${project}/${repo}/${sha}.bundle` as BundleKey;
}

/**
 * GitHub repositories are published under the bare repository name, without
 * the owner, so a frozen `owner/repo` must be reduced the same way.
 */
export function bundleRepositoryName(
  provider: SkillProvider,
  repository: string,
): string {
  if (provider !== 'github') return repository;
  return repository.split('/').pop() || repository;
}

export async function verifyHead(
  runGit: GitRunner,
  destination: string,
  expectedSha: string
): Promise<boolean> {
  const head = (await runGit(['-C', destination, 'rev-parse', 'HEAD']))
    .trim()
    .toLowerCase();
  return head === expectedSha;
}

function readyMarkerPath(destination: string): string {
  return join(destination, '.git', GROUNDING_WORKSPACE_READY_MARKER);
}

export async function isReadyWorkspace(
  runGit: GitRunner,
  destination: string,
  expectedSha: string
): Promise<boolean> {
  try {
    const markedSha = (await readFile(readyMarkerPath(destination), 'utf8'))
      .trim()
      .toLowerCase();
    return markedSha === expectedSha && await verifyHead(
      runGit,
      destination,
      expectedSha
    );
  } catch {
    return false;
  }
}

export async function markWorkspaceReady(
  destination: string,
  expectedSha: string
): Promise<void> {
  await writeFile(readyMarkerPath(destination), `${expectedSha}\n`, 'utf8');
}

export async function prepareEmptyDestination(
  destination: string
): Promise<void> {
  try {
    const existing = await stat(destination);
    if (!existing.isDirectory()) {
      throw new Error('Grounding destination must be a directory');
    }
    await rm(destination, { recursive: true, force: true });
  } catch (error) {
    const code =
      error && typeof error === 'object'
        ? (error as { code?: unknown }).code
        : undefined;
    if (code !== 'ENOENT') throw error;
  }
}

/**
 * Verifies a downloaded bundle, checks it out detached at `expectedSha` into an
 * empty `destination`, and writes the ready marker.
 */
export async function checkoutBundleAtSha(
  input: Readonly<{
    runGit: GitRunner;
    bundlePath: string;
    scratchDirectory: string;
    destination: string;
    expectedSha: string;
  }>
): Promise<void> {
  const { runGit, bundlePath, scratchDirectory, destination, expectedSha } =
    input;
  const verificationRepo = join(scratchDirectory, 'verify.git');
  await runGit(['init', '--bare', verificationRepo]);
  await runGit(['-C', verificationRepo, 'bundle', 'verify', bundlePath]);
  await runGit(['clone', '--no-checkout', bundlePath, destination]);
  await runGit(['-C', destination, 'checkout', '--detach', expectedSha]);
  if (!(await verifyHead(runGit, destination, expectedSha))) {
    throw new Error('Grounding bundle SHA verification failed');
  }
  await markWorkspaceReady(destination, expectedSha);
}
