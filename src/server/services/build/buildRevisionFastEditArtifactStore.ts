import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { resolveDataRoot } from '../../utils/dataDir';
import { git, safeArgs } from '../../utils/asyncGit';
import { WORKTREE_GIT_TIMEOUT_MS } from '../repoGitSettings';
import type { FastEditArtifactPointer } from './buildRevisionFastEditContracts';

export interface FastEditWorkspaceChange {
  status: 'A' | 'M' | 'D';
  relativePath: string;
}

export interface MaterializedBuildRevisionFastEditArtifact {
  artifact: FastEditArtifactPointer;
  changedPaths: string[];
  deletePaths: string[];
  localPath: string;
}

export interface BuildRevisionFastEditArtifactStore {
  materialize(input: {
    workspacePath: string;
    baseCommit: string;
    changes?: FastEditWorkspaceChange[];
  }): Promise<MaterializedBuildRevisionFastEditArtifact>;
  resolve(artifact: FastEditArtifactPointer): Promise<{
    localPath: string;
    changedPaths: string[];
    deletePaths: string[];
  }>;
}

interface LocalArtifactStoreDependencies {
  artifactRoot?: string;
  listChanges?: (
    workspacePath: string,
    baseCommit: string,
  ) => Promise<FastEditWorkspaceChange[]>;
}

interface FastEditArtifactManifest {
  version: 1;
  baseCommit: string;
  digest: string;
  changedPaths: string[];
  deletePaths: string[];
}

