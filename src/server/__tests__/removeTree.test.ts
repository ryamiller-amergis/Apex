import fs from 'fs';
import os from 'os';
import path from 'path';
import { removeTree } from '../utils/removeTree';

describe('removeTree', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'remove-tree-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('deletes a nested directory tree', async () => {
    const target = path.join(root, 'workspace');
    fs.mkdirSync(path.join(target, 'src', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(target, 'src', 'deep', 'a.ts'), 'a');
    fs.writeFileSync(path.join(target, 'README.md'), 'b');

    await removeTree(target);

    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(root)).toBe(true);
  });

  it('resolves when the path does not exist', async () => {
    await expect(
      removeTree(path.join(root, 'missing'))
    ).resolves.toBeUndefined();
  });
});
