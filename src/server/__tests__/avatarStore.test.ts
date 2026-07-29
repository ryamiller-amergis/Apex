/**
 * FEAT-002 avatarStore tests.
 * Criterion ids in names for Requirements → Test Matrix traceability.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { Readable } from 'stream';
import type { TokenCredential } from '@azure/identity';

const mockUploadData = jest.fn();
const mockDownload = jest.fn();
const mockExists = jest.fn();
const mockDeleteIfExists = jest.fn();
const mockAzureCliCredential = jest.fn();
const mockManagedIdentityCredential = jest.fn();
const mockGetBlockBlobClient = jest.fn(() => ({ uploadData: mockUploadData }));
const mockGetBlobClient = jest.fn(() => ({
  download: mockDownload,
  exists: mockExists,
  deleteIfExists: mockDeleteIfExists,
}));
const mockContainer = {
  getBlockBlobClient: mockGetBlockBlobClient,
  getBlobClient: mockGetBlobClient,
};

jest.mock('@azure/storage-blob', () => ({
  BlobServiceClient: jest.fn().mockImplementation(() => ({
    getContainerClient: jest.fn(() => mockContainer),
  })),
}));

jest.mock('@azure/identity', () => ({
  AzureCliCredential: mockAzureCliCredential,
  ManagedIdentityCredential: mockManagedIdentityCredential,
}));

import {
  BlobAvatarStore,
  LocalAvatarStore,
  buildAvatarObjectKey,
} from '../services/avatarStore';

const noopCredential: TokenCredential = {
  getToken: async () => null,
};

describe('avatarStore — TBI-002 / FEAT-002', () => {
  let root: string;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    jest.clearAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'avatar-store-test-'));
    mockUploadData.mockResolvedValue(undefined);
    mockDownload.mockResolvedValue({ readableStreamBody: Readable.from(Buffer.from('blob-avatar')) });
    mockExists.mockResolvedValue(true);
    mockDeleteIfExists.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    await fs.rm(root, { recursive: true, force: true });
  });

  describe('buildAvatarObjectKey — deterministic key, traversal resistance', () => {
    it('produces a stable sha256-based key for the same oid', () => {
      const key1 = buildAvatarObjectKey('user-oid-123');
      const key2 = buildAvatarObjectKey('user-oid-123');
      expect(key1).toBe(key2);
      expect(key1).toMatch(/^avatars\/[a-f0-9]{64}\.webp$/);
    });

    it('produces different keys for different oids and never embeds the raw oid', () => {
      const key = buildAvatarObjectKey('user-oid-123');
      const other = buildAvatarObjectKey('user-oid-456');
      expect(key).not.toBe(other);
      expect(key).not.toContain('user-oid-123');
    });

    it('matches an independently computed sha256 digest', () => {
      const expected = crypto.createHash('sha256').update(Buffer.from('abc', 'utf8')).digest('hex');
      expect(buildAvatarObjectKey('abc')).toBe(`avatars/${expected}.webp`);
    });

    it('rejects empty or non-string owner input', () => {
      expect(() => buildAvatarObjectKey('')).toThrow('Invalid avatar owner');
      expect(() => buildAvatarObjectKey('   ')).toThrow('Invalid avatar owner');
    });
  });

  describe('DoD-1 — traversal resistance for local and Blob backends', () => {
    it('local backend rejects a path-traversal key', async () => {
      const store = new LocalAvatarStore(root);
      await expect(store.put('../../etc/passwd', Buffer.from('x'), 'image/webp')).rejects.toThrow(
        'Invalid avatar object key'
      );
      await expect(store.get('avatars/not-a-hash.webp')).rejects.toThrow('Invalid avatar object key');
    });

    it('Blob backend rejects a malformed key before any network call', async () => {
      const store = new BlobAvatarStore('account', 'avatars', noopCredential);
      await expect(store.put('../escape.webp', Buffer.from('x'), 'image/webp')).rejects.toThrow(
        'Invalid avatar object key'
      );
      expect(mockGetBlockBlobClient).not.toHaveBeenCalled();
    });
  });

  describe('DoD-2 — local round trip', () => {
    it('put/get/exists/delete round-trip a local avatar', async () => {
      const store = new LocalAvatarStore(root);
      const key = buildAvatarObjectKey('user-1');

      expect(await store.exists(key)).toBe(false);
      await store.put(key, Buffer.from('local-bytes'), 'image/webp');
      expect(await store.exists(key)).toBe(true);
      expect(await store.get(key)).toEqual(Buffer.from('local-bytes'));

      await store.delete(key);
      expect(await store.exists(key)).toBe(false);
    });
  });

  describe('DoD-2 — Blob mock put/get/delete', () => {
    it('put/get/delete delegate to the container client using the object key', async () => {
      const store = new BlobAvatarStore('account', 'avatars', noopCredential);
      const key = buildAvatarObjectKey('user-1');

      await store.put(key, Buffer.from('blob-bytes'), 'image/webp');
      expect(mockGetBlockBlobClient).toHaveBeenCalledWith(key);
      expect(mockUploadData).toHaveBeenCalledWith(
        Buffer.from('blob-bytes'),
        { blobHTTPHeaders: { blobContentType: 'image/webp' } }
      );

      expect(await store.get(key)).toEqual(Buffer.from('blob-avatar'));
      expect(await store.exists(key)).toBe(true);

      await store.delete(key);
      expect(mockDeleteIfExists).toHaveBeenCalledWith({ deleteSnapshots: 'include' });
    });
  });

  describe('DoD-0 — managed identity selection in production', () => {
    it('uses Azure CLI credentials outside production', () => {
      process.env.NODE_ENV = 'development';
      new BlobAvatarStore('account', 'avatars');
      expect(mockAzureCliCredential).toHaveBeenCalledTimes(1);
      expect(mockManagedIdentityCredential).not.toHaveBeenCalled();
    });

    it('uses managed identity credentials in production', () => {
      process.env.NODE_ENV = 'production';
      new BlobAvatarStore('account', 'avatars');
      expect(mockManagedIdentityCredential).toHaveBeenCalledTimes(1);
      expect(mockAzureCliCredential).not.toHaveBeenCalled();
    });
  });

  describe('DoD-3 — logs omit oid, blob keys, and byte counts', () => {
    it('records a Blob failure without leaking the key or payload', async () => {
      const store = new BlobAvatarStore('account', 'avatars', noopCredential);
      const key = buildAvatarObjectKey('secret-user-oid');
      const error = new Error('Blob unavailable');
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockExists.mockRejectedValueOnce(error);

      try {
        await expect(store.exists(key)).rejects.toThrow(error);
        expect(consoleError).toHaveBeenCalledTimes(1);
        const [message, meta] = consoleError.mock.calls[0];
        expect(message).toBe('[avatar-store] Blob I/O failed');
        expect(meta).toEqual({
          metric: 'avatar_blob_io_errors',
          count: 1,
          operation: 'exists',
          error: 'Blob unavailable',
        });
        expect(JSON.stringify(meta)).not.toContain(key);
        expect(JSON.stringify(meta)).not.toContain('secret-user-oid');
      } finally {
        consoleError.mockRestore();
      }
    });
  });
});
