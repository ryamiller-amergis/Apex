/**
 * @jest-environment node
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  deletePinRef,
  pinRefName,
  writePinRef,
} from '../services/repoRead/pinRefs';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

describe('pinRefs', () => {
  it('writes and deletes refs/apex/pins/<sha> on a bare mirror', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-pin-refs-'));
    const work = path.join(root, 'work');
    const bare = path.join(root, 'bare.git');
    try {
      fs.mkdirSync(work);
      fs.writeFileSync(path.join(work, 'README.md'), 'pin\n');
      git(work, ['init']);
      git(work, ['config', 'user.name', 'Apex Test']);
      git(work, ['config', 'user.email', 'apex-test@example.com']);
      git(work, ['add', '.']);
      git(work, ['commit', '-m', 'pin']);
      const sha = git(work, ['rev-parse', 'HEAD']);
      git(root, ['clone', '--bare', work, bare]);

      await writePinRef(bare, sha);
      expect(git(bare, ['show-ref', pinRefName(sha)])).toContain(sha);

      await deletePinRef(bare, sha);
      expect(() => git(bare, ['show-ref', pinRefName(sha)])).toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
