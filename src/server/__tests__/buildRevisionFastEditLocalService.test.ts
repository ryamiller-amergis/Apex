import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git, safeArgs } from '../utils/asyncGit';
import { restoreFastEditPathsToBase } from '../services/build/buildRevisionFastEditLocalService';

describe('local fast-edit rollback files', () => {
  it('restores modified base files and removes files added by the failed draft', async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), 'fast-edit-rollback-')
    );
    const modifiedPath = 'apps/web/src/Card.tsx';
    const addedPath = 'apps/web/src/NewCard.tsx';
    try {
      await mkdir(path.join(workspacePath, 'apps', 'web', 'src'), {
        recursive: true,
      });
      await writeFile(
        path.join(workspacePath, ...modifiedPath.split('/')),
        'export const label = "base";\n'
      );
      await git(safeArgs(workspacePath, ['init']), { cwd: workspacePath });
      await git(safeArgs(workspacePath, ['add', '--all']), {
        cwd: workspacePath,
      });
      await git(
        safeArgs(workspacePath, [
          '-c',
          'user.name=Apex Test',
          '-c',
          'user.email=apex-test@local',
          'commit',
          '-m',
          'base',
        ]),
        { cwd: workspacePath }
      );
      const baseCommit = (
        await git(safeArgs(workspacePath, ['rev-parse', 'HEAD']), {
          cwd: workspacePath,
        })
      ).trim();
      await writeFile(
        path.join(workspacePath, ...modifiedPath.split('/')),
        'export const label = "failed draft";\n'
      );
      await writeFile(
        path.join(workspacePath, ...addedPath.split('/')),
        'export const added = true;\n'
      );

      await expect(
        restoreFastEditPathsToBase({
          workspacePath,
          baseCommit,
          paths: [modifiedPath, addedPath],
        })
      ).resolves.toEqual([
        { status: 'M', relativePath: modifiedPath },
        { status: 'D', relativePath: addedPath },
      ]);
      const restored = await readFile(
        path.join(workspacePath, ...modifiedPath.split('/')),
        'utf8',
      );
      expect(restored.trim()).toBe('export const label = "base";');
      await expect(
        readFile(path.join(workspacePath, ...addedPath.split('/')), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });
});
