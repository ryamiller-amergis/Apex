import * as azdev from 'azure-devops-node-api';
import { inflateRaw } from 'zlib';
import { promisify } from 'util';

const inflateRawAsync = promisify(inflateRaw);

export interface ZipEntry {
  fileName: string;
  compression: number;
  compressedSize: number;
  localHeaderOffset: number;
}

export function normalizePagedList<T>(page: unknown): T[] {
  if (Array.isArray(page)) return page;
  if (page && typeof page === 'object' && Array.isArray((page as { value?: unknown[] }).value)) {
    return (page as { value: T[] }).value;
  }
  return [];
}

export function readZipEntries(zip: Buffer): ZipEntry[] {
  let eocdOffset = -1;
  for (let i = zip.length - 22; i >= 0; i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return [];

  const centralDirOffset = zip.readUInt32LE(eocdOffset + 16);
  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  const entries: ZipEntry[] = [];
  let offset = centralDirOffset;

  for (let i = 0; i < entryCount && offset + 46 <= zip.length; i += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) break;
    const compression = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const fileNameLen = zip.readUInt16LE(offset + 28);
    const extraLen = zip.readUInt16LE(offset + 30);
    const commentLen = zip.readUInt16LE(offset + 32);
    const localHeaderOffset = zip.readUInt32LE(offset + 42);
    const fileName = zip.toString('utf8', offset + 46, offset + 46 + fileNameLen).replace(/\\/g, '/');
    entries.push({ fileName, compression, compressedSize, localHeaderOffset });
    offset = offset + 46 + fileNameLen + extraLen + commentLen;
  }

  return entries;
}

async function readZipEntryData(zip: Buffer, entry: ZipEntry): Promise<Buffer | null> {
  const localOffset = entry.localHeaderOffset;
  if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== 0x04034b50) return null;

  const fileNameLen = zip.readUInt16LE(localOffset + 26);
  const extraLen = zip.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + fileNameLen + extraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > zip.length) return null;

  const compressed = zip.subarray(dataStart, dataEnd);
  if (entry.compression === 0) return compressed;
  if (entry.compression === 8) return inflateRawAsync(compressed);
  return null;
}

export async function extractFileFromZip(zip: Buffer, targetFileName: string): Promise<Buffer | null> {
  const targetName = targetFileName.replace(/\\/g, '/');
  const targetBase = targetName.split('/').pop()?.toLowerCase() ?? targetName.toLowerCase();

  for (const entry of readZipEntries(zip)) {
    const fileBase = entry.fileName.split('/').pop()?.toLowerCase() ?? entry.fileName.toLowerCase();
    const nameMatches =
      entry.fileName === targetName ||
      entry.fileName.endsWith(`/${targetBase}`) ||
      fileBase === targetBase;
    if (!nameMatches) continue;

    const raw = await readZipEntryData(zip, entry);
    if (!raw) {
      throw new Error(`Unsupported ZIP compression method ${entry.compression} for ${entry.fileName}`);
    }
    return raw;
  }

  return null;
}

export async function extractTextFromZip(zip: Buffer, targetFileName: string): Promise<string | null> {
  const raw = await extractFileFromZip(zip, targetFileName);
  return raw ? raw.toString('utf8') : null;
}

/** Find the first zip entry whose path ends with the given suffix. */
export async function extractTextFromZipBySuffix(zip: Buffer, pathSuffix: string): Promise<string | null> {
  const normalizedSuffix = pathSuffix.replace(/\\/g, '/').toLowerCase();
  for (const entry of readZipEntries(zip)) {
    if (!entry.fileName.toLowerCase().endsWith(normalizedSuffix)) continue;
    const raw = await readZipEntryData(zip, entry);
    if (!raw) continue;
    return raw.toString('utf8');
  }
  return null;
}

export async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

interface ArtifactResource {
  type?: string;
  downloadUrl?: string;
  url?: string;
}

export function getAdoPat(): string {
  const pat = process.env.ADO_PAT?.trim();
  if (!pat) throw new Error('ADO_PAT must be configured to load pipeline artifact data');
  return pat;
}

export function getAdoConnection(): azdev.WebApi {
  const orgUrl = process.env.ADO_ORG?.trim();
  const pat = getAdoPat();
  if (!orgUrl) {
    throw new Error('ADO_ORG must be configured to load pipeline artifact data');
  }
  return new azdev.WebApi(orgUrl, azdev.getPersonalAccessTokenHandler(pat), { socketTimeout: 120000 });
}

/** Download artifact bytes — PipelineArtifact needs resource.downloadUrl, not getArtifactContentZip alone. */
export async function downloadArtifactZip(
  buildApi: Awaited<ReturnType<azdev.WebApi['getBuildApi']>>,
  project: string,
  buildId: number,
  artifactName: string,
): Promise<Buffer | null> {
  const auth = `Basic ${Buffer.from(`:${getAdoPat()}`).toString('base64')}`;

  try {
    const meta = (await buildApi.getArtifact(project, buildId, artifactName)) as {
      resource?: ArtifactResource;
    };
    const resource = meta?.resource;
    const downloadUrl = resource?.downloadUrl ?? resource?.url;
    if (downloadUrl) {
      const zipUrl =
        downloadUrl.includes('$format=zip') || downloadUrl.includes('%24format=zip')
          ? downloadUrl
          : `${downloadUrl}${downloadUrl.includes('?') ? '&' : '?'}$format=zip`;
      const res = await fetch(zipUrl, {
        headers: { Authorization: auth, Accept: 'application/zip' },
      });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 500) return buf;
      }
    }
  } catch {
    // This build has no artifact with that name — normal for most nightly runs.
  }

  try {
    const zipStream = await buildApi.getArtifactContentZip(project, buildId, artifactName);
    const buf = await streamToBuffer(zipStream);
    if (buf.length > 500) return buf;
  } catch {
    // Fall through
  }

  return null;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await mapper(items[current]!);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}
