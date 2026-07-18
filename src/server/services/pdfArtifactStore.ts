import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import { BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import {
  AzureCliCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';
import { resolveDataRoot } from '../utils/dataDir';

export interface PdfArtifactRef {
  userId: string;
  sessionId: string;
  fileName: string;
}

export type PdfArtifactSource = Buffer | Uint8Array | NodeJS.ReadableStream | string;

export interface PdfArtifactStore {
  putFile(ref: PdfArtifactRef, source: PdfArtifactSource): Promise<void>;
  getStream(ref: PdfArtifactRef): Promise<NodeJS.ReadableStream>;
  exists(ref: PdfArtifactRef): Promise<boolean>;
  deleteFile(ref: PdfArtifactRef): Promise<void>;
  deleteSessionPrefix(userId: string, sessionId: string): Promise<void>;
}

const SAFE_SEGMENT = /^[a-zA-Z0-9._@-]+$/;

function assertSafeSegment(value: string, label: string): void {
  if (!value || !SAFE_SEGMENT.test(value) || value === '.' || value === '..') {
    throw new Error(`Invalid PDF artifact ${label}`);
  }
}

export function buildPdfArtifactKey(ref: PdfArtifactRef): string {
  assertSafeSegment(ref.userId, 'userId');
  assertSafeSegment(ref.sessionId, 'sessionId');
  assertSafeSegment(ref.fileName, 'fileName');
  return `${ref.userId}/${ref.sessionId}/${ref.fileName}`;
}

async function sourceToBuffer(source: PdfArtifactSource): Promise<Buffer> {
  if (typeof source === 'string') return fsPromises.readFile(source);
  if (Buffer.isBuffer(source)) return source;
  if (source instanceof Uint8Array) return Buffer.from(source);

  const chunks: Buffer[] = [];
  for await (const chunk of source as NodeJS.ReadableStream & AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export class LocalPdfArtifactStore implements PdfArtifactStore {
  constructor(
    private readonly rootDir = path.join(resolveDataRoot(), 'pdf-sessions'),
  ) {}

  private resolvePath(ref: PdfArtifactRef): string {
    return path.join(this.rootDir, ...buildPdfArtifactKey(ref).split('/'));
  }

  async putFile(ref: PdfArtifactRef, source: PdfArtifactSource): Promise<void> {
    const destination = this.resolvePath(ref);
    await fsPromises.mkdir(path.dirname(destination), { recursive: true });
    if (typeof source === 'string') {
      try {
        await fsPromises.rename(source, destination);
        return;
      } catch {
        await fsPromises.copyFile(source, destination);
        await fsPromises.rm(source, { force: true });
        return;
      }
    }
    await fsPromises.writeFile(destination, await sourceToBuffer(source));
  }

  async getStream(ref: PdfArtifactRef): Promise<NodeJS.ReadableStream> {
    if (!(await this.exists(ref))) throw Object.assign(new Error('PDF artifact not found'), { code: 'ARTIFACT_NOT_FOUND' });
    return fs.createReadStream(this.resolvePath(ref));
  }

  async exists(ref: PdfArtifactRef): Promise<boolean> {
    try {
      await fsPromises.access(this.resolvePath(ref), fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async deleteFile(ref: PdfArtifactRef): Promise<void> {
    await fsPromises.rm(this.resolvePath(ref), { force: true });
  }

  async deleteSessionPrefix(userId: string, sessionId: string): Promise<void> {
    assertSafeSegment(userId, 'userId');
    assertSafeSegment(sessionId, 'sessionId');
    await fsPromises.rm(path.join(this.rootDir, userId, sessionId), {
      recursive: true,
      force: true,
    });
  }
}

export class BlobPdfArtifactStore implements PdfArtifactStore {
  private readonly container: ContainerClient;

  constructor(
    accountName: string,
    containerName: string,
    // AZURE_CLIENT_* config belongs to Apex application authentication, not
    // Blob access. Prefer managed identity in Azure and Azure CLI locally.
    credential: TokenCredential = process.env.NODE_ENV === 'production'
      ? new ManagedIdentityCredential()
      : new AzureCliCredential(),
  ) {
    const service = new BlobServiceClient(
      `https://${accountName}.blob.core.windows.net`,
      credential,
    );
    this.container = service.getContainerClient(containerName);
  }

  async putFile(ref: PdfArtifactRef, source: PdfArtifactSource): Promise<void> {
    const key = buildPdfArtifactKey(ref);
    try {
      const blockBlob = this.container.getBlockBlobClient(key);
      if (typeof source === 'string') {
        await blockBlob.uploadFile(source);
      } else if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
        const buffer = Buffer.from(source);
        await blockBlob.uploadData(buffer);
      } else {
        await blockBlob.uploadStream(source as Readable);
      }
    } catch (error) {
      this.recordBlobError('put', key, error);
      throw error;
    }
  }

  async getStream(ref: PdfArtifactRef): Promise<NodeJS.ReadableStream> {
    const key = buildPdfArtifactKey(ref);
    try {
      const response = await this.container.getBlobClient(key).download();
      if (!response.readableStreamBody) throw new Error('Blob response did not include a stream');
      return response.readableStreamBody;
    } catch (error) {
      this.recordBlobError('get', key, error);
      throw error;
    }
  }

  async exists(ref: PdfArtifactRef): Promise<boolean> {
    const key = buildPdfArtifactKey(ref);
    try {
      return await this.container.getBlobClient(key).exists();
    } catch (error) {
      this.recordBlobError('exists', key, error);
      throw error;
    }
  }

  async deleteFile(ref: PdfArtifactRef): Promise<void> {
    const key = buildPdfArtifactKey(ref);
    try {
      await this.container.getBlobClient(key).deleteIfExists({ deleteSnapshots: 'include' });
    } catch (error) {
      this.recordBlobError('delete', key, error);
      throw error;
    }
  }

  async deleteSessionPrefix(userId: string, sessionId: string): Promise<void> {
    const prefix = buildPdfArtifactKey({ userId, sessionId, fileName: '_prefix' })
      .replace(/_prefix$/, '');
    try {
      for await (const blob of this.container.listBlobsFlat({ prefix })) {
        await this.container.deleteBlob(blob.name, { deleteSnapshots: 'include' });
      }
    } catch (error) {
      this.recordBlobError('delete-prefix', prefix, error);
      throw error;
    }
  }

  private recordBlobError(operation: string, key: string, error: unknown): void {
    console.error('[pdf-artifact-store] Blob I/O failed', {
      metric: 'pdf_blob_io_errors',
      count: 1,
      operation,
      key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

let configuredStore: PdfArtifactStore | undefined;

export function createPdfArtifactStore(): PdfArtifactStore {
  const accountName = process.env.PDF_BLOB_ACCOUNT_NAME?.trim();
  if (!accountName) return new LocalPdfArtifactStore();
  return new BlobPdfArtifactStore(
    accountName,
    process.env.PDF_BLOB_CONTAINER_NAME?.trim() || 'pdf-artifacts',
  );
}

export function getPdfArtifactStore(): PdfArtifactStore {
  configuredStore ??= createPdfArtifactStore();
  return configuredStore;
}

export function setPdfArtifactStoreForTests(store?: PdfArtifactStore): void {
  configuredStore = store;
}

export async function readPdfArtifact(ref: PdfArtifactRef): Promise<Buffer> {
  return sourceToBuffer(await getPdfArtifactStore().getStream(ref));
}
