import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ArtifactRef } from '../../../shared/types/build';
import { resolveDataRoot } from '../../utils/dataDir';
import type { BrowserEvidenceStore } from './buildPreviewBrowserVerifier';

const CONTAINER = 'build-preview-browser-evidence';
const EVIDENCE_NAMES = new Set(['browser-check.json', 'screenshot.png']);
const CHECK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const MAX_EVIDENCE_BYTES = {
  'browser-check.json': 1024 * 1024,
  'screenshot.png': 10 * 1024 * 1024,
} as const;
const EVIDENCE_CONTENT_TYPES = {
  'browser-check.json': 'application/json',
  'screenshot.png': 'image/png',
} as const;

export function createLocalBrowserEvidenceStore(options?: {
  root?: string;
}): BrowserEvidenceStore {
  const root = path.resolve(options?.root ?? resolveDataRoot());

  return {
    async put(input): Promise<ArtifactRef> {
      const knownName = EVIDENCE_NAMES.has(input.name);
      if (
        !CHECK_ID_PATTERN.test(input.checkId) ||
        !knownName ||
        input.bytes.length === 0 ||
        input.bytes.length > MAX_EVIDENCE_BYTES[input.name] ||
        input.contentType !== EVIDENCE_CONTENT_TYPES[input.name]
      ) {
        throw new Error('Invalid browser evidence path or content.');
      }

      const directory = path.join(root, CONTAINER, input.checkId);
      const destination = path.join(directory, input.name);
      const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
      await mkdir(directory, { recursive: true });

      try {
        await writeFile(temporary, input.bytes, { flag: 'wx' });
        await rename(temporary, destination);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }

      return {
        container: CONTAINER,
        key: `${input.checkId}/${input.name}`,
      };
    },
  };
}
