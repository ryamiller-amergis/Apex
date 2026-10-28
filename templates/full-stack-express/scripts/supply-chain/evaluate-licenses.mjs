import { EXIT_CLEAN, EXIT_FINDINGS } from './constants.mjs';

function licenseIds(expression) {
  return expression.match(/[A-Za-z0-9.+-]+/g) ?? [];
}

/**
 * An exact SPDX id must be on the list. An OR expression passes when one
 * side is allowed. An AND expression passes when every id is allowed.
 */
export function licenseAllowed(expression, allowed) {
  const value = expression.trim();
  if (allowed.has(value)) {
    return true;
  }
  const orParts = value
    .replace(/^\(/, '')
    .replace(/\)$/, '')
    .split(/\s+OR\s+/);
  if (orParts.length > 1) {
    return orParts.some((part) => licenseAllowed(part, allowed));
  }
  const andParts = value.split(/\s+AND\s+/);
  if (andParts.length > 1) {
    return andParts.every((part) => licenseAllowed(part, allowed));
  }
  const ids = licenseIds(value);
  return ids.length === 1 && allowed.has(ids[0]);
}

export function evaluateLicenses(packages, allowedList) {
  const allowed = new Set(allowedList);
  const lines = [];
  const sorted = [...packages].sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  for (const entry of sorted) {
    const license = entry.license ?? 'UNKNOWN';
    if (!licenseAllowed(license, allowed)) {
      lines.push(`package ${entry.name} license ${license}`);
    }
  }
  return {
    exitCode: lines.length === 0 ? EXIT_CLEAN : EXIT_FINDINGS,
    lines,
  };
}

export function packagesFromLicenseReport(report) {
  const packages = [];
  for (const [group, entries] of Object.entries(report ?? {})) {
    for (const entry of entries ?? []) {
      const license = entry.license || group;
      const versions =
        entry.versions && entry.versions.length > 0 ? entry.versions : [''];
      for (const version of versions) {
        packages.push({
          name: entry.name,
          version,
          license,
        });
      }
    }
  }
  return packages;
}
