import {
  BlobServiceClient,
  type ContainerClient,
} from '@azure/storage-blob';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import type { ArtifactRef } from '../../../shared/types/loadTest';

export type ArtifactUploader = (
  key: string,
  body: string | Buffer,
) => Promise<ArtifactRef>;

function resolveContainerClient(): ContainerClient {
  const account =
    process.env.LT_BLOB_ACCOUNT_NAME?.trim() ||
    process.env.AZURE_STORAGE_ACCOUNT?.trim();
  const container =
    process.env.LT_BLOB_CONTAINER_NAME?.trim() || 'lt-artifacts';

  if (!account) {
    throw new Error('LT_BLOB_ACCOUNT_NAME is required for artifact upload');
  }

  const clientId = process.env.AZURE_CLIENT_ID?.trim();
  const credential = clientId
    ? new ManagedIdentityCredential({ clientId })
    : new DefaultAzureCredential();

  const service = new BlobServiceClient(
    `https://${account}.blob.core.windows.net`,
    credential,
  );
  return service.getContainerClient(container);
}

export function createBlobArtifactUploader(options?: {
  getContainerClient?: () => ContainerClient;
  containerName?: string;
}): ArtifactUploader {
  return async (key, body) => {
    const containerName =
      options?.containerName ||
      process.env.LT_BLOB_CONTAINER_NAME?.trim() ||
      'lt-artifacts';
    const client =
      options?.getContainerClient?.() ?? resolveContainerClient();
    const block = client.getBlockBlobClient(key);
    const buffer = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    await block.uploadData(buffer, {
      blobHTTPHeaders: { blobContentType: 'application/json' },
    });
    return { container: containerName, key };
  };
}
