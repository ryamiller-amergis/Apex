import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const UUID_NAMESPACE = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** UUIDv5 (SHA-1), namespace is the DNS UUID. */
export function uuidV5(name) {
  const digest = createHash('sha1')
    .update(UUID_NAMESPACE)
    .update(name, 'utf8')
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function npmPurl(name, version) {
  let purlName = name;
  if (name.startsWith('@')) {
    const slash = name.indexOf('/');
    const scope = name.slice(1, slash);
    const pkg = name.slice(slash + 1);
    purlName = `%40${scope}/${pkg}`;
  }
  return `pkg:npm/${purlName}@${version}`;
}

function versionOf(dep) {
  if (typeof dep.version === 'string' && !dep.version.startsWith('link:')) {
    return dep.version;
  }
  if (typeof dep.path === 'string') {
    try {
      const manifest = JSON.parse(
        readFileSync(path.join(dep.path, 'package.json'), 'utf8')
      );
      if (typeof manifest.version === 'string') {
        return manifest.version;
      }
    } catch {
      return null;
    }
  }
  return null;
}

export function flattenPnpmTree(trees) {
  const byPurl = new Map();
  const visit = (node) => {
    for (const [name, dep] of Object.entries(node?.dependencies ?? {})) {
      const version = versionOf(dep);
      if (version) {
        const purl = npmPurl(name, version);
        if (!byPurl.has(purl)) {
          byPurl.set(purl, { name, version, purl });
        }
      }
      visit(dep);
    }
  };
  for (const tree of trees ?? []) {
    visit(tree);
  }
  return [...byPurl.values()].sort((left, right) =>
    left.purl.localeCompare(right.purl)
  );
}

export function buildSbomDocument(options) {
  const components = [...options.components].sort((left, right) =>
    left.purl.localeCompare(right.purl)
  );
  const document = {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${uuidV5(options.lockfileHash)}`,
    version: 1,
    metadata: {
      component: {
        type: 'application',
        name: options.serviceName,
        'bom-ref': options.serviceName,
      },
    },
    components: components.map((component) => ({
      type: 'library',
      name: component.name,
      version: component.version,
      purl: component.purl,
      'bom-ref': component.purl,
    })),
  };
  if (options.sourceDateEpoch != null && options.sourceDateEpoch !== '') {
    const seconds = Number(options.sourceDateEpoch);
    if (Number.isFinite(seconds)) {
      document.metadata.timestamp = new Date(seconds * 1000).toISOString();
    }
  }
  return document;
}

export function serializeSbom(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}
