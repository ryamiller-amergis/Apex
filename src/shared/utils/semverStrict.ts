/**
 * Strict SemVer helpers (SemVer 2.0 core + optional prerelease/build).
 * Mirrors `semver.valid` / `semver.gt` without adding a package.json dependency.
 */

const STRICT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

type ParsedSemVer = {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
};

function parsePrerelease(raw: string | undefined): Array<string | number> {
  if (!raw) return [];
  return raw.split('.').map((part) => (/^(0|[1-9]\d*)$/.test(part) ? Number(part) : part));
}

function parseStrict(version: string): ParsedSemVer | null {
  const trimmed = version.trim();
  const match = STRICT_SEMVER.exec(trimmed);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: parsePrerelease(match[4]),
  };
}

/** Returns the trimmed version when valid, otherwise null (like semver.valid). */
export function semverValid(version: string | null | undefined): string | null {
  if (version == null) return null;
  const trimmed = String(version).trim();
  return parseStrict(trimmed) ? trimmed : null;
}

function compareIdentifiers(a: string | number, b: string | number): number {
  const aNum = typeof a === 'number';
  const bNum = typeof b === 'number';
  if (aNum && bNum) return (a as number) - (b as number);
  if (aNum) return -1;
  if (bNum) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Compare two valid SemVer strings. Throws if either is invalid. */
export function semverCompare(a: string, b: string): number {
  const pa = parseStrict(a);
  const pb = parseStrict(b);
  if (!pa || !pb) {
    throw new Error(`Invalid SemVer comparison: "${a}" vs "${b}"`);
  }
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;

  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;

  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i++) {
    const ai = pa.prerelease[i];
    const bi = pb.prerelease[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const diff = compareIdentifiers(ai, bi);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** True when both versions are valid and a > b (like semver.gt). */
export function semverGt(a: string, b: string): boolean {
  if (!semverValid(a) || !semverValid(b)) return false;
  return semverCompare(a, b) > 0;
}
