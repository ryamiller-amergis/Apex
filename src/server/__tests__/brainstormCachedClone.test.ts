import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { git } from '../utils/asyncGit';
import { cloneCachedCommit } from '../services/brainstorm/gitSourceClone';

const identity = ['-c', 'user.email=test@example.com', '-c', 'user.name=Test'];

jest.setTimeout(30_000);

describe('cloneCachedCommit', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'brainstorm-cached-clone-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('copies a depth-1 mirror instead of cloning it again', async () => {
    const origin = path.join(root, 'origin');
    const mirror = path.join(root, 'mirror');
    const session = path.join(root, 'session');
    await git(['init', '-b', 'main', origin]);
    await writeFile(path.join(origin, 'README.md'), 'hello\n');
    await git(['-C', origin, ...identity, 'add', 'README.md']);
    await git(['-C', origin, ...identity, 'commit', '-m', 'init']);
    await git(['clone', '--depth', '1', '--single-branch', '--branch', 'main', '--', origin, mirror]);
    const sha = (await git(['-C', mirror, 'rev-parse', 'HEAD'])).trim();

    await cloneCachedCommit({
      cacheDir: mirror,
      destination: session,
      sha,
      signal: AbortSignal.timeout(30_000),
    });

    expect((await readFile(path.join(session, 'README.md'), 'utf8')).trim()).toBe('hello');
    expect((await git(['-C', session, 'rev-parse', 'HEAD'])).trim().toLowerCase()).toBe(sha.toLowerCase());
    await expect(git(['-C', session, 'remote'])).resolves.toBe('');
  });

  it('refuses the copy when the mirror commit is not the one the session asked for', async () => {
    const origin = path.join(root, 'origin');
    const mirror = path.join(root, 'mirror');
    const session = path.join(root, 'session');
    await git(['init', '-b', 'main', origin]);
    await writeFile(path.join(origin, 'README.md'), 'hello\n');
    await git(['-C', origin, ...identity, 'add', 'README.md']);
    await git(['-C', origin, ...identity, 'commit', '-m', 'init']);
    await git(['clone', '--depth', '1', '--single-branch', '--branch', 'main', '--', origin, mirror]);

    await expect(cloneCachedCommit({
      cacheDir: mirror,
      destination: session,
      sha: 'a'.repeat(40),
      signal: AbortSignal.timeout(30_000),
    })).rejects.toThrow(/saved clone changed/);
    await expect(readFile(path.join(session, 'README.md'), 'utf8')).rejects.toThrow();
  });
});
