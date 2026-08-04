import fs from 'fs';
import path from 'path';
import type { ChangelogEntry } from '../../shared/types/changelog';
import { semverCompare, semverValid } from '../../shared/utils/semverStrict';
import { getAppSetting } from './appSettingsService';

export class ChangelogContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChangelogContentError';
  }
}

function resolveChangelogPath(): string {
  // Compiled to dist/server/services — client build lives at dist/client (see index.ts).
  const fromDist = path.resolve(__dirname, '../../client/CHANGELOG.json');
  if (fs.existsSync(fromDist)) return fromDist;
  return path.resolve(process.cwd(), 'public/CHANGELOG.json');
}

let cachedEntries: ChangelogEntry[] | null = null;
let cachedMtime = 0;
let cachedInvalid = false;

/** @internal — reset in-memory cache (tests only) */
export function resetChangelogCache(): void {
  cachedEntries = null;
  cachedMtime = 0;
  cachedInvalid = false;
}

function assertValidEntries(entries: ChangelogEntry[]): void {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new ChangelogContentError('Changelog is empty or unreadable');
  }
  for (const entry of entries) {
    if (!entry || typeof entry.version !== 'string' || !semverValid(entry.version)) {
      throw new ChangelogContentError(`Malformed changelog SemVer: ${String(entry?.version)}`);
    }
  }
}

/**
 * Reads bundled changelog entries. Returns [] on I/O/parse failure (legacy callers).
 * Prefer `readValidChangelogEntries` when fail-closed behavior is required.
 */
export function readChangelogEntries(): ChangelogEntry[] {
  try {
    return readValidChangelogEntries();
  } catch {
    return [];
  }
}

/** Reads and validates bundled changelog; throws ChangelogContentError on failure. */
export function readValidChangelogEntries(): ChangelogEntry[] {
  const filePath = resolveChangelogPath();
  try {
    const stat = fs.statSync(filePath);
    if (cachedEntries && !cachedInvalid && stat.mtimeMs === cachedMtime) {
      return cachedEntries;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as ChangelogEntry[];
    assertValidEntries(parsed);
    cachedEntries = parsed;
    cachedMtime = stat.mtimeMs;
    cachedInvalid = false;
    return cachedEntries;
  } catch (err) {
    cachedEntries = null;
    cachedInvalid = true;
    if (err instanceof ChangelogContentError) throw err;
    throw new ChangelogContentError('Changelog is empty or unreadable');
  }
}

/**
 * @deprecated Prefer strict SemVer helpers in `semverStrict` / `whatsNewStateService`.
 * Retained for transitional callers; coerces invalid segments (legacy behavior).
 */
export function compareVersions(a: string, b: string): number {
  const va = semverValid(a);
  const vb = semverValid(b);
  if (va && vb) return semverCompare(va, vb);
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
 * Resolves the live UI release version.
 * Bundled CHANGELOG.json is authoritative. DB `current_changelog_version` is used
 * only when it is valid SemVer AND represented by a loadable changelog entry.
 */
export async function getCurrentChangelogVersion(): Promise<string> {
  const resolved = await resolveCurrentChangelogVersion();
  return resolved ?? '0.0.0';
}

export async function resolveCurrentChangelogVersion(): Promise<string | null> {
  let entries: ChangelogEntry[];
  try {
    entries = readValidChangelogEntries();
  } catch {
    return null;
  }

  const fromFile = semverValid(entries[0]?.version ?? null);
  if (!fromFile) return null;

  const fromDbRaw = await getAppSetting('current_changelog_version');
  const fromDb = semverValid(fromDbRaw);
  if (fromDb && entries.some((e) => e.version === fromDb)) {
    return semverCompare(fromFile, fromDb) >= 0 ? fromFile : fromDb;
  }
  return fromFile;
}

export async function getChangelogPayload(): Promise<{
  currentVersion: string;
  entries: ChangelogEntry[];
}> {
  const entries = readValidChangelogEntries();
  const currentVersion = await resolveCurrentChangelogVersion();
  if (!currentVersion) {
    throw new ChangelogContentError('No valid current changelog version');
  }
  return { currentVersion, entries };
}