function safeRelativePath(value: string): string | null {
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  if (
    !normalized
    || normalized === '.'
    || normalized.startsWith('../')
    || path.posix.isAbsolute(normalized)
    || /^[a-z]:\//i.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

export function isAllowedFastEditPath(value: string): boolean {
  const normalized = safeRelativePath(value);
  if (!normalized) return false;
  const inUiSource =
    normalized.startsWith('apps/web/src/')
    || normalized.startsWith('packages/ui/src/');
  if (!inUiSource) return false;
  return !/(^|\/)(api|auth|config|routes?|server|integrations?)(\/|$)/i.test(
    normalized,
  );
}

function parseNameStatus(output: string): FastEditWorkspaceChange[] {
  const fields = output.split('\0').filter(Boolean);
  if (fields.length % 2 !== 0) {
    throw new Error('Git returned an invalid fast-edit change list.');
  }
  const changes: FastEditWorkspaceChange[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index];
    if (status !== 'A' && status !== 'M' && status !== 'D') {
      throw new Error(`Fast edit does not support Git status ${status}.`);
    }
    changes.push({ status, relativePath: fields[index + 1] });
  }
  return changes;
}

async function listWorkspaceChanges(
  workspacePath: string,
  baseCommit: string,
): Promise<FastEditWorkspaceChange[]> {
  const tracked = parseNameStatus(
    await git(
      safeArgs(workspacePath, [
        'diff',
        '--name-status',
        '--no-renames',
        '-z',
        baseCommit,
      ]),
      { cwd: workspacePath, timeout: WORKTREE_GIT_TIMEOUT_MS },
    ),
  );
  const untrackedOutput = await git(
    safeArgs(workspacePath, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ]),
    { cwd: workspacePath, timeout: WORKTREE_GIT_TIMEOUT_MS },
  );
  const untracked = untrackedOutput
    .split('\0')
    .filter(Boolean)
    .map((relativePath) => ({
      status: 'A' as const,
      relativePath,
    }));
  const byPath = new Map<string, FastEditWorkspaceChange>();
  for (const change of [...tracked, ...untracked]) {
    byPath.set(change.relativePath, change);
  }
  return [...byPath.values()];
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function refDigest(ref: string): string | null {
  const match = /^artifact:build-fast-edit:([0-9a-f]{64})$/.exec(ref);
  return match?.[1] ?? null;
}

export function createLocalBuildRevisionFastEditArtifactStore(
  dependencies: LocalArtifactStoreDependencies = {},
): BuildRevisionFastEditArtifactStore {
  const artifactRoot =
    dependencies.artifactRoot
    ?? path.join(resolveDataRoot(), 'build-revision-fast-edit-artifacts');
  const loadChanges = dependencies.listChanges ?? listWorkspaceChanges;

  return {
    async materialize(input) {
      if (!/^[0-9a-f]{40}$/.test(input.baseCommit)) {
        throw new Error('Fast-edit base commit must be a full Git commit.');
      }
      const rawChanges =
        input.changes
        ?? await loadChanges(input.workspacePath, input.baseCommit);
      const changes = rawChanges
        .map((change) => {
          const relativePath = safeRelativePath(change.relativePath);
          if (!relativePath || !isAllowedFastEditPath(relativePath)) {
            throw new Error(
              `Fast edit crossed the contained UI boundary: ${change.relativePath}`,
            );
          }
          return { ...change, relativePath };
        })
        .sort((left, right) =>
          left.relativePath.localeCompare(right.relativePath),
        );
      if (changes.length === 0) {
        throw new Error('The edit agent did not change any UI files.');
      }

      const digest = createHash('sha256');
      digest.update(`base\0${input.baseCommit}\0`);
      const fileBytes = new Map<string, Buffer>();
      const changedPaths: string[] = [];
      const deletePaths: string[] = [];
      for (const change of changes) {
        digest.update(`${change.status}\0${change.relativePath}\0`);
        if (change.status === 'D') {
          deletePaths.push(change.relativePath);
          continue;
        }
        const source = path.join(
          input.workspacePath,
          ...change.relativePath.split('/'),
        );
        const metadata = await lstat(source);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          throw new Error(
            `Fast edit output must be a regular file: ${change.relativePath}`,
          );
        }
        const bytes = await readFile(source);
        digest.update(bytes);
        fileBytes.set(change.relativePath, bytes);
        changedPaths.push(change.relativePath);
      }

      const digestHex = digest.digest('hex');
      const digestValue = `sha256:${digestHex}`;
      const artifact: FastEditArtifactPointer = {
        digest: digestValue,
        ref: `artifact:build-fast-edit:${digestHex}`,
      };
      const localPath = path.join(artifactRoot, digestHex);
      if (!(await exists(localPath))) {
        await mkdir(artifactRoot, { recursive: true });
        const staging = path.join(
          artifactRoot,
          `.staging-${digestHex}-${randomUUID()}`,
        );
        try {
          for (const [relativePath, bytes] of fileBytes) {
            const destination = path.join(
              staging,
              'files',
              ...relativePath.split('/'),
            );
            await mkdir(path.dirname(destination), { recursive: true });
            await writeFile(destination, bytes);
          }
          const manifest: FastEditArtifactManifest = {
            version: 1,
            baseCommit: input.baseCommit,
            digest: digestValue,
            changedPaths,
            deletePaths,
          };
          await mkdir(staging, { recursive: true });
          await writeFile(
            path.join(staging, 'manifest.json'),
            `${JSON.stringify(manifest, null, 2)}\n`,
          );
          if (await exists(localPath)) {
            await rm(staging, { recursive: true, force: true });
          } else {
            await rename(staging, localPath);
          }
        } catch (error) {
          await rm(staging, { recursive: true, force: true }).catch(
            () => undefined,
          );
          throw error;
        }
      }
      return { artifact, changedPaths, deletePaths, localPath };
    },

    async resolve(artifact) {
      const digestHex = refDigest(artifact.ref);
      if (!digestHex || artifact.digest !== `sha256:${digestHex}`) {
        throw new Error('Fast-edit artifact reference is invalid.');
      }
      const localPath = path.join(artifactRoot, digestHex);
      const manifest = JSON.parse(
        await readFile(path.join(localPath, 'manifest.json'), 'utf8'),
      ) as FastEditArtifactManifest;
      if (
        manifest.version !== 1
        || manifest.digest !== artifact.digest
        || !Array.isArray(manifest.changedPaths)
        || !Array.isArray(manifest.deletePaths)
      ) {
        throw new Error('Fast-edit artifact manifest is invalid.');
      }
      return {
        localPath,
        changedPaths: manifest.changedPaths,
        deletePaths: manifest.deletePaths,
      };
    },
  };
}

export const localBuildRevisionFastEditArtifactStore =
  createLocalBuildRevisionFastEditArtifactStore();
