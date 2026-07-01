import fs from 'fs';
import path from 'path';
import type { ChangelogEntry } from '../../shared/types/changelog';
import { getAppSetting } from './appSettingsService';

function resolveChangelogPath(): string {
  const fromDist = path.resolve(__dirname, '../client/CHANGELOG.json');
  if (fs.existsSync(fromDist)) return fromDist;
  return path.resolve(process.cwd(), 'public/CHANGELOG.json');
}

let cachedEntries: ChangelogEntry[] | null = null;
let cachedMtime = 0;

/** @internal — reset in-memory cache (tests only) */
export function resetChangelogCache(): void {
  cachedEntries = null;
  cachedMtime = 0;
}

export function readChangelogEntries(): ChangelogEntry[] {
  const filePath = resolveChangelogPath();
  try {
    const stat = fs.statSync(filePath);
    if (cachedEntries && stat.mtimeMs === cachedMtime) return cachedEntries;
    const raw = fs.readFileSync(filePath, 'utf8');
    cachedEntries = JSON.parse(raw) as ChangelogEntry[];
    cachedMtime = stat.mtimeMs;
    return cachedEntries;
  } catch {
    return [];
  }
}

/** Semver-ish compare: returns positive when `a` is newer than `b`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Resolves the live release version. Uses the deployed CHANGELOG.json as the
 * primary source of truth and takes the newer of file vs DB so unread state
 * stays correct even when a version-sync migration has not run yet.
 */
export async function getCurrentChangelogVersion(): Promise<string> {
  const fromFile = readChangelogEntries()[0]?.version ?? null;
  const fromDb = await getAppSetting('current_changelog_version');
  if (fromFile && fromDb) {
    return compareVersions(fromFile, fromDb) >= 0 ? fromFile : fromDb;
  }
  return fromFile ?? fromDb ?? '0.0.0';
}

export async function getChangelogPayload(): Promise<{
  currentVersion: string;
  entries: ChangelogEntry[];
}> {
  const entries = readChangelogEntries();
  const currentVersion = await getCurrentChangelogVersion();
  return { currentVersion, entries };
}
