/**
 * Blob container access for V2 execution specifications and artifacts.
 *
 * Imported by the worker processes as well as the server, so this module must
 * stay free of database imports.
 */
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
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
  // AZURE_CLIENT_ID belongs to Apex application auth, not the V2 identities
  // Terraform grants blob access to.
  const clientId = process.env.AI_PLATFORM_V2_IDENTITY_CLIENT_ID?.trim();
  const credential = clientId
    ? new ManagedIdentityCredential({ clientId })
    : new DefaultAzureCredential();
  const service = new BlobServiceClient(
    `https://${account}.blob.core.windows.net`,
    credential,
  );
  return service.getContainerClient(containerName);
}
