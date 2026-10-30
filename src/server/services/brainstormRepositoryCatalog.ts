import { promises as dns } from 'node:dns';
import fsSync, { promises as fs } from 'node:fs';
import path from 'node:path';
import { and, asc, eq, ne } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { brainstormRepositories, brainstormSources } from '../db/schema';
import type {
  BrainstormCatalogRepositoryDto,
  BrainstormCatalogStatus,
  BrainstormRepositoryDriftResult,
} from '../../shared/types/brainstormSources';
import {
  assertCloneHostIsPublic,
  validateCloneUrl,
  validateRevision,
  type DnsLookup,
} from './brainstorm/cloneUrlValidator';
import { credentialsForCloneUrl, redactCloneFailure } from './brainstorm/cloneCredentials';
import { resolveTemporarySha } from './brainstorm/gitSourceClone';
import { git } from '../utils/asyncGit';
import { resolveDataRoot } from '../utils/dataDir';

export class BrainstormCatalogError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BrainstormCatalogError';
  }
}

export function sharedBrainstormRepositoryMirrorDir(id: string, dataRoot = resolveDataRoot()): string {
  return path.join(dataRoot, 'workspaces', 'brainstorm-repo-mirrors', id);
}

export function legacyBrainstormRepositoryMirrorDir(id: string, dataRoot = resolveDataRoot()): string {
  return path.join(dataRoot, 'brainstorm-repo-mirrors', id);
}

/**
 * Resolves the mirror directory for a catalog repository.
 * Places new clones under `<dataRoot>/workspaces/brainstorm-repo-mirrors/<id>` so
 * Cloud App Service writes onto the shared Azure Files mount (`/home/data/ai-pilot/workspaces`)
 * visible to the V2 interactive container apps, while preserving existing local clones
 * that were created at `<dataRoot>/brainstorm-repo-mirrors/<id>`.
 */
export function brainstormRepositoryMirrorDir(id: string, dataRoot = resolveDataRoot()): string {
  const shared = sharedBrainstormRepositoryMirrorDir(id, dataRoot);
  const legacy = legacyBrainstormRepositoryMirrorDir(id, dataRoot);
  if (!fsSync.existsSync(shared) && fsSync.existsSync(legacy)) {
    return legacy;
  }
  return shared;
}

