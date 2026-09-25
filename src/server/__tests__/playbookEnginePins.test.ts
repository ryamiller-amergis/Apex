/**
 * TBI-007 — the engine is only contained if its version cannot move without a human deciding.
 *
 * The checks run against the real manifest and lockfile, but the rules they apply are exercised
 * against synthetic input too. A test that only reads today's correct files would still pass if the
 * rule itself were wrong, which would leave the pin unguarded exactly when it matters.
 */
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');

/**
 * Scopes belonging to an orchestration engine. VoltAgent is listed alongside Mastra because the ADR
 * names it as the fallback: if a trigger fires and the engine is swapped, the pin rule must already
 * cover its replacement rather than silently stop applying.
 */
const ENGINE_SCOPES = ['@mastra/', '@voltagent/'];

const isEnginePackage = (name: string): boolean => ENGINE_SCOPES.some((scope) => name.startsWith(scope));

/** An exact version: digits and dots only, with an optional prerelease or build tag. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Every engine package in a manifest, wherever it is declared. */
function enginePackagesOf(manifest: Manifest): Array<[string, string]> {
  return Object.entries({ ...manifest.dependencies, ...manifest.devDependencies }).filter(([name]) =>
    isEnginePackage(name)
  );
}

/** Engine packages whose specifier is anything other than one exact version. */
function unpinnedIn(manifest: Manifest): string[] {
  return enginePackagesOf(manifest)
    .filter(([, specifier]) => !EXACT_VERSION.test(specifier))
    .map(([name, specifier]) => `${name}@${specifier}`);
}

const readJson = <T>(relativePath: string): T =>
  JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')) as T;

describe('TBI-007 — engine packages are pinned at exact versions', () => {
  // DoD-0, VT-01
  it('pins every engine package with no caret, tilde or range', () => {
    const manifest = readJson<Manifest>('package.json');
    const found = enginePackagesOf(manifest);

    expect(found.length).toBeGreaterThan(0); // a passing check over zero packages proves nothing
    expect(unpinnedIn(manifest)).toEqual([]);
  });

  // DoD-0, VT-01 — the rule itself, not just today's manifest
  it('names the offending package when a range creeps in', () => {
    expect(unpinnedIn({ dependencies: { '@mastra/core': '^1.67.0' } })).toEqual(['@mastra/core@^1.67.0']);
    expect(unpinnedIn({ devDependencies: { '@mastra/pg': '~1.25.0' } })).toEqual(['@mastra/pg@~1.25.0']);
    expect(unpinnedIn({ dependencies: { '@voltagent/core': '>=2.0.0' } })).toEqual(['@voltagent/core@>=2.0.0']);
    expect(unpinnedIn({ dependencies: { '@mastra/core': '1.67.0' } })).toEqual([]);

    // Packages Apex pins loosely on purpose are not this rule's business.
    expect(unpinnedIn({ dependencies: { eslint: '^9.39.2' } })).toEqual([]);
  });

  // DoD-0, VT-02
  it('resolves every engine package to an exact version in the lockfile', () => {
    const lock = readJson<{ packages?: Record<string, { version?: string }> }>('package-lock.json');
    const entries = Object.entries(lock.packages ?? {}).filter(([entryPath]) =>
      // Lockfile keys are paths: node_modules/@mastra/core, and nested copies below other packages.
      ENGINE_SCOPES.some((scope) => entryPath.includes(`node_modules/${scope}`))
    );

    expect(entries.length).toBeGreaterThan(0);
    const floating = entries
      .filter(([, entry]) => !entry.version || !EXACT_VERSION.test(entry.version))
      .map(([entryPath, entry]) => `${entryPath}@${entry.version ?? 'missing'}`);
    expect(floating).toEqual([]);
  });

  /*
   * DoD-1 — "automated dependency-update tooling configured to skip these packages".
   *
   * Apex runs no such tooling, so there is no exclusion list to add the engine to. Rather than
   * record that as done and let it rot, this asserts the condition the DoD is really protecting:
   * an automated bump must not be able to move the pin. That holds while no tool is configured, and
   * the moment someone adds one this test starts demanding the exclusion.
   */
  it('has no automated dependency-update tool that could bump the engine', () => {
    const configs = [
      '.github/dependabot.yml',
      '.github/dependabot.yaml',
      '.github/renovate.json',
      'renovate.json',
      '.renovaterc',
      '.renovaterc.json',
    ].filter((relativePath) => fs.existsSync(path.join(REPO_ROOT, relativePath)));

    const withoutExclusion = configs.filter((relativePath) => {
      const contents = fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
      return !ENGINE_SCOPES.every((scope) => contents.includes(scope));
    });
    expect(withoutExclusion).toEqual([]);

    // Recorded so the absence is a finding rather than an oversight.
    expect(configs).toEqual([]);
  });

  // DoD-2 — the pin moves only through the permission path that already governs this file
  it('keeps package.json under the scope-discipline permission path', () => {
    const rule = fs.readFileSync(path.join(REPO_ROOT, '.cursor/rules/scope-discipline.mdc'), 'utf8');
    expect(rule).toContain('package.json');
  });
});

