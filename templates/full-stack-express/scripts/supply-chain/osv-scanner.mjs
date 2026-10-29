import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { templateRoot } from './constants.mjs';

export const OSV_SCANNER_VERSION = '2.7.0';

const ASSETS = {
  'linux-x64': {
    name: 'osv-scanner_linux_amd64',
    sha256: '160c6253e2922e9e0a6a9771c5c4c40a4b3c6090b34a3cdd5e80c96cc2e4218b',
  },
  'linux-arm64': {
    name: 'osv-scanner_linux_arm64',
    sha256: '4061ef4c021ed3c47f203b818f337e351336cc5cd67c0274fc36bd1dfc728dd7',
  },
  'darwin-x64': {
    name: 'osv-scanner_darwin_amd64',
    sha256: 'e82c5df7ab0a42dff29a1cd0660711447b56b4c0483ff66ad8634df10fd81a45',
  },
  'darwin-arm64': {
    name: 'osv-scanner_darwin_arm64',
    sha256: 'd4926ef8da134332543be276dff157e4c170f99ad91fc48e89448a8816bdf70b',
  },
  'win32-x64': {
    name: 'osv-scanner_windows_amd64.exe',
    sha256: '9964ed64ec9a387391eb4cc006ad5c531154821aef29b793e02c448de4686438',
  },
  'win32-arm64': {
    name: 'osv-scanner_windows_arm64.exe',
    sha256: '3e630381c1f1fd3c9c4d447e6ff2ef6c737083371722773db8337eead0f97962',
  },
};

export function assetFor(platform, arch) {
  return ASSETS[`${platform}-${arch}`] ?? null;
}

function cachePath(root, asset) {
  return path.join(
    root,
    'node_modules',
    '.cache',
    'osv-scanner',
    OSV_SCANNER_VERSION,
    asset.name
  );
}

async function hashFile(file) {
  const bytes = await readFile(file);
  return createHash('sha256').update(bytes).digest('hex');
}

export async function ensureOsvScanner(options = {}) {
  const root = options.root ?? templateRoot;
  const asset = assetFor(
    options.platform ?? process.platform,
    options.arch ?? process.arch
  );
  if (!asset) {
    throw new Error(
      `vulnerability scan could not run: OSV-Scanner has no binary for ${process.platform}/${process.arch}`
    );
  }
  const target = cachePath(root, asset);
  try {
    if ((await hashFile(target)) === asset.sha256) {
      return target;
    }
  } catch {
    // Download when the cache is empty or unreadable.
  }
  const url = `https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}/${asset.name}`;
  let response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error(
      'vulnerability scan could not run: the advisory source is unreachable'
    );
  }
  if (!response.ok) {
    throw new Error(
      'vulnerability scan could not run: the advisory source is unreachable'
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== asset.sha256) {
    throw new Error(
      'vulnerability scan could not run: OSV-Scanner checksum did not match'
    );
  }
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.download`;
  await writeFile(temp, bytes);
  if (process.platform !== 'win32') {
    await chmod(temp, 0o755);
  }
  await rename(temp, target);
  return target;
}
