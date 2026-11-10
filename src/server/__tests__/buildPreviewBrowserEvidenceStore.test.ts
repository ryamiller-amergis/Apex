import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createLocalBrowserEvidenceStore } from '../services/build/buildPreviewBrowserEvidenceStore';

describe('local browser evidence store', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-evidence-'));
  });

  afterEach(async () => {
    await fs.rm(root, { force: true, recursive: true });
  });

  it('atomically stores evidence below the configured root', async () => {
    const store = createLocalBrowserEvidenceStore({ root });

    const ref = await store.put({
      checkId: '8f661f80-81e2-4ab6-80b5-7cdf44dd84e0',
      name: 'browser-check.json',
      bytes: Buffer.from('{"status":"passed"}'),
      contentType: 'application/json',
    });

    expect(ref).toEqual({
      container: 'build-preview-browser-evidence',
      key: '8f661f80-81e2-4ab6-80b5-7cdf44dd84e0/browser-check.json',
    });
    await expect(
      fs.readFile(
        path.join(
          root,
          'build-preview-browser-evidence',
          '8f661f80-81e2-4ab6-80b5-7cdf44dd84e0',
          'browser-check.json'
        ),
        'utf8'
      )
    ).resolves.toBe('{"status":"passed"}');
    await expect(
      fs.readdir(
        path.join(
          root,
          'build-preview-browser-evidence',
          '8f661f80-81e2-4ab6-80b5-7cdf44dd84e0'
        )
      )
    ).resolves.toEqual(['browser-check.json']);
  });

  it.each([
    ['../outside', 'browser-check.json'],
    ['check/child', 'browser-check.json'],
    ['check-1', '../outside.json'],
    ['check-1', 'nested/file.json'],
    ['check-1', 'unexpected.txt'],
  ])('rejects unsafe evidence paths (%s, %s)', async (checkId, name) => {
    const store = createLocalBrowserEvidenceStore({ root });

    await expect(
      store.put({
        checkId,
        name: name as 'screenshot.png' | 'browser-check.json',
        bytes: Buffer.from('evidence'),
        contentType: 'application/json',
      })
    ).rejects.toThrow(/evidence/i);
  });

  it('rejects oversized evidence and mismatched content types', async () => {
    const store = createLocalBrowserEvidenceStore({ root });
    const base = {
      checkId: 'check-1',
      name: 'browser-check.json' as const,
    };

    await expect(
      store.put({
        ...base,
        bytes: Buffer.alloc(1024 * 1024 + 1),
        contentType: 'application/json',
      })
    ).rejects.toThrow(/evidence/i);
    await expect(
      store.put({
        ...base,
        bytes: Buffer.from('{}'),
        contentType: 'image/png',
      })
    ).rejects.toThrow(/evidence/i);
  });
});
