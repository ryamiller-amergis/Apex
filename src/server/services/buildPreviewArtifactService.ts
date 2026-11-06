/**
 * Stores static build preview bundles on the persistent data root and serves them
 * through token-gated URLs (no Apex session cookie in the iframe).
 */
import { randomBytes } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { createReadStream } from 'fs';
import { resolveDataRoot } from '../utils/dataDir';

const execFileAsync = promisify(execFile);

export const PREVIEW_BUNDLE_MAX_BYTES = 80 * 1024 * 1024;

export interface PreviewManifest {
  buildRunId: string;
  revisionNumber: number;
  commit: string;
  token: string;
  createdAt: string;
}

function previewsRoot(): string {
  return path.join(resolveDataRoot(), 'build-previews');
}

function revisionDir(buildRunId: string, revisionNumber: number): string {
  return path.join(previewsRoot(), buildRunId, String(revisionNumber));
}

function normalizeRelativePath(relative: string): string | null {
  if (relative.includes('..')) {
    return null;
  }
  const normalized = path.normalize(relative).replace(/^(\.\.(\/|\\|$))+/, '');
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    return null;
  }
  return normalized.split(path.sep).join('/');
}

export function apexPublicBaseUrl(): string {
  const raw =
    process.env.APEX_PUBLIC_URL?.trim()
    || process.env.PUBLIC_APP_URL?.trim()
    || process.env.VITE_API_URL?.trim()
    || 'http://localhost:3001';
  return raw.replace(/\/$/, '');
}

export function buildPreviewPublicUrl(buildRunId: string, token: string): string {
  return `${apexPublicBaseUrl()}/api/builds/${encodeURIComponent(buildRunId)}/preview/${encodeURIComponent(token)}/`;
}

export async function readPreviewManifest(
  buildRunId: string,
  revisionNumber: number,
): Promise<PreviewManifest | null> {
  try {
    const raw = await fs.readFile(
      path.join(revisionDir(buildRunId, revisionNumber), 'manifest.json'),
      'utf8',
    );
    return JSON.parse(raw) as PreviewManifest;
  } catch {
    return null;
  }
}

export async function verifyPreviewToken(
  buildRunId: string,
  token: string,
): Promise<PreviewManifest | null> {
  const root = path.join(previewsRoot(), buildRunId);
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const rev = Number(entry);
    if (!Number.isFinite(rev)) continue;
    const manifest = await readPreviewManifest(buildRunId, rev);
    if (manifest?.token === token) {
      return manifest;
    }
  }
  return null;
}

async function extractTarGzArchive(archive: Buffer, destDir: string): Promise<void> {
  if (archive.length > PREVIEW_BUNDLE_MAX_BYTES) {
    throw new Error('Preview archive exceeds size limit.');
  }
  await fs.mkdir(destDir, { recursive: true });
  const tmpRoot = await fs.mkdtemp(path.join(resolveDataRoot(), 'preview-extract-'));
  const archivePath = path.join(tmpRoot, 'bundle.tar.gz');
  try {
    await fs.writeFile(archivePath, archive);
    await execFileAsync('tar', ['-xzf', archivePath, '-C', destDir], {
      windowsHide: true,
    });
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

export async function storePreviewArchive(input: {
  buildRunId: string;
  revisionNumber: number;
  commit: string;
  archive: Buffer;
}): Promise<{ token: string; previewUrl: string }> {
  const token = randomBytes(24).toString('hex');
  const dir = revisionDir(input.buildRunId, input.revisionNumber);
  const assetsDir = path.join(dir, 'assets');
  await fs.rm(dir, { recursive: true, force: true });
  await extractTarGzArchive(input.archive, assetsDir);
  const manifest: PreviewManifest = {
    buildRunId: input.buildRunId,
    revisionNumber: input.revisionNumber,
    commit: input.commit,
    token,
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  return {
    token,
    previewUrl: buildPreviewPublicUrl(input.buildRunId, token),
  };
}

export async function resolvePreviewAssetPath(
  buildRunId: string,
  token: string,
  assetPath: string,
): Promise<{ absolutePath: string; manifest: PreviewManifest } | null> {
  const manifest = await verifyPreviewToken(buildRunId, token);
  if (!manifest) return null;
  const rel = normalizeRelativePath(assetPath === '' ? 'index.html' : assetPath);
  if (!rel) return null;
  const base = path.join(revisionDir(buildRunId, manifest.revisionNumber), 'assets');
  const absolutePath = path.join(base, rel);
  if (!absolutePath.startsWith(base)) return null;
  try {
    await fs.access(absolutePath);
  } catch {
    const indexFallback = path.join(base, 'index.html');
    try {
      await fs.access(indexFallback);
      return { absolutePath: indexFallback, manifest };
    } catch {
      return null;
    }
  }
  return { absolutePath, manifest };
}

export async function deletePreviewBundlesForRun(buildRunId: string): Promise<void> {
  await fs.rm(path.join(previewsRoot(), buildRunId), { recursive: true, force: true });
}

export function previewAssetContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}

export async function createPreviewReadStream(absolutePath: string) {
  return createReadStream(absolutePath);
}
