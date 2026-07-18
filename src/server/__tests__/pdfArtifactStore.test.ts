import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';

const mockUploadData = jest.fn();
const mockDownload = jest.fn();
const mockExists = jest.fn();
const mockDeleteIfExists = jest.fn();
const mockDeleteBlob = jest.fn();
const mockListBlobsFlat = jest.fn();
const mockGetBlockBlobClient = jest.fn(() => ({
  uploadData: mockUploadData,
  uploadFile: jest.fn(),
  uploadStream: jest.fn(),
}));
const mockGetBlobClient = jest.fn(() => ({
  download: mockDownload,
  exists: mockExists,
  deleteIfExists: mockDeleteIfExists,
}));
const mockContainer = {
  getBlockBlobClient: mockGetBlockBlobClient,
  getBlobClient: mockGetBlobClient,
  deleteBlob: mockDeleteBlob,
  listBlobsFlat: mockListBlobsFlat,
};

jest.mock('@azure/storage-blob', () => ({
  BlobServiceClient: jest.fn().mockImplementation(() => ({
    getContainerClient: jest.fn(() => mockContainer),
  })),
}));

jest.mock('@azure/identity', () => ({
  DefaultAzureCredential: jest.fn(),
}));

import {
  BlobPdfArtifactStore,
  LocalPdfArtifactStore,
  buildPdfArtifactKey,
} from '../services/pdfArtifactStore';

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as NodeJS.ReadableStream & AsyncIterable<Buffer>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe('pdfArtifactStore', () => {
  let root: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-artifacts-test-'));
    mockUploadData.mockResolvedValue(undefined);
    mockDownload.mockResolvedValue({ readableStreamBody: Readable.from(Buffer.from('blob-data')) });
    mockExists.mockResolvedValue(true);
    mockDeleteBlob.mockResolvedValue(undefined);
    mockDeleteIfExists.mockResolvedValue(undefined);
    mockListBlobsFlat.mockReturnValue((async function* () {
      yield { name: 'user-1/session-1/a.pdf' };
    })());
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test('builds user-scoped session keys and rejects traversal', () => {
    expect(buildPdfArtifactKey({
      userId: 'user-1',
      sessionId: 'session-1',
      fileName: 'file-1.pdf',
    })).toBe('user-1/session-1/file-1.pdf');
    expect(() => buildPdfArtifactKey({
      userId: '../other-user',
      sessionId: 'session-1',
      fileName: 'file.pdf',
    })).toThrow('Invalid PDF artifact userId');
  });

  test('local backend round-trips and deletes an artifact', async () => {
    const store = new LocalPdfArtifactStore(root);
    const ref = { userId: 'user-1', sessionId: 'session-1', fileName: 'file.pdf' };

    await store.putFile(ref, Buffer.from('local-data'));
    expect(await store.exists(ref)).toBe(true);
    expect(await streamToBuffer(await store.getStream(ref))).toEqual(Buffer.from('local-data'));
    await store.deleteFile(ref);
    expect(await store.exists(ref)).toBe(false);
  });

  test('Blob backend uses the same user-scoped key for managed storage operations', async () => {
    const store = new BlobPdfArtifactStore('account', 'pdf-artifacts', {} as any);
    const ref = { userId: 'user-1', sessionId: 'session-1', fileName: 'file.pdf' };

    await store.putFile(ref, Buffer.from('blob-data'));
    expect(mockGetBlockBlobClient).toHaveBeenCalledWith('user-1/session-1/file.pdf');
    expect(mockUploadData).toHaveBeenCalledWith(Buffer.from('blob-data'));
    expect(await streamToBuffer(await store.getStream(ref))).toEqual(Buffer.from('blob-data'));
    await store.deleteFile(ref);
    expect(mockDeleteIfExists).toHaveBeenCalledWith(
      { deleteSnapshots: 'include' },
    );
  });

  test('Blob backend records exists failures before rethrowing', async () => {
    const store = new BlobPdfArtifactStore('account', 'pdf-artifacts', {} as any);
    const ref = { userId: 'user-1', sessionId: 'session-1', fileName: 'file.pdf' };
    const error = new Error('Blob unavailable');
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockExists.mockRejectedValueOnce(error);

    try {
      await expect(store.exists(ref)).rejects.toThrow(error);
      expect(consoleError).toHaveBeenCalledWith(
        '[pdf-artifact-store] Blob I/O failed',
        expect.objectContaining({
          metric: 'pdf_blob_io_errors',
          count: 1,
          operation: 'exists',
          key: 'user-1/session-1/file.pdf',
          error: 'Blob unavailable',
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
