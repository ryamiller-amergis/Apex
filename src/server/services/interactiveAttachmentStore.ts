import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ContainerClient } from '@azure/storage-blob';
import type { ChatAttachment } from '../../shared/types/chat';
import {
  isCanonicalUuid,
  type ImmutableInteractiveAttachmentRef,
} from '../../shared/types/durableInteractiveTurn';
import {
  artifactContainerName,
  resolveArtifactContainerClient,
} from './aiRunV2/artifactContainer';

const DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export class InteractiveAttachmentError extends Error {
  constructor(
    readonly code:
      | 'INTERACTIVE_V2_ATTACHMENT_UNSUPPORTED'
      | 'INTERACTIVE_V2_ATTACHMENT_SIZE_MISMATCH'
      | 'TURN_ID_CONFLICT',
    readonly status: 400 | 409 | 415,
  ) {
    super(code);
    this.name = 'InteractiveAttachmentError';
  }
}

export interface InteractiveAttachmentStore {
  upload(input: {
    threadId: string;
    turnId: string;
    attachmentIndex?: number;
    attachment: ChatAttachment;
  }): Promise<ImmutableInteractiveAttachmentRef>;
}

function sanitizeAttachmentName(name: string): string {
  const fallback = 'attachment-1.txt';
  const baseName = path.basename(name || fallback);
  const sanitized = baseName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return sanitized || fallback;
}

function normalizedContentType(contentType: string): string {
  return contentType.split(';', 1)[0].trim().toLowerCase();
}

function isSupportedContentType(contentType: string): boolean {
  const normalized = normalizedContentType(contentType);
  return (
    normalized.startsWith('text/') ||
    normalized.startsWith('image/') ||
    normalized === DOCX_CONTENT_TYPE
  );
}

function decodeBase64(value: string): Buffer {
  const normalized = value.replace(/\s+/g, '');
  if (
    normalized.length === 0 ||
    normalized.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  ) {
    throw new InteractiveAttachmentError(
      'INTERACTIVE_V2_ATTACHMENT_SIZE_MISMATCH',
      400,
    );
  }
  const decoded = Buffer.from(normalized, 'base64');
  if (
    decoded.toString('base64').replace(/=+$/, '') !==
    normalized.replace(/=+$/, '')
  ) {
    throw new InteractiveAttachmentError(
      'INTERACTIVE_V2_ATTACHMENT_SIZE_MISMATCH',
      400,
    );
  }
  return decoded;
}

function attachmentBytes(attachment: ChatAttachment): Buffer {
  if (!Number.isSafeInteger(attachment.size) || attachment.size < 0) {
    throw new InteractiveAttachmentError(
      'INTERACTIVE_V2_ATTACHMENT_SIZE_MISMATCH',
      400,
    );
  }
  const bytes =
    attachment.encoding === 'base64'
      ? decodeBase64(attachment.content)
      : Buffer.from(attachment.content, 'utf8');
  if (bytes.byteLength !== attachment.size) {
    throw new InteractiveAttachmentError(
      'INTERACTIVE_V2_ATTACHMENT_SIZE_MISMATCH',
      400,
    );
  }
  return bytes;
}

function isAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    statusCode?: unknown;
    code?: unknown;
    errorCode?: unknown;
  };
  return (
    candidate.statusCode === 409 ||
    candidate.statusCode === 412 ||
    candidate.code === 'BlobAlreadyExists' ||
    candidate.code === 'ConditionNotMet' ||
    candidate.errorCode === 'BlobAlreadyExists' ||
    candidate.errorCode === 'ConditionNotMet'
  );
}

function metadataValue(
  metadata: Record<string, string> | undefined,
  key: string,
): string | undefined {
  const normalizedKey = key.toLowerCase();
  return Object.entries(metadata ?? {}).find(
    ([candidate]) => candidate.toLowerCase() === normalizedKey,
  )?.[1];
}

export function createInteractiveAttachmentStore(options?: {
  container?: ContainerClient;
}): InteractiveAttachmentStore {
  const containerName =
    options?.container?.containerName || artifactContainerName();
  const container =
    options?.container ?? resolveArtifactContainerClient(containerName);

  return {
    async upload(input) {
      const attachmentIndex = input.attachmentIndex ?? 0;
      if (
        !isCanonicalUuid(input.threadId) ||
        !isCanonicalUuid(input.turnId) ||
        !isCanonicalUuid(input.attachment.id) ||
        !Number.isSafeInteger(attachmentIndex) ||
        attachmentIndex < 0
      ) {
        throw new InteractiveAttachmentError(
          'INTERACTIVE_V2_ATTACHMENT_SIZE_MISMATCH',
          400,
        );
      }
      if (!isSupportedContentType(input.attachment.type)) {
        throw new InteractiveAttachmentError(
          'INTERACTIVE_V2_ATTACHMENT_UNSUPPORTED',
          415,
        );
      }

      const bytes = attachmentBytes(input.attachment);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const key = [
        'interactive',
        input.threadId,
        input.turnId,
        input.attachment.id,
        sha256,
      ].join('/');
      const blockBlob = container.getBlockBlobClient(key);

      try {
        await blockBlob.uploadData(bytes, {
          conditions: { ifNoneMatch: '*' },
          blobHTTPHeaders: {
            blobContentType: input.attachment.type,
          },
          metadata: {
            sha256,
            sizeBytes: String(bytes.byteLength),
          },
        });
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
        const properties = await blockBlob.getProperties();
        const storedSha256 = metadataValue(properties.metadata, 'sha256');
        const storedSize = metadataValue(properties.metadata, 'sizeBytes');
        if (
          storedSha256 !== sha256 ||
          storedSize !== String(bytes.byteLength)
        ) {
          throw new InteractiveAttachmentError('TURN_ID_CONFLICT', 409);
        }
      }

      return {
        attachmentId: input.attachment.id,
        name: input.attachment.name,
        contentType: input.attachment.type,
        sizeBytes: bytes.byteLength,
        sha256,
        blobRef: {
          container: containerName,
          key,
        },
        materializedPath: path.posix.join(
          '.ai-pilot',
          'attachments',
          input.turnId,
          `${String(attachmentIndex + 1).padStart(2, '0')}-${sanitizeAttachmentName(input.attachment.name)}`,
        ),
      };
    },
  };
}