/*
 * The ADR requires that moving the pin be accompanied by a fresh review of paid-feature
 * entitlements, automatic DDL, telemetry suppression, the engine contract tests and pool size.
 *
 * The conformance suite re-measures four of those against the live engine on every run. The
 * entitlement diff is the one that cannot be: the `licensed-keys` list was read by a person out of
 * the engine's LICENSE.md and its ee/ directories, and nothing re-derives it from a newly installed
 * version. A version could therefore move a module Apex depends on behind the commercial licence
 * and every existing test would still pass, against a list describing the previous release.
 *
 * So this asserts the narrow fact that makes the rest trustworthy: the version the findings were
 * measured against is still the version installed.
 */
describe('TBI-007 — findings still describe the installed version', () => {
  const RECORD = 'design-docs/playbook-engine-verification.md';

  /** The `package@version` pairs named in the verification record's header. */
  function versionsUnderVerification(): Record<string, string> {
    const record = fs.readFileSync(path.join(REPO_ROOT, RECORD), 'utf8');
    const header = record
      .split(/\r?\n/)
      .find((line) => line.includes('**Engine under verification:**'));

    if (!header) {
      throw new Error(
        `No "Engine under verification" line in ${RECORD}. That line names the versions every ` +
          'finding in the record was measured against; without it nothing can be re-checked.'
      );
    }

    const pairs: Record<string, string> = {};
    for (const [, name, version] of header.matchAll(/`(@[^`@]+)@([^`]+)`/g)) {
      pairs[name] = version;
    }
    return pairs;
  }

  /** Engine packages whose installed version is not the one the findings were measured against. */
  function drift(installed: Record<string, string>, verified: Record<string, string>): string[] {
    return Object.entries(installed)
      .filter(([name, version]) => verified[name] !== version)
      .map(([name, version]) => `${name}: installed ${version}, verified ${verified[name] ?? 'not recorded'}`);
  }

  const installedEngineVersions = (): Record<string, string> =>
    Object.fromEntries(enginePackagesOf(readJson<Manifest>('package.json')));

  it('records a version for every pinned engine package', () => {
    expect(Object.keys(versionsUnderVerification()).sort()).toEqual(
      Object.keys(installedEngineVersions()).sort()
    );
  });

  it('agrees with the installed versions today', () => {
    expect(drift(installedEngineVersions(), versionsUnderVerification())).toEqual([]);
  });

  // The check itself: a bump must be caught, or the two tests above are decoration
  it('catches a pin that has moved away from the verified version', () => {
    expect(drift({ '@mastra/core': '1.68.0' }, { '@mastra/core': '1.67.0' })).toEqual([
      '@mastra/core: installed 1.68.0, verified 1.67.0',
    ]);
    expect(drift({ '@mastra/pg': '1.25.0' }, {})).toEqual([
      '@mastra/pg: installed 1.25.0, verified not recorded',
    ]);
    expect(drift({ '@mastra/core': '1.67.0' }, { '@mastra/core': '1.67.0' })).toEqual([]);
  });
});
