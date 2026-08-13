/**
 * @jest-environment node
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BareRepoReader } from '../services/repoRead/bareRepoReader';
import { RepoReaderError } from '../services/repoReader';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function makeBareFixture(): { root: string; bare: string; sha: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-bare-reader-'));
  const work = path.join(root, 'work');
  const bare = path.join(root, 'bare.git');
  fs.mkdirSync(work);
  fs.mkdirSync(path.join(work, 'src'));
  fs.writeFileSync(path.join(work, 'README.md'), 'fixture\n');
  fs.writeFileSync(path.join(work, 'empty.txt'), '');
  fs.writeFileSync(path.join(work, 'src', 'index.ts'), 'export const needle = true;\n');
  git(work, ['init']);
  git(work, ['config', 'user.name', 'Apex Test']);
  git(work, ['config', 'user.email', 'apex-test@example.com']);
  git(work, ['add', '.']);
  git(work, ['commit', '-m', 'fixture']);
  const sha = git(work, ['rev-parse', 'HEAD']);
  git(root, ['clone', '--bare', work, bare]);
  return { root, bare, sha };
}

describe('BareRepoReader', () => {
  it('reads, lists, and searches a pinned commit from a bare mirror', async () => {
    const fixture = makeBareFixture();
    try {
      const reader = new BareRepoReader({
        identity: {
          provider: 'ado',
          project: 'Apex',
          repo: 'reader-fixture',
          sha: fixture.sha,
        },
        mirrorPath: fixture.bare,
      });

      await expect(reader.readFile('README.md')).resolves.toBe('fixture\n');
      await expect(reader.readFile('/README.md')).resolves.toBe('fixture\n');
      await expect(reader.readFile('empty.txt')).resolves.toBe('');

      const entries = await reader.listDir('src');
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'index.ts',
            isFolder: false,
            path: '/src/index.ts',
          }),
        ]),
      );

      const matches = await reader.searchCode('needle');
      expect(matches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: '/src/index.ts',
            matches: [expect.objectContaining({ snippet: expect.stringContaining('needle') })],
          }),
        ]),
      );

      await expect(reader.searchCode('definitely-not-present')).resolves.toEqual([]);
      await expect(reader.readFile('../secret')).rejects.toMatchObject({
        code: 'ACCESS_DENIED',
      });
      expect(RepoReaderError).toBeDefined();
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