function toDto(row: typeof brainstormRepositories.$inferSelect): BrainstormCatalogRepositoryDto {
  return {
    id: row.id,
    displayName: row.displayName,
    cloneUrl: row.cloneUrl,
    branch: row.branch,
    status: row.status,
    commitSha: row.commitSha,
    error: row.error,
    updatedAt: row.updatedAt,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505'
    || (err as { cause?: { code?: string } } | null)?.cause?.code === '23505';
}

export function catalogReadiness(status: BrainstormCatalogStatus, error: string | null): { ready: boolean; text: string } {
  if (status === 'ready') return { ready: true, text: 'Ready to attach' };
  if (status === 'cloning') return { ready: false, text: 'Cloning…' };
  if (status === 'failed') return { ready: false, text: error || 'The clone failed. An administrator can try again.' };
  return { ready: false, text: 'An administrator still needs to clone this repository.' };
}

export async function listBrainstormRepositories(project: string): Promise<BrainstormCatalogRepositoryDto[]> {
  const rows = await db
    .select()
    .from(brainstormRepositories)
    .where(eq(brainstormRepositories.project, project))
    .orderBy(asc(brainstormRepositories.displayName));
  return rows.map(toDto);
}

export async function findBrainstormRepository(project: string, id: string): Promise<BrainstormCatalogRepositoryDto | null> {
  const [row] = await db
    .select()
    .from(brainstormRepositories)
    .where(and(eq(brainstormRepositories.id, id), eq(brainstormRepositories.project, project)))
    .limit(1);
  return row ? toDto(row) : null;
}

const defaultDnsLookup: DnsLookup = async (hostname) => {
  const entries = await dns.lookup(hostname, { all: true });
  return entries.map((entry) => entry.address);
};

async function checkedPublicUrl(cloneUrl: string, lookup: DnsLookup = defaultDnsLookup): Promise<string> {
  const url = validateCloneUrl(cloneUrl);
  if (!url.ok) throw new BrainstormCatalogError(url.code, 400, url.error);
  const hostCheck = await assertCloneHostIsPublic(url.url, lookup);
  if (!hostCheck.ok) throw new BrainstormCatalogError(hostCheck.code, 400, hostCheck.error);
  return url.url.toString();
}

function checkedBranch(branch: string): string {
  const revision = validateRevision(branch);
  if (!revision.ok) throw new BrainstormCatalogError(revision.code, 400, 'Enter a branch name.');
  return branch.trim();
}

export async function addBrainstormRepository(input: {
  project: string;
  userId: string;
  displayName: string;
  cloneUrl: string;
  branch: string;
  lookup?: DnsLookup;
}): Promise<BrainstormCatalogRepositoryDto> {
  const displayName = input.displayName.trim();
  if (!displayName || displayName.length > 80) {
    throw new BrainstormCatalogError('INVALID_NAME', 400, 'Enter a name of 80 characters or fewer.');
  }
  const cloneUrl = await checkedPublicUrl(input.cloneUrl, input.lookup);
  const branch = checkedBranch(input.branch);
  try {
    const [row] = await db
      .insert(brainstormRepositories)
      .values({
        project: input.project,
        displayName,
        cloneUrl,
        branch,
        status: 'not_cloned',
        createdBy: input.userId,
      })
      .returning();
    return (await beginClone(input.project, row.id)) ?? toDto(row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new BrainstormCatalogError('REPOSITORY_EXISTS', 409, 'This repository and branch are already added.');
    }
    throw err;
  }
}

async function beginClone(project: string, id: string): Promise<BrainstormCatalogRepositoryDto | null> {
  const [claimed] = await db
    .update(brainstormRepositories)
    .set({ status: 'cloning', error: null, updatedAt: new Date().toISOString() })
    .where(and(
      eq(brainstormRepositories.id, id),
      eq(brainstormRepositories.project, project),
      ne(brainstormRepositories.status, 'cloning'),
    ))
    .returning();
  if (!claimed) return findBrainstormRepository(project, id);
  void runClone(claimed);
  return toDto(claimed);
}

async function runClone(claimed: typeof brainstormRepositories.$inferSelect): Promise<void> {
  const destination = sharedBrainstormRepositoryMirrorDir(claimed.id);
  const legacyDestination = legacyBrainstormRepositoryMirrorDir(claimed.id);
  const creds = credentialsForCloneUrl(new URL(claimed.cloneUrl));
  try {
    await fs.rm(destination, { recursive: true, force: true });
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await git([
      'clone', '--depth', '1', '--single-branch', '--branch', claimed.branch, '--', claimed.cloneUrl, destination,
    ], { timeout: 180_000, env: creds.env });
    if (legacyDestination !== destination) {
      await fs.rm(legacyDestination, { recursive: true, force: true }).catch(() => {});
    }
    const sha = (await git(['-C', destination, 'rev-parse', 'HEAD'])).trim().toLowerCase();
    const nowIso = new Date().toISOString();
    await db
      .update(brainstormRepositories)
      .set({ status: 'ready', commitSha: sha, error: null, updatedAt: nowIso })
      .where(eq(brainstormRepositories.id, claimed.id));
    // Keep attached session sources aligned with the refreshed catalog mirror so
    // sessions re-materialize the updated commit on their next turn instead of
    // failing with "The saved clone changed" or citing a stale SHA.
    await db
      .update(brainstormSources)
      .set({
        requestedRevision: sha,
        resolvedSha: sha,
        workspaceState: 'cleaned',
        reasonCode: null,
        reasonText: null,
        updatedAt: nowIso,
      })
      .where(and(
        eq(brainstormSources.project, claimed.project),
        eq(brainstormSources.kind, 'project-repository'),
        eq(brainstormSources.refId, claimed.id),
        ne(brainstormSources.workspaceState, 'removed'),
      ))
      .catch(() => {});
  } catch (err) {
    const message = redactCloneFailure((err as Error).message || 'The clone failed.', [creds.secret])
      || 'The clone failed. Check the URL and branch, then try again.';
    await db
      .update(brainstormRepositories)
      .set({ status: 'failed', error: message, updatedAt: new Date().toISOString() })
      .where(eq(brainstormRepositories.id, claimed.id));
  }
}

/** Starts a clone unless one is already running. Returns the row in its cloning state. */
export async function cloneBrainstormRepository(project: string, id: string): Promise<BrainstormCatalogRepositoryDto | null> {
  return beginClone(project, id);
}

/** Deletes a catalog repository and removes its local mirror directory. */
export async function deleteBrainstormRepository(project: string, id: string): Promise<boolean> {
  const existing = await findBrainstormRepository(project, id);
  if (!existing) return false;
  if (existing.status === 'cloning') {
    throw new BrainstormCatalogError(
      'REPOSITORY_CLONING',
      409,
      'This repository is currently cloning. Wait for the clone to finish before deleting.',
    );
  }
  const deleted = await db
    .delete(brainstormRepositories)
    .where(and(
      eq(brainstormRepositories.id, id),
      eq(brainstormRepositories.project, project),
      ne(brainstormRepositories.status, 'cloning'),
    ))
    .returning({ id: brainstormRepositories.id });
  if (deleted.length === 0) return false;
  const nowIso = new Date().toISOString();
  await db
    .update(brainstormSources)
    .set({
      workspaceState: 'unavailable',
      reasonCode: 'NOT_READY',
      reasonText: 'This repository was removed from the project catalog.',
      updatedAt: nowIso,
    })
    .where(and(
      eq(brainstormSources.project, project),
      eq(brainstormSources.kind, 'project-repository'),
      eq(brainstormSources.refId, id),
      ne(brainstormSources.workspaceState, 'removed'),
    ))
    .catch(() => {});
  await Promise.all([
    fs.rm(sharedBrainstormRepositoryMirrorDir(id), { recursive: true, force: true }).catch(() => {}),
    fs.rm(legacyBrainstormRepositoryMirrorDir(id), { recursive: true, force: true }).catch(() => {}),
  ]);
  return true;
}

/** Checks whether the remote branch HEAD has moved ahead of the local mirror's commitSha. */
export async function checkBrainstormRepositoryDrift(
  project: string,
  id: string,
  lookup: DnsLookup = defaultDnsLookup,
): Promise<BrainstormRepositoryDriftResult | null> {
  const repo = await findBrainstormRepository(project, id);
  if (!repo) return null;
  const checkedAt = new Date().toISOString();
  const urlCheck = validateCloneUrl(repo.cloneUrl);
  if (!urlCheck.ok) {
    return {
      id: repo.id,
      localSha: repo.commitSha,
      remoteSha: null,
      drifted: false,
      reachable: false,
      checkedAt,
    };
  }
  const hostCheck = await assertCloneHostIsPublic(urlCheck.url, lookup);
  if (!hostCheck.ok) {
    return {
      id: repo.id,
      localSha: repo.commitSha,
      remoteSha: null,
      drifted: false,
      reachable: false,
      checkedAt,
    };
  }
  const remote = await resolveTemporarySha({
    url: repo.cloneUrl,
    revision: repo.branch,
    signal: AbortSignal.timeout(15_000),
  });
  if ('error' in remote) {
    return {
      id: repo.id,
      localSha: repo.commitSha,
      remoteSha: null,
      drifted: false,
      reachable: false,
      checkedAt,
    };
  }
  const localSha = repo.commitSha?.toLowerCase() ?? null;
  const remoteSha = remote.sha.toLowerCase();
  return {
    id: repo.id,
    localSha,
    remoteSha,
    drifted: Boolean(localSha && localSha !== remoteSha),
    reachable: true,
    checkedAt,
  };
}
