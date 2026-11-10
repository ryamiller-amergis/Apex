import { createHash } from 'node:crypto';
import {
  access,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';

import { db } from '../../db/drizzle';
import { buildRevisions, buildRuns } from '../../db/schema';
import { resolveDataRoot } from '../../utils/dataDir';
import { git, safeArgs } from '../../utils/asyncGit';
import { checkoutDefaultBranch, getWorkspaceDir } from '../repoCheckoutService';
import { removeDirectoryAsync } from '../repoWorkspaceService';
import { WORKTREE_GIT_TIMEOUT_MS } from '../repoGitSettings';
import { appendBuildEvent } from '../buildEventsService';
import {
  createBuildEditablePreviewSessionService,
  type EditablePreviewRevisionTarget,
  type MaterializedEditablePreviewChangeSet,
  type MaterializedEditablePreviewSource,
} from './buildEditablePreviewSessionService';
import {
  createDockerEditablePreviewSessionProvider,
  type ResolvedEditablePreviewChangeSet,
  type ResolvedEditablePreviewSource,
} from './dockerEditablePreviewSessionProvider';
import { createDockerCommandRunner } from './dockerPreviewRuntime';
import { localBuildRevisionFastEditArtifactStore } from './buildRevisionFastEditArtifactStore';

const GOLDEN_STACK_TEMPLATE_VERSION = '1.0.0';
const SOURCE_SESSION_PREFIX = 'build-studio-source-';
const CHANGE_SESSION_PREFIX = 'build-studio-change-';

interface RegisteredSource extends ResolvedEditablePreviewSource {
  ref: string;
}

interface RegisteredChangeSet extends ResolvedEditablePreviewChangeSet {
  ref: string;
}

const sources = new Map<string, RegisteredSource>();
const changeSets = new Map<string, RegisteredChangeSet>();

function digestText(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function safeGitPath(value: string): string {
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('../') ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`Git returned an unsafe Studio path: ${value}`);
  }
  return normalized;
}

