import { randomBytes } from 'crypto';
import { BlobServiceClient } from '@azure/storage-blob';
import { AzureCliCredential, ManagedIdentityCredential } from '@azure/identity';

export const CURSOR_PROMPT_CONTAINER = 'cursor-prompts';

export function cursorPromptBlobName(): string {
  return `prompts/${randomBytes(16).toString('hex')}.txt`;
}

export function resolveCursorPromptBlobAccount(): string {
  const account = process.env.CURSOR_PROMPT_BLOB_ACCOUNT_NAME?.trim()
    || process.env.GROUNDING_BLOB_ACCOUNT_NAME?.trim()
    || process.env.PDF_BLOB_ACCOUNT_NAME?.trim();
  if (!account) {
    throw new Error('Shared blob account is not configured for cloud-agent prompts');
  }
  return account;
}

export function cursorPromptBlobUrl(accountName: string, blobName: string): string {
  const container = process.env.CURSOR_PROMPT_BLOB_CONTAINER_NAME?.trim() || CURSOR_PROMPT_CONTAINER;
  return `https://${accountName}.blob.core.windows.net/${container}/${blobName}`;
}

/** Stores the Apex-built prompt where the worker can read it. The container env only receives the URL. */
export async function uploadCursorPrompt(prompt: string): Promise<string> {
  const accountName = resolveCursorPromptBlobAccount();
  const blobName = cursorPromptBlobName();
  const container = process.env.CURSOR_PROMPT_BLOB_CONTAINER_NAME?.trim() || CURSOR_PROMPT_CONTAINER;
  const credential = process.env.NODE_ENV === 'production'
    ? new ManagedIdentityCredential()
    : new AzureCliCredential();
  const service = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, credential);
  const blob = service.getContainerClient(container).getBlockBlobClient(blobName);
  const body = Buffer.from(prompt, 'utf8');
  await blob.uploadData(body, {
    blobHTTPHeaders: { blobContentType: 'text/plain; charset=utf-8' },
  });
  return cursorPromptBlobUrl(accountName, blobName);
}
