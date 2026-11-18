import type { ContainerClient } from '@azure/storage-blob';
import {
  createDocumentInputSnapshotStore,
  documentInputSnapshotKey,
} from '../services/aiRunV2/documentInputSnapshot';

function fakeContainer() {
  const blobs = new Map<string, Buffer>();
  const container = {
    getBlockBlobClient: (key: string) => ({
      uploadData: async (body: Buffer) => {
        blobs.set(key, body);
      },
      downloadToBuffer: async () => {
        const body = blobs.get(key);
        if (!body) throw Object.assign(new Error('BlobNotFound'), { statusCode: 404 });
        return body;
      },
      deleteIfExists: async () => {
        blobs.delete(key);
      },
    }),
  } as unknown as ContainerClient;
  return { blobs, container };
}

describe('document input snapshot store', () => {
  it('saves and reads the inputs for a thread', async () => {
    const { blobs, container } = fakeContainer();
    const store = createDocumentInputSnapshotStore({
      getContainerClient: () => container,
      containerName: 'ai-run-artifacts',
      isConfigured: () => true,
    });
    const inputs = [{ path: '.ai-pilot/test-plans.md', content: '# Plans' }];

    await expect(store.save('thread-1', inputs)).resolves.toBe(true);

    expect(blobs.has(documentInputSnapshotKey('thread-1'))).toBe(true);
    await expect(store.read('thread-1')).resolves.toEqual(inputs);
  });

  it('returns null for a thread with no snapshot', async () => {
    const { container } = fakeContainer();
    const store = createDocumentInputSnapshotStore({
      getContainerClient: () => container,
      isConfigured: () => true,
    });

    await expect(store.read('thread-missing')).resolves.toBeNull();
  });

  it('does nothing when Blob storage is not configured', async () => {
    const getContainerClient = jest.fn();
    const store = createDocumentInputSnapshotStore({
      getContainerClient,
      isConfigured: () => false,
    });

    await expect(store.save('thread-1', [])).resolves.toBe(false);
    await expect(store.read('thread-1')).resolves.toBeNull();
    expect(getContainerClient).not.toHaveBeenCalled();
  });
});
