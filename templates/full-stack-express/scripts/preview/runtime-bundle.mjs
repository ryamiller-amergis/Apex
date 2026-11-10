import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  loadPreviewManifestDocument,
  PREVIEW_MANIFEST_FILE,
  PREVIEW_SCHEMA_VERSION,
} from './preview-manifest.mjs';

const TAR_BLOCK_SIZE = 512;
const TAR_END_SIZE = TAR_BLOCK_SIZE * 2;
const TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.map',
  '.mjs',
  '.sql',
  '.svg',
  '.txt',
]);

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizedRelativePath(value) {
  return value.split(path.sep).join('/');
}

function normalizeEntryBytes(entryPath, bytes) {
  if (!TEXT_EXTENSIONS.has(path.posix.extname(entryPath).toLowerCase())) {
    return bytes;
  }
  return Buffer.from(bytes.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8');
}

function assertCanonicalArchivePath(entryPath) {
  const hasControlCharacter = [...entryPath].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (
    !entryPath ||
    entryPath !== entryPath.normalize('NFC') ||
    entryPath.includes('\\') ||
    entryPath.includes(':') ||
    hasControlCharacter ||
    path.posix.isAbsolute(entryPath) ||
    path.posix.normalize(entryPath) !== entryPath ||
    entryPath === '.' ||
    entryPath.startsWith('../')
  ) {
    throw new Error(`Unsafe runtime bundle path: ${entryPath}`);
  }
  for (const segment of entryPath.split('/')) {
    const deviceName = segment.split('.')[0].toUpperCase();
    if (
      /[. ]$/.test(segment) ||
      /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(deviceName)
    ) {
      throw new Error(`Windows-incompatible runtime bundle path: ${entryPath}`);
    }
  }
}

function splitTarPath(entryPath) {
  if (Buffer.byteLength(entryPath) <= 100) {
    return { name: entryPath, prefix: '' };
  }
  const separators = [...entryPath.matchAll(/\//g)].map((match) => match.index);
  for (let index = separators.length - 1; index >= 0; index -= 1) {
    const split = separators[index];
    const prefix = entryPath.slice(0, split);
    const name = entryPath.slice(split + 1);
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) {
      return { name, prefix };
    }
  }
  throw new Error(`Runtime bundle path exceeds the tar limit: ${entryPath}`);
}

function writeString(header, offset, length, value) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) {
    throw new Error(`Tar header value is too long: ${value}`);
  }
  bytes.copy(header, offset);
}

function writeOctal(header, offset, length, value) {
  const encoded = Math.trunc(value)
    .toString(8)
    .padStart(length - 1, '0');
  writeString(header, offset, length, `${encoded}\0`);
}

function tarHeader(entryPath, size) {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  const { name, prefix } = splitTarPath(entryPath);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, '0');
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  writeString(header, 265, 32, 'root');
  writeString(header, 297, 32, 'root');
  if (prefix) writeString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const encodedChecksum = checksum.toString(8).padStart(6, '0');
  writeString(header, 148, 8, `${encodedChecksum}\0 `);
  return header;
}

function createTar(entries) {
  const chunks = [];
  for (const entry of entries) {
    chunks.push(tarHeader(entry.path, entry.bytes.length), entry.bytes);
    const remainder = entry.bytes.length % TAR_BLOCK_SIZE;
    if (remainder > 0) {
      chunks.push(Buffer.alloc(TAR_BLOCK_SIZE - remainder));
    }
  }
  chunks.push(Buffer.alloc(TAR_END_SIZE));
  return Buffer.concat(chunks);
}

async function collectSource(sourcePath, targetPath) {
  const info = await lstat(sourcePath);
  if (info.isSymbolicLink()) {
    throw new Error(
      `Runtime bundle sources may not contain symlinks: ${sourcePath}`
    );
  }
  if (info.isFile()) {
    return [
      {
        path: targetPath,
        bytes: normalizeEntryBytes(targetPath, await readFile(sourcePath)),
      },
    ];
  }
  if (!info.isDirectory()) {
    throw new Error(`Unsupported runtime bundle source: ${sourcePath}`);
  }

  const entries = [];
  const children = await readdir(sourcePath, { withFileTypes: true });
  children.sort((left, right) => compareCodePoints(left.name, right.name));
  for (const child of children) {
    const childSource = path.join(sourcePath, child.name);
    const childTarget = path.posix.join(targetPath, child.name);
    entries.push(...(await collectSource(childSource, childTarget)));
  }
  return entries;
}

function assertSafeEntries(entries) {
  const seen = new Set();
  const folded = new Map();
  for (const entry of entries) {
    assertCanonicalArchivePath(entry.path);
    if (seen.has(entry.path)) {
      throw new Error(`Duplicate runtime bundle path: ${entry.path}`);
    }
    seen.add(entry.path);
    const foldedPath = entry.path.normalize('NFC').toLocaleLowerCase('en-US');
    const existing = folded.get(foldedPath);
    if (existing && existing !== entry.path) {
      throw new Error(
        `Case-insensitive runtime bundle path collision: ${existing} and ${entry.path}`
      );
    }
    folded.set(foldedPath, entry.path);
  }
  for (const entryPath of seen) {
    const segments = entryPath.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const prefix = segments.slice(0, index).join('/');
      if (seen.has(prefix)) {
        throw new Error(
          `Runtime bundle file/directory path collision: ${prefix} and ${entryPath}`
        );
      }
    }
  }
}

