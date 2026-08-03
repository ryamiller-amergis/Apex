/**
 * FEAT-002 — Secure Avatar Storage.
 *
 * Object keys are derived deterministically from the user's Azure AD OID
 * (SHA-256 hex digest), never from user-controlled input, so paths cannot be
 * used for traversal and the OID itself never appears in a Blob path or log.
 *
 * Local backend mirrors pdfArtifactStore.ts; Blob backend uses Managed
 * Identity in production and the Azure CLI credential locally — never
 * static keys. Do NOT log oid, blob keys, or byte counts anywhere in this
 * module (DoD-3): only the `avatar_blob_io_errors` metric name and a short
 * operation label are recorded on failure.
 */
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import {
  AzureCliCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';
import { resolveDataRoot } from '../utils/dataDir';

export interface AvatarStore {
  put(key: string, buffer: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

const OBJECT_KEY_PATTERN = /^avatars\/[a-f0-9]{64}\.webp$/;

/**
 * Deterministic, non-reversible object key for a user's avatar.
 * Never derived from or containing raw user input beyond the hash.
 */
export function buildAvatarObjectKey(userOid: string): string {
  if (typeof userOid !== 'string' || userOid.trim().length === 0) {
    throw new Error('Invalid avatar owner');
  }
  const digest = crypto.createHash('sha256').update(Buffer.from(userOid, 'utf8')).digest('hex');
  return `avatars/${digest}.webp`;
}

function assertSafeObjectKey(key: string): void {
  if (typeof key !== 'string' || !OBJECT_KEY_PATTERN.test(key)) {
    throw new Error('Invalid avatar object key');
  }
}

export class LocalAvatarStore implements AvatarStore {
  constructor(private readonly rootDir: string = path.join(resolveDataRoot(), 'avatars')) {}

  private resolvePath(key: string): string {
    assertSafeObjectKey(key);
    return path.join(this.rootDir, path.basename(key));
  }

  async put(key: string, buffer: Buffer, _contentType: string): Promise<void> {
    const destination = this.resolvePath(key);
    await fsPromises.mkdir(path.dirname(destination), { recursive: true });
    await fsPromises.writeFile(destination, buffer);
  }

  async get(key: string): Promise<Buffer> {
    return fsPromises.readFile(this.resolvePath(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fsPromises.access(this.resolvePath(key), fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await fsPromises.rm(this.resolvePath(key), { force: true });
  }
}

export class BlobAvatarStore implements AvatarStore {
  private readonly container: ContainerClient;

  constructor(
    accountName: string,
    containerName: string,
    // Apex application auth (AZURE_CLIENT_*) is unrelated to Blob access.
    // Managed identity in Azure, Azure CLI credential for local dev.
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

  async put(key: string, buffer: Buffer, contentType: string): Promise<void> {
    assertSafeObjectKey(key);
    try {
      const blockBlob = this.container.getBlockBlobClient(key);
      await blockBlob.uploadData(buffer, { blobHTTPHeaders: { blobContentType: contentType } });
    } catch (error) {
      this.recordBlobError('put', error);
      throw error;
    }
  }

  async get(key: string): Promise<Buffer> {
    assertSafeObjectKey(key);
    try {
      const response = await this.container.getBlobClient(key).download();
      if (!response.readableStreamBody) {
        throw new Error('Blob response did not include a stream');
      }
      const chunks: Buffer[] = [];
      for await (const chunk of response.readableStreamBody as NodeJS.ReadableStream &
        AsyncIterable<Buffer | string>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (error) {
      this.recordBlobError('get', error);
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    assertSafeObjectKey(key);
    try {
      return await this.container.getBlobClient(key).exists();
    } catch (error) {
      this.recordBlobError('exists', error);
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertSafeObjectKey(key);
    try {
      await this.container.getBlobClient(key).deleteIfExists({ deleteSnapshots: 'include' });
    } catch (error) {
      this.recordBlobError('delete', error);
      throw error;
    }
  }

  /** Never include oid, blob key, or byte counts — metric name + operation only. */
  private recordBlobError(operation: string, error: unknown): void {
    console.error('[avatar-store] Blob I/O failed', {
      metric: 'avatar_blob_io_errors',
      count: 1,
      operation,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

let configuredStore: AvatarStore | undefined;

export function createAvatarStore(): AvatarStore {
  const accountName = process.env.AVATAR_BLOB_ACCOUNT_NAME?.trim();
  if (!accountName) {
    return new LocalAvatarStore();
  }
  return new BlobAvatarStore(
    accountName,
    process.env.AVATAR_BLOB_CONTAINER_NAME?.trim() || 'avatars',
  );
}

export function getAvatarStore(): AvatarStore {
  configuredStore ??= createAvatarStore();
  return configuredStore;
}

export function setAvatarStoreForTests(store?: AvatarStore): void {
  configuredStore = store;
}
