import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ADAPTER_DIR, BACKUP_DIR, LEGACY_VENDOR_DIR, APEX_DIR } from './layout.mjs';
import { assertWithin, ensureDir } from './util.mjs';

export const INSTALL_LOCK_REL = `${APEX_DIR}/install.lock`;

/**
 * Serialize installs per repository and restore every managed target if an
 * exception occurs. Snapshots live outside the repo and are always removed.
 */
export function withInstallTransaction(
  repoRoot,
  skillNames,
  action,
  { preflight = null } = {},
) {
  const root = path.resolve(repoRoot);
  const apexDir = assertWithin(root, APEX_DIR);
  const apexExisted = fs.existsSync(apexDir);
  const lockPath = assertWithin(root, INSTALL_LOCK_REL);
  let ownsLock = false;
  let lockFd = null;
  let snapshotRoot = null;
  let snapshots;
  let preserveSnapshot = false;

  try {
    ensureDir(apexDir);
    try {
      lockFd = fs.openSync(lockPath, 'wx');
      ownsLock = true;
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error(
          `APEX skills install already in progress (${INSTALL_LOCK_REL}). ` +
          `If no install is running, inspect and remove the stale lock deliberately.`,
        );
      }
      throw error;
    }

    try {
      fs.writeFileSync(
        lockFd,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          transactionId: randomUUID(),
        }) + '\n',
        'utf8',
      );
    } finally {
      fs.closeSync(lockFd);
      lockFd = null;
    }

    if (typeof preflight === 'function') preflight();

    snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-skills-transaction-'));
    const targets = transactionTargets(skillNames);
    snapshots = targets.map((rel, index) => snapshotTarget(root, rel, snapshotRoot, index));
    return action();
  } catch (error) {
    if (snapshots) {
      try {
        restoreSnapshots(root, snapshots);
      } catch (rollbackError) {
        preserveSnapshot = true;
        error.rollbackError = rollbackError;
        error.recoverySnapshot = snapshotRoot;
        error.message +=
          `\nRollback also failed: ${rollbackError.message}` +
          `\nRecovery snapshot retained at: ${snapshotRoot}`;
      }
    }
    throw error;
  } finally {
    if (lockFd !== null) {
      try { fs.closeSync(lockFd); } catch { /* best effort */ }
    }
    if (snapshotRoot && !preserveSnapshot) {
      try { fs.rmSync(snapshotRoot, { recursive: true, force: true }); }
      catch (error) { console.warn(`[apex-skills] Could not remove transaction snapshot: ${error.message}`); }
    }
    if (ownsLock && fs.existsSync(lockPath)) {
      try { fs.rmSync(lockPath, { force: true }); }
      catch (error) { console.warn(`[apex-skills] Could not remove ${INSTALL_LOCK_REL}: ${error.message}`); }
    }
    if (!apexExisted && fs.existsSync(apexDir) && fs.readdirSync(apexDir).length === 0) {
      try { fs.rmdirSync(apexDir); }
      catch (error) { console.warn(`[apex-skills] Could not remove empty ${APEX_DIR}: ${error.message}`); }
    }
  }
}

function transactionTargets(skillNames) {
  const names = [...new Set(skillNames ?? [])];
  return [
    'apex-skills.lock.json',
    LEGACY_VENDOR_DIR,
    ...names.map((name) => path.join(ADAPTER_DIR, name)),
    ...names.map((name) => path.join(BACKUP_DIR, name)),
  ];
}

function snapshotTarget(repoRoot, rel, snapshotRoot, index) {
  const absolute = assertWithin(repoRoot, rel);
  assertTreeHasNoSymlinks(absolute, rel);
  const snapshot = path.join(snapshotRoot, String(index));
  const existed = fs.existsSync(absolute);
  if (existed) {
    fs.cpSync(absolute, snapshot, { recursive: true, dereference: false });
  }
  return { rel, snapshot, existed };
}

function restoreSnapshots(repoRoot, snapshots) {
  const errors = [];
  for (const entry of [...snapshots].reverse()) {
    try {
      const absolute = assertWithin(repoRoot, entry.rel);
      removePathWithoutFollowingLinks(absolute);
      if (entry.existed) {
        ensureDir(path.dirname(absolute));
        fs.cpSync(entry.snapshot, absolute, { recursive: true, dereference: false });
      }
    } catch (error) {
      errors.push(new Error(`Failed to restore ${entry.rel}: ${error.message}`));
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, `${errors.length} managed path(s) failed to restore`);
  }
}

function assertTreeHasNoSymlinks(absolute, rel) {
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Managed path contains a symbolic link: ${rel}`);
  }
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(absolute)) {
    assertTreeHasNoSymlinks(path.join(absolute, entry), path.join(rel, entry));
  }
}

function removePathWithoutFollowingLinks(absolute) {
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(absolute);
    return;
  }
  fs.rmSync(absolute, { recursive: true, force: true });
}
