/**
 * Minimal semver parsing and range satisfaction — enough for contract checks
 * without pulling in a dependency. Supports: exact, x-ranges, caret (^),
 * tilde (~), comparators (>=, >, <=, <, =), and hyphen ranges "a - b".
 */

export function parse(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(version).trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  };
}

export function isValid(version) {
  return parse(version) !== null;
}

/** Returns -1, 0, or 1. Prerelease sorts lower than its release. */
export function compare(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) throw new Error(`Invalid version in compare: ${a} / ${b}`);
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  if (pa.prerelease && !pb.prerelease) return -1;
  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && pb.prerelease) {
    return pa.prerelease < pb.prerelease ? -1 : pa.prerelease > pb.prerelease ? 1 : 0;
  }
  return 0;
}

function satisfiesComparator(version, comparator) {
  const c = comparator.trim();
  if (c === '' || c === '*') return true;

  const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(c);
  if (caret) {
    const [, maj, min, pat] = caret.map(Number);
    const lower = `${maj}.${min}.${pat}`;
    const upper = maj > 0 ? `${maj + 1}.0.0` : min > 0 ? `0.${min + 1}.0` : `0.0.${pat + 1}`;
    return compare(version, lower) >= 0 && compare(version, upper) < 0;
  }

  const tilde = /^~(\d+)\.(\d+)\.(\d+)$/.exec(c);
  if (tilde) {
    const [, maj, min, pat] = tilde.map(Number);
    const lower = `${maj}.${min}.${pat}`;
    const upper = `${maj}.${min + 1}.0`;
    return compare(version, lower) >= 0 && compare(version, upper) < 0;
  }

  const op = /^(>=|<=|>|<|=)?\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(c);
  if (op) {
    const operator = op[1] || '=';
    const cmp = compare(version, op[2]);
    switch (operator) {
      case '>=': return cmp >= 0;
      case '>': return cmp > 0;
      case '<=': return cmp <= 0;
      case '<': return cmp < 0;
      case '=': return cmp === 0;
    }
  }

  const xrange = /^(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(c);
  if (xrange) {
    const maj = Number(xrange[1]);
    const minRaw = xrange[2];
    const v = parse(version);
    if (!v) return false;
    if (v.major !== maj) return false;
    if (minRaw === undefined || minRaw === 'x' || minRaw === '*') return true;
    return v.minor === Number(minRaw);
  }

  return false;
}

/** Range may contain " - " hyphen ranges or space-separated comparators (AND). */
export function satisfies(version, range) {
  if (!isValid(version)) return false;
  const trimmed = String(range).trim();
  if (trimmed === '' || trimmed === '*') return true;

  const hyphen = /^(\d+\.\d+\.\d+)\s+-\s+(\d+\.\d+\.\d+)$/.exec(trimmed);
  if (hyphen) {
    return compare(version, hyphen[1]) >= 0 && compare(version, hyphen[2]) <= 0;
  }

  // Space-separated comparators are ANDed together.
  return trimmed.split(/\s+/).every((c) => satisfiesComparator(version, c));
}
