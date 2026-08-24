import fs from 'fs';
import path from 'path';
import type { RunGrounding } from '../../../shared/types/runGrounding';
import { git, safeArgs } from '../../utils/asyncGit';
import { getRepoCacheDir } from '../repoCacheService';
import { cacheOptionsFromGrounding } from './mirrorStore';

const SHA_RE = /^[0-9a-f]{40}$/i;

export function pinRefName(sha: string): string {
  const normalized = sha.trim().toLowerCase();
  if (!SHA_RE.test(normalized)) {
    throw new Error(`Invalid commit SHA for pin ref: ${sha}`);
  }
  return `refs/apex/pins/${normalized}`;
}

export async function writePinRef(cacheDir: string, sha: string): Promise<void> {
  const ref = pinRefName(sha);
  await git(safeArgs(cacheDir, ['update-ref', ref, sha.trim()]), {
    cwd: cacheDir,
  });
}

export async function deletePinRef(cacheDir: string, sha: string): Promise<void> {
  const ref = pinRefName(sha);
  try {
    await git(safeArgs(cacheDir, ['update-ref', '-d', ref]), {
      cwd: cacheDir,
    });
  } catch {
    // Missing pin refs are not an error — the commit may never have been pinned.
  }
}

function mirrorExists(cacheDir: string): boolean {
  return fs.existsSync(path.join(cacheDir, 'HEAD'));
}

export async function pinGroundingCommit(grounding: RunGrounding): Promise<void> {
  const cacheDir = getRepoCacheDir(cacheOptionsFromGrounding(grounding));
  if (!mirrorExists(cacheDir)) return;
  await writePinRef(cacheDir, grounding.groundedSha);
}

export async function unpinGroundingCommitIfUnused(
  grounding: RunGrounding,
  listActive: () => Promise<RunGrounding[]>,
): Promise<void> {
  const remaining = await listActive();
  const stillPinned = remaining.some(
    (row) =>
      row.provider === grounding.provider &&
      row.project === grounding.project &&
      row.repository === grounding.repository &&
      row.groundedSha === grounding.groundedSha,
  );
  if (stillPinned) return;
  const cacheDir = getRepoCacheDir(cacheOptionsFromGrounding(grounding));
  if (!mirrorExists(cacheDir)) return;
  await deletePinRef(cacheDir, grounding.groundedSha);
}
