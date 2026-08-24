/**
 * @jest-environment node
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BareRepoReader } from '../services/repoRead/bareRepoReader';
import { handleRepoReadRequest } from '../services/repoRead/httpHandler';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function makeBareFixture(): { root: string; bare: string; sha: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-repo-http-'));
  const work = path.join(root, 'work');
  const bare = path.join(root, 'bare.git');
  fs.mkdirSync(work);
  fs.mkdirSync(path.join(work, 'src'));
  fs.writeFileSync(path.join(work, 'README.md'), 'fixture\n');
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

describe('repo-read HTTP handler', () => {
  it('reads, lists, searches, and denies path escape against a bare mirror', async () => {
    const fixture = makeBareFixture();
    const reader = new BareRepoReader({
      identity: {
        provider: 'ado',
        project: 'Apex',
        repo: 'reader-fixture',
        sha: fixture.sha,
      },
      mirrorPath: fixture.bare,
    });

    try {
      const identity = {
        provider: 'ado' as const,
        project: 'Apex',
        repo: 'reader-fixture',
        sha: fixture.sha,
      };
      const deps = { readerFor: async () => reader };

      const read = await handleRepoReadRequest(
        'read',
        { ...identity, path: 'README.md' },
        deps,
      );
      expect(read).toMatchObject({
        status: 200,
        body: { ok: true, operation: 'read', content: 'fixture\n' },
      });

      const list = await handleRepoReadRequest(
        'list',
        { ...identity, path: 'src' },
        deps,
      );
      expect(list.status).toBe(200);
      expect(list.body).toMatchObject({ ok: true, operation: 'list' });
      if (list.body.ok === true && list.body.operation === 'list') {
        expect(list.body.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'index.ts', isFolder: false }),
          ]),
        );
      }

      const search = await handleRepoReadRequest(
        'search',
        { ...identity, query: 'needle' },
        deps,
      );
      expect(search.status).toBe(200);
      expect(search.body).toMatchObject({ ok: true, operation: 'search' });

      const denied = await handleRepoReadRequest(
        'read',
        { ...identity, path: '../secret' },
        deps,
      );
      expect(denied).toMatchObject({
        status: 403,
        body: { ok: false, code: 'ACCESS_DENIED' },
      });

      const badSha = await handleRepoReadRequest(
        'read',
        { ...identity, sha: 'not-a-sha' },
        deps,
      );
      expect(badSha.status).toBe(400);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
