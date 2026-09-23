import { createHash } from 'node:crypto';
import type { ContainerClient } from '@azure/storage-blob';
import { createInteractiveAttachmentStore } from '../services/interactiveAttachmentStore';

const THREAD_ID = '10000000-0000-4000-8000-000000000001';
const TURN_ID = '20000000-0000-4000-8000-000000000001';
const ATTACHMENT_ID = '30000000-0000-4000-8000-000000000001';

function containerWith(
  blockBlob: Record<string, jest.Mock>,
): ContainerClient {
  return {
    containerName: 'ai-run-artifacts',
    getBlockBlobClient: jest.fn(() => blockBlob),
  } as unknown as ContainerClient;
}

describe('interactive attachment store', () => {
  it('uses one immutable key per attachment hash', async () => {
    const uploadData = jest.fn().mockResolvedValue({ etag: 'etag-1' });
    const store = createInteractiveAttachmentStore({
      container: containerWith({ uploadData }),
    });

    const stored = await store.upload({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      attachment: {
        id: ATTACHMENT_ID,
        name: 'notes.txt',
        type: 'text/plain',
        size: 5,
        content: 'hello',
      },
    });

    expect(stored.blobRef.key).toMatch(
      new RegExp(
        `^interactive/${THREAD_ID}/${TURN_ID}/${ATTACHMENT_ID}/[a-f0-9]{64}$`,
      ),
    );
    expect(stored.materializedPath).toBe(
      `.ai-pilot/attachments/${TURN_ID}/notes.txt`,
    );
    expect(stored.sha256).toBe(
      createHash('sha256').update(Buffer.from('hello')).digest('hex'),
    );
    expect(uploadData).toHaveBeenCalledWith(
      Buffer.from('hello'),
      expect.objectContaining({
        conditions: { ifNoneMatch: '*' },
        blobHTTPHeaders: { blobContentType: 'text/plain' },
        metadata: expect.objectContaining({
          sha256: stored.sha256,
          sizeBytes: '5',
        }),
      }),
    );
  });

  it('decodes base64 before hashing and verifies the decoded byte length', async () => {
    const uploadData = jest.fn().mockResolvedValue({});
    const store = createInteractiveAttachmentStore({
      container: containerWith({ uploadData }),
    });

    const stored = await store.upload({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      attachment: {
        id: ATTACHMENT_ID,
        name: 'pixel.png',
        type: 'image/png',
        size: 5,
        content: Buffer.from('hello').toString('base64'),
        encoding: 'base64',
      },
    });

    expect(stored.sizeBytes).toBe(5);
    expect(uploadData.mock.calls[0][0]).toEqual(Buffer.from('hello'));

    await expect(
      store.upload({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        attachment: {
          id: ATTACHMENT_ID,
          name: 'wrong.png',
          type: 'image/png',
          size: 4,
          content: Buffer.from('hello').toString('base64'),
          encoding: 'base64',
        },
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'INTERACTIVE_V2_ATTACHMENT_SIZE_MISMATCH',
    });
  });

  it('rejects unsupported attachment content with the stable 415 code', async () => {
    const store = createInteractiveAttachmentStore({
      container: containerWith({ uploadData: jest.fn() }),
    });

    await expect(
      store.upload({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        attachment: {
          id: ATTACHMENT_ID,
          name: 'archive.zip',
          type: 'application/zip',
          size: 3,
          content: 'zip',
        },
      }),
    ).rejects.toMatchObject({
      status: 415,
      code: 'INTERACTIVE_V2_ATTACHMENT_UNSUPPORTED',
      message: 'INTERACTIVE_V2_ATTACHMENT_UNSUPPORTED',
    });
  });

  it('reuses an existing immutable object only when hash and size match', async () => {
    const bytes = Buffer.from('hello');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const uploadData = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('exists'), { statusCode: 409 }));
    const getProperties = jest.fn().mockResolvedValue({
      metadata: { sha256, sizebytes: String(bytes.byteLength) },
      contentLength: bytes.byteLength,
    });
    const store = createInteractiveAttachmentStore({
      container: containerWith({ uploadData, getProperties }),
    });
    const input = {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      attachment: {
        id: ATTACHMENT_ID,
        name: 'notes.txt',
        type: 'text/plain',
        size: 5,
        content: 'hello',
      },
    } as const;

    await expect(store.upload(input)).resolves.toMatchObject({
      sha256,
      sizeBytes: 5,
    });

    getProperties.mockResolvedValueOnce({
      metadata: { sha256: 'f'.repeat(64), sizebytes: '5' },
      contentLength: 5,
    });
    await expect(store.upload(input)).rejects.toMatchObject({
      status: 409,
      code: 'TURN_ID_CONFLICT',
      message: 'TURN_ID_CONFLICT',
    });
  });
});
