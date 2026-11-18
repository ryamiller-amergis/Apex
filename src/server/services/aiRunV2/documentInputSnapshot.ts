/**
 * Document-run input files that exist nowhere but the thread workspace (the
 * test-case PRD/backlog and the QA Lab Azure DevOps snapshot). They are saved
 * to Blob when the run is set up, so a V2 run never reads the workspace share.
 */
import { type ContainerClient } from '@azure/storage-blob';
import type { AiRunV2DocumentScratchInput } from '../../../shared/types/aiRunV2DocumentSpec';
import {
  artifactContainerName,
  resolveArtifactContainerClient,
} from './artifactContainer';

export type DocumentInputSnapshotStore = {
  /** Returns false when Blob storage is not configured. */
  save(threadId: string, inputs: AiRunV2DocumentScratchInput[]): Promise<boolean>;
  /** Returns null when there is no snapshot or Blob storage is not configured. */
  read(threadId: string): Promise<AiRunV2DocumentScratchInput[] | null>;
  remove(threadId: string): Promise<void>;
};

export function documentInputSnapshotKey(threadId: string): string {
  return `document-inputs/${threadId}.json`;
}

function isBlobConfigured(): boolean {
  return Boolean(process.env.AI_PLATFORM_V2_BLOB_ACCOUNT_NAME?.trim()) && !process.env.JEST_WORKER_ID;
}

function isNotFound(error: unknown): boolean {
  return (error as { statusCode?: number } | null)?.statusCode === 404;
}

function parseInputs(raw: string): AiRunV2DocumentScratchInput[] | null {
  const parsed: unknown = JSON.parse(raw);
  const inputs = (parsed as { inputs?: unknown } | null)?.inputs;
  if (!Array.isArray(inputs)) return null;
  return inputs.filter(
    (entry): entry is AiRunV2DocumentScratchInput =>
      typeof (entry as { path?: unknown })?.path === 'string'
      && typeof (entry as { content?: unknown })?.content === 'string',
  );
}

export function createDocumentInputSnapshotStore(options?: {
  getContainerClient?: (containerName: string) => ContainerClient;
  containerName?: string;
  isConfigured?: () => boolean;
}): DocumentInputSnapshotStore {
  const isConfigured = options?.isConfigured ?? isBlobConfigured;
  const blob = (threadId: string) =>
    (options?.getContainerClient ?? resolveArtifactContainerClient)(
      options?.containerName ?? artifactContainerName(),
    ).getBlockBlobClient(documentInputSnapshotKey(threadId));

  return {
    async save(threadId, inputs) {
      if (!isConfigured()) return false;
      const body = Buffer.from(
        JSON.stringify({ threadId, savedAt: new Date().toISOString(), inputs }),
        'utf8',
      );
      await blob(threadId).uploadData(body, {
        blobHTTPHeaders: { blobContentType: 'application/json' },
      });
      return true;
    },
    async read(threadId) {
      if (!isConfigured()) return null;
      try {
        const raw = await blob(threadId).downloadToBuffer();
        return parseInputs(raw.toString('utf8'));
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async remove(threadId) {
      if (!isConfigured()) return;
      await blob(threadId).deleteIfExists();
    },
  };
}

let defaultStore: DocumentInputSnapshotStore | null = null;

function store(): DocumentInputSnapshotStore {
  defaultStore ??= createDocumentInputSnapshotStore();
  return defaultStore;
}

/**
 * Saves the snapshot for the run about to start. A failed save removes any
 * older snapshot, so the run falls back to the workspace files instead of
 * reading stale ones.
 */
export async function saveDocumentInputSnapshot(
  threadId: string,
  inputs: AiRunV2DocumentScratchInput[],
): Promise<void> {
  try {
    await store().save(threadId, inputs);
  } catch (error) {
    console.warn(
      `[documentInputs] Snapshot save failed (threadId=${threadId}): ${error instanceof Error ? error.message : String(error)}`,
    );
    await store().remove(threadId).catch(() => undefined);
  }
}

export function readDocumentInputSnapshot(
  threadId: string,
): Promise<AiRunV2DocumentScratchInput[] | null> {
  return store().read(threadId);
}