async function ensureCopied(
  source: string,
  destination: string
): Promise<void> {
  try {
    await access(destination);
  } catch {
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
}

export async function installGoldenStackStudioAdapter(
  workspace: string,
  adapterRoot = path.resolve(process.cwd(), 'templates', 'full-stack-express')
): Promise<void> {
  await Promise.all([
    access(path.join(workspace, 'package.json')),
    access(path.join(workspace, 'apps', 'web')),
  ]).catch(() => {
    throw new Error(
      'The revision is not a supported full-stack-express workspace.'
    );
  });

  await Promise.all([
    ensureCopied(
      path.join(adapterRoot, 'apex.preview.json'),
      path.join(workspace, 'apex.preview.json')
    ),
    ensureCopied(
      path.join(adapterRoot, 'Dockerfile.studio'),
      path.join(workspace, 'Dockerfile.studio')
    ),
    ensureCopied(
      path.join(adapterRoot, 'Dockerfile.studio.dockerignore'),
      path.join(workspace, 'Dockerfile.studio.dockerignore')
    ),
  ]);

  const workspacePreviewScripts = path.join(workspace, 'scripts', 'preview');
  try {
    await access(workspacePreviewScripts);
  } catch {
    await mkdir(path.dirname(workspacePreviewScripts), { recursive: true });
    await cp(
      path.join(adapterRoot, 'scripts', 'preview'),
      workspacePreviewScripts,
      { recursive: true }
    );
  }
  await copyFile(
    path.join(adapterRoot, 'scripts', 'preview', 'studio-runner.mjs'),
    path.join(workspacePreviewScripts, 'studio-runner.mjs')
  );
}

async function loadTarget(input: {
  buildRunId: string;
  draftRevisionId: string;
}): Promise<EditablePreviewRevisionTarget | null> {
  const [draft] = await db
    .select()
    .from(buildRevisions)
    .where(
      and(
        eq(buildRevisions.id, input.draftRevisionId),
        eq(buildRevisions.buildRunId, input.buildRunId)
      )
    )
    .limit(1);
  if (!draft) return null;

  const [[run], previous] = await Promise.all([
    db
      .select()
      .from(buildRuns)
      .where(eq(buildRuns.id, input.buildRunId))
      .limit(1),
    draft.revisionNumber === 1
      ? Promise.resolve([draft])
      : db
          .select()
          .from(buildRevisions)
          .where(
            and(
              eq(buildRevisions.buildRunId, input.buildRunId),
              eq(buildRevisions.revisionNumber, draft.revisionNumber - 1)
            )
          )
          .limit(1),
  ]);
  const base = previous[0];
  if (!run || !base?.validatedCommit) return null;

  return {
    buildRunId: run.id,
    project: run.project,
    repository: run.repository,
    integrationBranch: run.integrationBranch ?? `apex/build/${run.id}`,
    baseRevisionId: base.id,
    draftRevisionId: draft.id,
    revisionNumber: draft.revisionNumber,
    baseCommit: base.validatedCommit,
    templateVersion: GOLDEN_STACK_TEMPLATE_VERSION,
  };
}

async function checkoutExactRevision(
  target: EditablePreviewRevisionTarget,
  commit: string,
  sessionId: string
): Promise<string> {
  const workspace = await checkoutDefaultBranch({
    project: target.project,
    repo: target.repository,
    branch: target.integrationBranch,
    sessionId,
    provider: 'ado',
  });
  await git(safeArgs(workspace, ['checkout', '--detach', commit]), {
    cwd: workspace,
    timeout: WORKTREE_GIT_TIMEOUT_MS,
  });
  const checkedOut = (
    await git(safeArgs(workspace, ['rev-parse', 'HEAD']), {
      cwd: workspace,
      timeout: WORKTREE_GIT_TIMEOUT_MS,
    })
  ).trim();
  if (checkedOut !== commit) {
    throw new Error(`Studio could not materialize commit ${commit}.`);
  }
  return workspace;
}

async function materializeSource(
  target: EditablePreviewRevisionTarget
): Promise<MaterializedEditablePreviewSource> {
  const sessionId = `${SOURCE_SESSION_PREFIX}${target.draftRevisionId}`;
  let workspace: string | null = null;
  let ref: string | null = null;
  try {
    workspace = await checkoutExactRevision(
      target,
      target.baseCommit,
      sessionId
    );
    await installGoldenStackStudioAdapter(workspace);
    const manifestBytes = await readFile(
      path.join(workspace, 'apex.preview.json')
    );
    const manifestDigest = `sha256:${createHash('sha256')
      .update(manifestBytes)
      .digest('hex')}`;
    const sourceDigest = digestText(
      `${target.repository}:${target.baseCommit}:${manifestDigest}`
    );
    ref = `artifact:studio-source:${sourceDigest.slice('sha256:'.length)}`;
    sources.set(ref, {
      ref,
      path: workspace,
      digest: sourceDigest,
    });
    return {
      source: {
        snapshotDigest: sourceDigest,
        snapshotRef: ref,
      },
      developmentManifestDigest: manifestDigest,
      databaseGrantRef: `grant:studio-database:${target.buildRunId}`,
      release: async () => {
        if (ref) sources.delete(ref);
        await removeDirectoryAsync(getWorkspaceDir(sessionId));
      },
    };
  } catch (error) {
    if (ref) sources.delete(ref);
    if (workspace) {
      await removeDirectoryAsync(getWorkspaceDir(sessionId)).catch(
        () => undefined
      );
    }
    throw error;
  }
}

function parseNameStatus(output: string): Array<{
  status: string;
  relativePath: string;
}> {
  const fields = output.split('\0').filter(Boolean);
  if (fields.length % 2 !== 0) {
    throw new Error('Git returned an invalid Studio change list.');
  }
  const entries: Array<{ status: string; relativePath: string }> = [];
  for (let index = 0; index < fields.length; index += 2) {
    entries.push({
      status: fields[index],
      relativePath: safeGitPath(fields[index + 1]),
    });
  }
  return entries;
}

async function materializeChangeSet(input: {
  target: EditablePreviewRevisionTarget;
  validatedCommit: string;
}): Promise<MaterializedEditablePreviewChangeSet> {
  const sessionId = `${CHANGE_SESSION_PREFIX}${input.target.draftRevisionId}`;
  let workspace: string | null = null;
  let overlayRoot: string | null = null;
  let ref: string | null = null;
  try {
    workspace = await checkoutExactRevision(
      input.target,
      input.validatedCommit,
      sessionId
    );
    const changed = parseNameStatus(
      await git(
        safeArgs(workspace, [
          'diff',
          '--name-status',
          '--no-renames',
          '-z',
          input.target.baseCommit,
          input.validatedCommit,
        ]),
        { cwd: workspace, timeout: WORKTREE_GIT_TIMEOUT_MS }
      )
    );
    const dataRoot = resolveDataRoot();
    await mkdir(dataRoot, { recursive: true });
    overlayRoot = await mkdtemp(path.join(dataRoot, 'build-studio-change-'));
    const deletePaths: string[] = [];
    const digest = createHash('sha256');
    digest.update(`${input.target.baseCommit}\0${input.validatedCommit}\0`);

    for (const entry of changed) {
      digest.update(`${entry.status}\0${entry.relativePath}\0`);
      if (entry.status === 'D') {
        deletePaths.push(entry.relativePath);
        continue;
      }
      const sourcePath = path.join(workspace, ...entry.relativePath.split('/'));
      const metadata = await stat(sourcePath);
      if (!metadata.isFile()) {
        throw new Error(
          `Studio change ${entry.relativePath} is not a regular file.`
        );
      }
      const bytes = await readFile(sourcePath);
      digest.update(bytes);
      const destinationPath = path.join(
        overlayRoot,
        ...entry.relativePath.split('/')
      );
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await copyFile(sourcePath, destinationPath);
    }

    const changeDigest = `sha256:${digest.digest('hex')}`;
    ref = `artifact:studio-change:${changeDigest.slice('sha256:'.length)}`;
    changeSets.set(ref, {
      ref,
      path: overlayRoot,
      digest: changeDigest,
      deletePaths,
    });
    return {
      changeSet: {
        digest: changeDigest,
        contentRef: ref,
      },
      release: async () => {
        if (ref) changeSets.delete(ref);
        await Promise.all([
          removeDirectoryAsync(getWorkspaceDir(sessionId)),
          overlayRoot
            ? rm(overlayRoot, { recursive: true, force: true })
            : Promise.resolve(),
        ]);
      },
    };
  } catch (error) {
    if (ref) changeSets.delete(ref);
    await Promise.all([
      workspace
        ? removeDirectoryAsync(getWorkspaceDir(sessionId)).catch(
            () => undefined
          )
        : Promise.resolve(),
      overlayRoot
        ? rm(overlayRoot, { recursive: true, force: true }).catch(
            () => undefined
          )
        : Promise.resolve(),
    ]);
    throw error;
  }
}

function resolveSourceSnapshot(
  source: EditablePreviewSessionSnapshotSource
): Promise<ResolvedEditablePreviewSource> {
  const registered = sources.get(source.snapshotRef);
  if (!registered || registered.digest !== source.snapshotDigest) {
    throw new Error('Editable preview source artifact is unavailable.');
  }
  return Promise.resolve({
    path: registered.path,
    digest: registered.digest,
  });
}

interface EditablePreviewSessionSnapshotSource {
  snapshotDigest: string;
  snapshotRef: string;
}

function resolveChangeSet(
  changeSet: EditablePreviewChangeSetRef
): Promise<ResolvedEditablePreviewChangeSet> {
  const registered = changeSets.get(changeSet.contentRef);
  if (registered) {
    if (registered.digest !== changeSet.digest) {
      throw new Error('Editable preview change-set digest does not match.');
    }
    return Promise.resolve({
      path: registered.path,
      digest: registered.digest,
      deletePaths: registered.deletePaths,
    });
  }
  return localBuildRevisionFastEditArtifactStore
    .resolve({
      digest: changeSet.digest,
      ref: changeSet.contentRef,
    })
    .then((artifact) => ({
      path: path.join(artifact.localPath, 'files'),
      digest: changeSet.digest,
      deletePaths: artifact.deletePaths,
    }))
    .catch(() => {
      throw new Error('Editable preview change-set artifact is unavailable.');
    });
}

interface EditablePreviewChangeSetRef {
  digest: string;
  contentRef: string;
}

function publicLoopbackUrl(upstreamRef: string): string {
  const match = /^docker-loopback:(127\.0\.0\.1|\[?::1\]?):([0-9]+)$/.exec(
    upstreamRef
  );
  if (!match) {
    throw new Error('Docker Studio returned an invalid loopback upstream.');
  }
  const host = match[1].includes(':') ? '[::1]' : match[1];
  return `http://${host}:${match[2]}/`;
}

const docker = createDockerCommandRunner({ timeoutMs: 20 * 60_000 });
const provider = createDockerEditablePreviewSessionProvider({
  docker,
  resolveSourceSnapshot,
  resolveChangeSet,
});

export const defaultBuildEditablePreviewSessionService =
  createBuildEditablePreviewSessionService({
    isAvailable: () =>
      process.env.NODE_ENV !== 'production' &&
      !process.env.WEBSITE_SITE_NAME &&
      !process.env.CONTAINER_APP_NAME,
    provider,
    loadTarget,
    materializeSource,
    materializeChangeSet,
    publishPreview: async ({ upstreamRef }) => publicLoopbackUrl(upstreamRef),
    async persistSession({ target, previewUrl }) {
      await db
        .update(buildRevisions)
        .set({ previewUrl, updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(buildRevisions.id, target.draftRevisionId),
            eq(buildRevisions.buildRunId, target.buildRunId)
          )
        );
    },
    async persistAppliedRevision({ target, validatedCommit, previewUrl }) {
      await db
        .update(buildRevisions)
        .set({ previewUrl, updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(buildRevisions.id, target.draftRevisionId),
            eq(buildRevisions.buildRunId, target.buildRunId),
            eq(buildRevisions.validatedCommit, validatedCommit)
          )
        );
    },
    async appendEvent(input) {
      await appendBuildEvent(input);
    },
  });
