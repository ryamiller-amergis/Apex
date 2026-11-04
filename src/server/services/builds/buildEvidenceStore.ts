/**
 * Blob evidence storage for Build verification rows (TBI-021, S5).
 *
 * Wraps `resolveArtifactContainerClient` from `aiRunV2/artifactContainer.ts`
 * (managed identity, no storage keys). Must stay free of database imports.
 */
import { Readable } from 'node:stream';
import type { ContainerClient } from '@azure/storage-blob';
import type { ArtifactRef } from '../../../shared/types/loadTest';
import {
  DEFAULT_ARTIFACT_CONTAINER,
  artifactContainerName,
  resolveArtifactContainerClient,
} from '../aiRunV2/artifactContainer';

export type EvidenceSlot = 'red' | 'green';

export interface BuildEvidenceStore {
  putEvidence(
    prefix: string,
    slot: EvidenceSlot,
    text: string,
    container?: string,
  ): Promise<ArtifactRef>;
  streamEvidence(
    ref: ArtifactRef,
    slot: EvidenceSlot,
  ): Promise<NodeJS.ReadableStream | null>;
}

export interface InMemoryEvidenceStore extends BuildEvidenceStore {
  readonly blobs: Map<string, string>;
  getText(refOrPrefix: ArtifactRef | string, slot: EvidenceSlot): string | null;
}

function normalizePrefix(prefix: string): string {
  return prefix.replace(/\/+$/, '');
}

/**
 * Key prefix for a verification row's red and green evidence blobs:
 * `builds/{buildRunId}/r{revisionNumber}/{requirementId}`.
 */
export function buildEvidenceBlobPrefix(
  buildRunId: string,
  revisionNumber: number,
  requirementId: string,
): string {
  return `builds/${buildRunId}/r${revisionNumber}/${requirementId}`;
}

/**
 * Full blob key for a single slot (`red` or `green`) beneath a row prefix:
 * `builds/{buildRunId}/r{revisionNumber}/{requirementId}/{slot}.txt`.
 */
export function buildEvidenceBlobKey(prefix: string, slot: EvidenceSlot): string {
  return `${normalizePrefix(prefix)}/${slot}.txt`;
}

function isBlobNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { statusCode?: unknown; code?: unknown };
  return candidate.statusCode === 404 || candidate.code === 'BlobNotFound';
}

export function createBuildEvidenceStore(deps?: {
  getContainerClient?: (containerName: string) => Pick<ContainerClient, 'getBlockBlobClient'>;
  defaultContainer?: () => string;
}): BuildEvidenceStore {
  const getContainerClient = deps?.getContainerClient ?? resolveArtifactContainerClient;
  const resolveDefaultContainer = deps?.defaultContainer ?? (() => artifactContainerName());

  return {
    async putEvidence(
      prefix: string,
      slot: EvidenceSlot,
      text: string,
      container?: string,
    ): Promise<ArtifactRef> {
      const targetContainer = container?.trim() || resolveDefaultContainer();
      const cleanPrefix = normalizePrefix(prefix);
      const blobKey = buildEvidenceBlobKey(cleanPrefix, slot);
      const body = Buffer.from(text, 'utf8');
      const client = getContainerClient(targetContainer);
      await client.getBlockBlobClient(blobKey).upload(body, body.byteLength, {
        blobHTTPHeaders: { blobContentType: 'text/plain; charset=utf-8' },
      });
      return {
        container: targetContainer,
        key: cleanPrefix,
      };
    },

    async streamEvidence(
      ref: ArtifactRef,
      slot: EvidenceSlot,
    ): Promise<NodeJS.ReadableStream | null> {
      const blobKey = buildEvidenceBlobKey(ref.key, slot);
      const client = getContainerClient(ref.container);
      try {
        const response = await client.getBlockBlobClient(blobKey).download();
        return response.readableStreamBody ?? null;
      } catch (error) {
        if (isBlobNotFoundError(error)) {
          return null;
        }
        throw error;
      }
    },
  };
}

const defaultStore = createBuildEvidenceStore();
const localFallbackStore = createInMemoryEvidenceStore();

export async function putEvidence(
  prefix: string,
  slot: EvidenceSlot,
  text: string,
  container?: string,
): Promise<ArtifactRef> {
  try {
    return await defaultStore.putEvidence(prefix, slot, text, container);
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      return localFallbackStore.putEvidence(prefix, slot, text, container);
    }
    throw error;
  }
}

export async function streamEvidence(
  ref: ArtifactRef,
  slot: EvidenceSlot,
): Promise<NodeJS.ReadableStream | null> {
  const localStream = await localFallbackStore.streamEvidence(ref, slot);
  if (localStream) return localStream;
  return defaultStore.streamEvidence(ref, slot);
}

/**
 * In-memory fake implementation of `BuildEvidenceStore` for unit and route
 * tests (`VT-17`, `VT-20`).
 */
export function createInMemoryEvidenceStore(
  defaultContainer: string = DEFAULT_ARTIFACT_CONTAINER,
): InMemoryEvidenceStore {
  const blobs = new Map<string, string>();

  return {
    blobs,

    async putEvidence(
      prefix: string,
      slot: EvidenceSlot,
      text: string,
      container: string = defaultContainer,
    ): Promise<ArtifactRef> {
      const cleanPrefix = normalizePrefix(prefix);
      const blobKey = buildEvidenceBlobKey(cleanPrefix, slot);
      blobs.set(blobKey, text);
      blobs.set(`${container}:${blobKey}`, text);
      return {
        container,
        key: cleanPrefix,
      };
    },

    async streamEvidence(
      ref: ArtifactRef,
      slot: EvidenceSlot,
    ): Promise<NodeJS.ReadableStream | null> {
      const blobKey = buildEvidenceBlobKey(ref.key, slot);
      const text = blobs.get(`${ref.container}:${blobKey}`) ?? blobs.get(blobKey);
      if (text === undefined) {
        return null;
      }
      return Readable.from([Buffer.from(text, 'utf8')]);
    },

    getText(refOrPrefix: ArtifactRef | string, slot: EvidenceSlot): string | null {
      if (typeof refOrPrefix === 'string') {
        const blobKey = buildEvidenceBlobKey(refOrPrefix, slot);
        return blobs.get(blobKey) ?? null;
      }
      const blobKey = buildEvidenceBlobKey(refOrPrefix.key, slot);
      return blobs.get(`${refOrPrefix.container}:${blobKey}`) ?? blobs.get(blobKey) ?? null;
    },
  };
}
