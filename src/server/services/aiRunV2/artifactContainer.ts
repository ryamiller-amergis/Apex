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
 * On App Service, AZURE_CLIENT_ID + AZURE_CLIENT_SECRET are the Apex app
 * registration, which has no Blob access, so it uses its system identity.
 * Workers name their user-assigned identity with AI_PLATFORM_V2_IDENTITY_CLIENT_ID
 * or, without a client secret, AZURE_CLIENT_ID.
 */
export function resolveArtifactCredential(
  env: NodeJS.ProcessEnv = process.env,
): TokenCredential {
  const v2ClientId = env.AI_PLATFORM_V2_IDENTITY_CLIENT_ID?.trim();
  if (v2ClientId) return new ManagedIdentityCredential({ clientId: v2ClientId });
  if (env.NODE_ENV !== 'production') return new AzureCliCredential();
  const workerClientId = env.AZURE_CLIENT_SECRET?.trim()
    ? undefined
    : env.AZURE_CLIENT_ID?.trim();
  return workerClientId
    ? new ManagedIdentityCredential({ clientId: workerClientId })
    : new ManagedIdentityCredential();
}
