import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import { AzureCliCredential, ManagedIdentityCredential } from '@azure/identity';
import type {
  PlaybookStepBlobRef,
  PlaybookStepOutputEnvelope,
} from '../../shared/types/playbook';
import { resolveDataRoot } from '../utils/dataDir';

export const PLAYBOOK_STEP_OUTPUT_CONTAINER = 'playbook-step-outputs';
export const DEFAULT_INLINE_OUTPUT_MAX_BYTES = 32_768;

export class PlaybookStepOutputVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaybookStepOutputVerificationError';
  }
}

export interface PlaybookStepOutputBackend {
  write(key: string, body: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  list(): Promise<Array<{ key: string; lastModifiedMs: number }>>;
}

function localOutputRoot(): string {
  return path.join(resolveDataRoot(), 'playbook-step-outputs');
}

async function listLocalFiles(
  root: string,
  prefix = ''
): Promise<Array<{ key: string; lastModifiedMs: number }>> {
  let entries: Array<import('node:fs').Dirent>;
  try {
    entries = await fs.readdir(path.join(root, ...prefix.split('/').filter(Boolean)), {
      withFileTypes: true,
    });
  } catch {
    return [];
  }
  const keys: Array<{ key: string; lastModifiedMs: number }> = [];
  for (const entry of entries) {
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) keys.push(...(await listLocalFiles(root, key)));
    else {
      const stat = await fs.stat(path.join(root, ...key.split('/')));
      keys.push({ key, lastModifiedMs: stat.mtimeMs });
    }
  }
  return keys;
}

function localBackend(): PlaybookStepOutputBackend {
  return {
    async write(key, body) {
      const target = path.join(localOutputRoot(), ...key.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, body);
    },
    read(key) {
      return fs.readFile(path.join(localOutputRoot(), ...key.split('/')));
    },
    async delete(key) {
      await fs.rm(path.join(localOutputRoot(), ...key.split('/')), { force: true });
    },
    list() {
      return listLocalFiles(localOutputRoot());
    },
  };
}

function blobBackend(container: ContainerClient): PlaybookStepOutputBackend {
  return {
    async write(key, body) {
      await container.getBlockBlobClient(key).uploadData(body, {
        blobHTTPHeaders: { blobContentType: 'application/json' },
      });
    },
    read(key) {
      return container.getBlockBlobClient(key).downloadToBuffer();
    },
    async delete(key) {
      await container.getBlockBlobClient(key).deleteIfExists();
    },
    async list() {
      const keys: Array<{ key: string; lastModifiedMs: number }> = [];
      for await (const blob of container.listBlobsFlat()) {
        keys.push({
          key: blob.name,
          lastModifiedMs: blob.properties.lastModified?.getTime() ?? 0,
        });
      }
      return keys;
    },
  };
}

/** Shared-account name already configured for Apex, with an explicit override first. */
export function resolvePlaybookStepOutputAccount(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  return (
    env.PLAYBOOK_STEP_OUTPUT_BLOB_ACCOUNT_NAME?.trim()
    || env.GROUNDING_BLOB_ACCOUNT_NAME?.trim()
    || env.PDF_BLOB_ACCOUNT_NAME?.trim()
    || undefined
  );
}

function sharedBlobBackend(account: string): PlaybookStepOutputBackend {
  const credential = process.env.NODE_ENV === 'production'
    ? new ManagedIdentityCredential()
    : new AzureCliCredential();
  return blobBackend(
    new BlobServiceClient(`https://${account}.blob.core.windows.net`, credential)
      .getContainerClient(PLAYBOOK_STEP_OUTPUT_CONTAINER)
  );
}

function defaultBackend(): PlaybookStepOutputBackend {
  const account = resolvePlaybookStepOutputAccount();
  if (account) return sharedBlobBackend(account);
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'A shared Blob account is required for Playbook step-output storage'
    );
  }
  return localBackend();
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)])
    );
  }
  return value;
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(canonical(value)), 'utf8');
}

export function playbookStepOutputSizeBytes(value: unknown): number {
  return canonicalBytes(value).byteLength;
}

function safeKeySegment(value: string): string {
  return encodeURIComponent(value).replace(/\./g, '%2E');
}

