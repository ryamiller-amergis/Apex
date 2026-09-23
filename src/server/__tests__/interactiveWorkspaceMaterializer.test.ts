import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { RepoDirEntry, RepoReader } from '../../shared/types/repoReader';
import type { ImmutableInteractiveAttachmentRef } from '../../shared/types/durableInteractiveTurn';
import { materializeInteractiveWorkspace } from '../services/interactiveActorHost/interactiveWorkspaceMaterializer';

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function makeReader(files: Record<string, string>): RepoReader {
  const normalized = Object.fromEntries(
    Object.entries(files).map(([key, value]) => [
      key.replace(/\\/g, '/').replace(/^\.\//, ''),
      value,
    ]),
  );

  return {
    identity: {
      provider: 'ado',
      project: 'Apex',
      repo: 'repo',
      sha: 'abc123',
    },
    async listDir(dirPath: string): Promise<RepoDirEntry[]> {
      const prefix = dirPath.replace(/\\/g, '/').replace(/\/$/, '');
      const children = new Map<string, RepoDirEntry>();
      for (const filePath of Object.keys(normalized)) {
        if (prefix && !filePath.startsWith(`${prefix}/`) && filePath !== prefix) {
          continue;
        }
        const rest = prefix ? filePath.slice(prefix.length + 1) : filePath;
        if (!rest) continue;
        const [name, ...tail] = rest.split('/');
        if (!name || children.has(name)) continue;
        children.set(name, {
          path: prefix ? `${prefix}/${name}` : name,
          name,
          isFolder: tail.length > 0,
        });
      }
      return [...children.values()];
    },
    async readFile(filePath: string): Promise<string> {
      const key = filePath.replace(/\\/g, '/');
      const content = normalized[key];
      if (content === undefined) throw new Error(`missing ${key}`);
      return content;
    },
    async searchCode() {
      return [];
    },
  };
}

describe('interactiveWorkspaceMaterializer', () => {
  let destination: string;

  beforeEach(async () => {
    destination = await fs.mkdtemp(path.join(os.tmpdir(), 'interactive-ws-'));
  });

  afterEach(async () => {
    await fs.rm(destination, { recursive: true, force: true });
  });

  it('materializes only paths returned for the pinned SHA', async () => {
    const attachmentBytes = Buffer.from('hello', 'utf8');
    const attachmentRef: ImmutableInteractiveAttachmentRef = {
      attachmentId: '11111111-1111-4111-8111-111111111111',
      name: 'notes.txt',
      contentType: 'text/plain',
      sizeBytes: attachmentBytes.byteLength,
      sha256: sha256(attachmentBytes),
      blobRef: { container: 'artifacts', key: 'interactive/notes' },
      materializedPath: '.ai-pilot/attachments/turn-1/notes.txt',
    };
    const pinnedReader = makeReader({
      'src/a.ts': 'export const a = 1;',
      'README.md': '# hi',
    });
    const signal = new AbortController().signal;

    await materializeInteractiveWorkspace({
      reader: pinnedReader,
      destination,
      attachments: [attachmentRef],
      readAttachment: async () => attachmentBytes,
      signal,
    });

    expect(await fs.readFile(path.join(destination, 'src/a.ts'), 'utf8')).toBe(
      'export const a = 1;',
    );
    expect(
      await fs.readFile(
        path.join(destination, '.ai-pilot/attachments/turn-1/notes.txt'),
        'utf8',
      ),
    ).toBe('hello');
    expect(await fs.readFile(path.join(destination, 'README.md'), 'utf8')).toBe(
      '# hi',
    );
  });

  it('creates an empty workspace when no reader is supplied', async () => {
    const signal = new AbortController().signal;
    await materializeInteractiveWorkspace({
      reader: null,
      destination,
      attachments: [],
      readAttachment: async () => Buffer.alloc(0),
      signal,
    });
    const entries = await fs.readdir(destination);
    expect(entries).toEqual([]);
  });

  it('rejects parent traversal in attachment paths and removes the destination', async () => {
    const attachmentBytes = Buffer.from('x', 'utf8');
    const attachmentRef: ImmutableInteractiveAttachmentRef = {
      attachmentId: '22222222-2222-4222-8222-222222222222',
      name: 'evil.txt',
      contentType: 'text/plain',
      sizeBytes: 1,
      sha256: sha256(attachmentBytes),
      blobRef: { container: 'artifacts', key: 'interactive/evil' },
      materializedPath: '../escape.txt',
    };

    await expect(
      materializeInteractiveWorkspace({
        reader: null,
        destination,
        attachments: [attachmentRef],
        readAttachment: async () => attachmentBytes,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/traversal|escape|invalid/i);

    await expect(fs.access(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('aborts when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      materializeInteractiveWorkspace({
        reader: makeReader({ 'a.ts': '1' }),
        destination,
        attachments: [],
        readAttachment: async () => Buffer.alloc(0),
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    await expect(fs.access(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