async function assertNoSymlinkPathComponents(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Runtime bundle path escapes the repository: ${candidate}`);
  }
  let current = root;
  const segments = relative ? relative.split(path.sep) : [];
  for (const segment of ['', ...segments]) {
    if (segment) current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new Error(`Runtime bundle path contains a symlink: ${current}`);
      }
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return;
      }
      throw error;
    }
  }
}

export async function buildRuntimeBundle(options) {
  const root = path.resolve(options.root);
  await assertNoSymlinkPathComponents(
    root,
    path.join(root, PREVIEW_MANIFEST_FILE)
  );
  const { bytes: manifestBytes, manifest } =
    await loadPreviewManifestDocument(root);
  const outputPath = path.resolve(
    options.outputPath ?? path.join(root, manifest.bundle.output)
  );
  await assertNoSymlinkPathComponents(root, outputPath);
  const archivedManifestBytes = normalizeEntryBytes(
    PREVIEW_MANIFEST_FILE,
    manifestBytes
  );
  const entries = [
    {
      path: PREVIEW_MANIFEST_FILE,
      bytes: archivedManifestBytes,
    },
  ];

  for (const include of manifest.bundle.includes) {
    const source = path.resolve(root, include.source);
    const relativeSource = path.relative(root, source);
    if (relativeSource.startsWith('..') || path.isAbsolute(relativeSource)) {
      throw new Error(
        `Runtime bundle source escapes the repository: ${include.source}`
      );
    }
    await assertNoSymlinkPathComponents(root, source);
    try {
      entries.push(...(await collectSource(source, include.target)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not collect ${include.source}: ${message}`);
    }
  }
  assertSafeEntries(entries);

  const entryPaths = new Set(entries.map((entry) => entry.path));
  for (const required of manifest.bundle.requiredFiles) {
    if (!entryPaths.has(required)) {
      throw new Error(`Required runtime bundle file is missing: ${required}`);
    }
  }

  entries.sort((left, right) => compareCodePoints(left.path, right.path));
  const runtimeDescriptor = {
    schemaVersion: PREVIEW_SCHEMA_VERSION,
    template: manifest.template,
    runner: manifest.runner,
    manifestDigest: `sha256:${sha256(archivedManifestBytes)}`,
    sbomRef: manifest.bundle.sbomRef,
    entries: entries.map((entry) => ({
      path: entry.path,
      digest: `sha256:${sha256(entry.bytes)}`,
      sizeBytes: entry.bytes.length,
    })),
  };
  entries.push({
    path: 'apex.runtime.json',
    bytes: Buffer.from(`${JSON.stringify(runtimeDescriptor, null, 2)}\n`),
  });
  assertSafeEntries(entries);
  entries.sort((left, right) => compareCodePoints(left.path, right.path));

  const bundle = createTar(entries);
  const digest = `sha256:${sha256(bundle)}`;
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, bundle, { flag: 'wx' });
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  const checksumPath = `${outputPath}.sha256`;
  await assertNoSymlinkPathComponents(root, checksumPath);
  const temporaryChecksumPath = `${checksumPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(
      temporaryChecksumPath,
      `${digest}  ${path.basename(outputPath)}\n`,
      { flag: 'wx' }
    );
    await rename(temporaryChecksumPath, checksumPath);
  } finally {
    await rm(temporaryChecksumPath, { force: true });
  }

  return {
    outputPath,
    digest,
    sizeBytes: bundle.length,
    entries: entries.map((entry) => entry.path),
  };
}

function readNullTerminated(bytes) {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString('utf8');
}

function readTarOctal(bytes, fieldName) {
  const value = readNullTerminated(bytes).trim();
  if (!/^[0-7]+$/.test(value)) {
    throw new Error(`Invalid tar ${fieldName}: ${JSON.stringify(value)}`);
  }
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Tar ${fieldName} exceeds the safe integer range`);
  }
  return parsed;
}

export function listRuntimeBundleEntries(bundle) {
  if (bundle.length < TAR_END_SIZE || bundle.length % TAR_BLOCK_SIZE !== 0) {
    throw new Error('Invalid tar length');
  }
  const entries = [];
  let offset = 0;
  while (offset + TAR_BLOCK_SIZE <= bundle.length) {
    const header = bundle.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) {
      const end = bundle.subarray(offset, offset + TAR_END_SIZE);
      if (
        end.length !== TAR_END_SIZE ||
        !end.every((byte) => byte === 0) ||
        !bundle.subarray(offset + TAR_END_SIZE).every((byte) => byte === 0)
      ) {
        throw new Error('Tar archive does not end with two zero blocks');
      }
      return entries;
    }
    if (
      !header.subarray(257, 263).equals(Buffer.from('ustar\0')) ||
      !header.subarray(263, 265).equals(Buffer.from('00'))
    ) {
      throw new Error('Unsupported tar format');
    }
    const typeFlag = header[156];
    if (typeFlag !== 0 && typeFlag !== 0x30) {
      throw new Error(`Unsupported tar entry type: ${typeFlag}`);
    }
    const expectedChecksum = readTarOctal(
      header.subarray(148, 156),
      'checksum'
    );
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (expectedChecksum !== actualChecksum) {
      throw new Error('Invalid tar header checksum');
    }
    const name = readNullTerminated(header.subarray(0, 100));
    const prefix = readNullTerminated(header.subarray(345, 500));
    const entryPath = prefix ? `${prefix}/${name}` : name;
    assertCanonicalArchivePath(entryPath);
    const size = readTarOctal(header.subarray(124, 136), 'size');
    const nextOffset =
      offset +
      TAR_BLOCK_SIZE +
      Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    if (nextOffset > bundle.length - TAR_END_SIZE) {
      throw new Error(`Tar entry exceeds archive bounds: ${entryPath}`);
    }
    entries.push(entryPath);
    offset = nextOffset;
  }
  throw new Error('Tar archive is missing end blocks');
}

export { normalizedRelativePath };
