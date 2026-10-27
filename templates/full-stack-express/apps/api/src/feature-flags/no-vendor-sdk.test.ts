import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const templateRoot = fileURLToPath(new URL('../../../../', import.meta.url));

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

// OpenFeature is an open specification a future adapter may wrap, so it is not listed.
const VENDOR_FLAG_SDKS = [
  /^(@launchdarkly\/|launchdarkly-|ldclient-)/,
  /^(@unleash\/|unleash-client|unleash-proxy-client)/,
  /^(@flagsmith\/|flagsmith)/,
  /^@growthbook\//,
  /^@splitsoftware\//,
  /^(@configcat\/|configcat-)/,
  /^(@statsig\/|statsig-)/,
  /^(@posthog\/|posthog-)/,
];

type Manifest = { name?: string } & Partial<
  Record<(typeof DEPENDENCY_FIELDS)[number], Record<string, string>>
>;

function workspaceManifests(): Manifest[] {
  const files = [path.join(templateRoot, 'package.json')];
  for (const group of ['apps', 'packages']) {
    for (const entry of readdirSync(path.join(templateRoot, group), {
      withFileTypes: true,
    })) {
      if (entry.isDirectory()) {
        files.push(path.join(templateRoot, group, entry.name, 'package.json'));
      }
    }
  }
  return files.map(
    (file) => JSON.parse(readFileSync(file, 'utf8')) as Manifest
  );
}

function findVendorSdks(manifests: Manifest[]): string[] {
  const found: string[] = [];
  for (const manifest of manifests) {
    for (const field of DEPENDENCY_FIELDS) {
      for (const dependency of Object.keys(manifest[field] ?? {})) {
        if (VENDOR_FLAG_SDKS.some((pattern) => pattern.test(dependency))) {
          found.push(`${manifest.name ?? 'unnamed'}: ${dependency}`);
        }
      }
    }
  }
  return found;
}

describe('vendor flag SDK guard', () => {
  it('VT-10 TBI-019 DoD-2 BR-011 finds no vendor flag SDK in any workspace manifest', () => {
    const manifests = workspaceManifests();
    expect(manifests.length).toBeGreaterThanOrEqual(6);
    expect(findVendorSdks(manifests)).toEqual([]);
  });

  it('VT-10 names the package and dependency when a listed SDK is added', () => {
    const found = findVendorSdks([
      {
        name: '@project-scope/api',
        dependencies: { '@launchdarkly/node-server-sdk': '9.0.0' },
        devDependencies: { 'unleash-client': '6.0.0' },
      },
      {
        name: '@project-scope/web',
        dependencies: { '@openfeature/server-sdk': '1.0.0', zod: '4.0.0' },
      },
    ]);
    expect(found).toEqual([
      '@project-scope/api: @launchdarkly/node-server-sdk',
      '@project-scope/api: unleash-client',
    ]);
  });
});