const SUMMARY_FIELDS = new Set([
  'agentRunId',
  'completedAt',
  'continuation',
  'error',
  'isReady',
  'matched',
  'notificationId',
  'outcome',
  'recipientUserId',
  'status',
  'threadId',
  'verdict',
]);

export function summarizePlaybookStepOutput(
  output: Record<string, unknown>,
  sizeBytes = playbookStepOutputSizeBytes(output),
  spilled = false
): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    spilled,
    sizeBytes,
    fields: Object.keys(output).sort(),
  };
  for (const [key, value] of Object.entries(output)) {
    if (
      SUMMARY_FIELDS.has(key)
      && (value === null || ['string', 'number', 'boolean'].includes(typeof value))
    ) {
      summary[key] = value;
    }
  }
  return summary;
}

export function inlineOutputMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.PLAYBOOK_STEP_OUTPUT_INLINE_MAX_BYTES);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_INLINE_OUTPUT_MAX_BYTES;
}

export interface PersistPlaybookStepOutputInput {
  project: string;
  runId: string;
  stepRunId: string;
  stepId: string;
  stepType: string;
  completedAt: string;
  output: Record<string, unknown>;
}

export interface PersistedPlaybookStepOutput {
  outputInline: Record<string, unknown>;
  outputBlobRef: PlaybookStepBlobRef | null;
}

export function createPlaybookStepOutputStore(options?: {
  backend?: PlaybookStepOutputBackend;
  thresholdBytes?: number;
}) {
  const backend = options?.backend ?? defaultBackend();
  const threshold = options?.thresholdBytes ?? inlineOutputMaxBytes();

  return {
    async persist(
      input: PersistPlaybookStepOutputInput
    ): Promise<PersistedPlaybookStepOutput> {
      const outputBytes = canonicalBytes(input.output);
      if (outputBytes.byteLength <= threshold) {
        return { outputInline: input.output, outputBlobRef: null };
      }

      const envelope: PlaybookStepOutputEnvelope = {
        schemaVersion: 1,
        project: input.project,
        runId: input.runId,
        stepRunId: input.stepRunId,
        stepId: input.stepId,
        stepType: input.stepType,
        completedAt: input.completedAt,
        output: input.output,
      };
      const body = canonicalBytes(envelope);
      const sha256 = createHash('sha256').update(body).digest('hex');
      const key = [
        safeKeySegment(input.project),
        safeKeySegment(input.runId),
        safeKeySegment(input.stepRunId),
        `output-v1-${sha256}.json`,
      ].join('/');
      const reference: PlaybookStepBlobRef = {
        schemaVersion: 1,
        container: PLAYBOOK_STEP_OUTPUT_CONTAINER,
        key,
        sha256,
        sizeBytes: body.byteLength,
        contentType: 'application/json',
      };
      await backend.write(key, body);
      return {
        outputInline: summarizePlaybookStepOutput(
          input.output,
          outputBytes.byteLength,
          true
        ),
        outputBlobRef: reference,
      };
    },

    async load(reference: PlaybookStepBlobRef): Promise<PlaybookStepOutputEnvelope> {
      if (reference.container !== PLAYBOOK_STEP_OUTPUT_CONTAINER) {
        throw new PlaybookStepOutputVerificationError('Unexpected Playbook output container');
      }
      const body = await backend.read(reference.key);
      const digest = createHash('sha256').update(body).digest('hex');
      if (digest !== reference.sha256 || body.byteLength !== reference.sizeBytes) {
        throw new PlaybookStepOutputVerificationError(
          `Playbook output ${reference.key} failed checksum verification`
        );
      }
      const parsed = JSON.parse(body.toString('utf8')) as PlaybookStepOutputEnvelope;
      if (parsed.schemaVersion !== 1 || !parsed.output || typeof parsed.output !== 'object') {
        throw new PlaybookStepOutputVerificationError(
          `Playbook output ${reference.key} does not match the envelope contract`
        );
      }
      return parsed;
    },

    delete(reference: PlaybookStepBlobRef): Promise<void> {
      return backend.delete(reference.key);
    },

    listKeys(): Promise<Array<{ key: string; lastModifiedMs: number }>> {
      return backend.list();
    },
  };
}

export type PlaybookStepOutputStore = ReturnType<typeof createPlaybookStepOutputStore>;
