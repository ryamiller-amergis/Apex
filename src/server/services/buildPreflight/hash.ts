import { createHash } from 'node:crypto';

/** SHA-256 of the file's UTF-8 text, as 64 lowercase hex characters. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
