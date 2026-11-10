import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { tryApplyDeterministicCopyEdit } from '../services/build/buildRevisionDeterministicEdit';

describe('deterministic fast copy edit', () => {
  let workspacePath = '';

  beforeEach(async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), 'apex-copy-edit-'));
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  async function put(relativePath: string, content: string): Promise<void> {
    const target = path.join(workspacePath, ...relativePath.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  it('applies one unambiguous JSX copy change without starting an agent', async () => {
    await put(
      'apps/web/src/features/profile/ProfileForm.tsx',
      'export const Form = () => <button>Cancel</button>;\n'
    );
    await put(
      'apps/web/src/features/profile/ProfileForm.test.tsx',
      "expect(screen.getByText('Cancel')).toBeVisible();\n"
    );

    await expect(
      tryApplyDeterministicCopyEdit({
        workspacePath,
        feedback: 'Change the Cancel button text to Dismiss.',
      })
    ).resolves.toEqual({
      kind: 'edited',
      changedPath: 'apps/web/src/features/profile/ProfileForm.tsx',
    });
    await expect(
      readFile(
        path.join(
          workspacePath,
          'apps/web/src/features/profile/ProfileForm.tsx'
        ),
        'utf8'
      )
    ).resolves.toContain('<button>Dismiss</button>');
    await expect(
      readFile(
        path.join(
          workspacePath,
          'apps/web/src/features/profile/ProfileForm.test.tsx'
        ),
        'utf8'
      )
    ).resolves.toContain("'Cancel'");
  });

  it('does not guess when copy occurs in more than one production location', async () => {
    await put(
      'apps/web/src/features/one/First.tsx',
      'export const First = () => <h1>Profile</h1>;\n'
    );
    await put(
      'apps/web/src/features/two/Second.tsx',
      'export const Second = () => <span>Profile</span>;\n'
    );

    const result = await tryApplyDeterministicCopyEdit({
      workspacePath,
      feedback: 'Change the text from Profile to My profile.',
    });

    expect(result).toEqual({ kind: 'not_applicable' });
    await expect(
      readFile(
        path.join(workspacePath, 'apps/web/src/features/one/First.tsx'),
        'utf8'
      )
    ).resolves.toContain('Profile');
  });

  it('never edits blocked configuration or server paths', async () => {
    await put(
      'apps/web/src/config/env.ts',
      "export const appName = 'project-name';\n"
    );
    await put(
      'apps/api/src/app.ts',
      "export const appName = 'project-name';\n"
    );

    await expect(
      tryApplyDeterministicCopyEdit({
        workspacePath,
        feedback: 'Change the text from project-name to Studio Proof.',
      })
    ).resolves.toEqual({ kind: 'not_applicable' });
  });

  it('changes the rendered app-shell name without editing environment configuration', async () => {
    await put(
      'apps/web/src/app/App.tsx',
      [
        "import { webEnv } from '../config/env';",
        "import { AppShell } from '@project-scope/ui';",
        'export const App = () => (',
        '  <AppShell appName={webEnv.VITE_APP_NAME} navItems={[]}>Body</AppShell>',
        ');',
        '',
      ].join('\n')
    );
    await put(
      'apps/web/src/config/env.ts',
      "export const webEnv = { VITE_APP_NAME: 'project-name' };\n"
    );

    await expect(
      tryApplyDeterministicCopyEdit({
        workspacePath,
        feedback:
          'Change the application name shown in the preview header from project-name to Studio Proof.',
      })
    ).resolves.toEqual({
      kind: 'edited',
      changedPath: 'apps/web/src/app/App.tsx',
    });
    const app = await readFile(
      path.join(workspacePath, 'apps/web/src/app/App.tsx'),
      'utf8'
    );
    expect(app).toContain('appName={"Studio Proof"}');
    expect(app).not.toContain('webEnv');
    await expect(
      readFile(path.join(workspacePath, 'apps/web/src/config/env.ts'), 'utf8')
    ).resolves.toContain("'project-name'");
  });

  it('supports quoted copy containing spaces', async () => {
    await put(
      'packages/ui/src/EmptyState.tsx',
      'export const EmptyState = () => <p>No results found</p>;\n'
    );

    await expect(
      tryApplyDeterministicCopyEdit({
        workspacePath,
        feedback: 'Change "No results found" to "Nothing here yet".',
      })
    ).resolves.toMatchObject({ kind: 'edited' });
    await expect(
      readFile(
        path.join(workspacePath, 'packages/ui/src/EmptyState.tsx'),
        'utf8'
      )
    ).resolves.toContain('Nothing here yet');
  });

  it('leaves non-copy requests such as navigation icons to the edit agent', async () => {
    await put(
      'apps/web/src/app/App.tsx',
      "export const App = () => <AppShell appName=\"ATS\">Body</AppShell>;\n"
    );

    await expect(
      tryApplyDeterministicCopyEdit({
        workspacePath,
        feedback: 'add icons to the menu pages',
      })
    ).resolves.toEqual({ kind: 'not_applicable' });
  });
});
