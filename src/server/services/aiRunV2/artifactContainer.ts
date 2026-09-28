/**
 * Blob container access for V2 execution specifications and artifacts.
 *
 * Imported by the worker processes as well as the server, so this module must
 * stay free of database imports.
 */
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import {
  AzureCliCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';

export const DEFAULT_ARTIFACT_CONTAINER = 'ai-run-artifacts';

export function artifactContainerName(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.AI_PLATFORM_V2_ARTIFACT_CONTAINER?.trim() || DEFAULT_ARTIFACT_CONTAINER
  );
}

export function resolveArtifactContainerClient(
  containerName: string,
): ContainerClient {
  const account = process.env.AI_PLATFORM_V2_BLOB_ACCOUNT_NAME?.trim();
  if (!account) {
    throw new Error(
      'AI_PLATFORM_V2_BLOB_ACCOUNT_NAME is required for V2 artifact storage',
    );
  }
  const service = new BlobServiceClient(
    `https://${account}.blob.core.windows.net`,
    resolveArtifactCredential(),
  );
  return service.getContainerClient(containerName);
}

/**
 * AZURE_CLIENT_* belongs to Apex application auth, not Blob access, so the
 * App Service must not fall through to an environment credential. Workers use
 * their V2 identity; App Service uses its system identity.
 */
export function resolveArtifactCredential(
  env: NodeJS.ProcessEnv = process.env,
): TokenCredential {
  const clientId = env.AI_PLATFORM_V2_IDENTITY_CLIENT_ID?.trim();
  if (clientId) return new ManagedIdentityCredential({ clientId });
  return env.NODE_ENV === 'production'
    ? new ManagedIdentityCredential()
    : new AzureCliCredential();
}
