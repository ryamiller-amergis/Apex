import type { RepoReader } from '../../../shared/types/repoReader';
import { createRepoDesignContextReader } from '../../services/designContext/repoDesignContextReader';

function reader(files: Record<string, string>): RepoReader {
  return {
    identity: {
      provider: 'ado',
      project: 'Apex',
      repo: 'AI-Pilot',
      sha: 'a'.repeat(40),
    },
    readFile: async (path: string) => {
      const found = files[path];
      if (found === undefined) throw new Error(`missing ${path}`);
      return found;
    },
    listDir: async () => [],
    searchCode: async () => [],
  } as unknown as RepoReader;
}

describe('repoDesignContextReader', () => {
  it('reads every requested component rather than the first twenty', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 25; i += 1) {
      files[`/src/components/C${i}.tsx`] = `component ${i}`;
    }
    const context = createRepoDesignContextReader({ reader: reader(files) });

    const read = await context.readComponents(Object.keys(files));

    expect(read).toHaveLength(25);
  });

  it('skips a file it cannot read instead of failing the batch', async () => {
    const context = createRepoDesignContextReader({
      reader: reader({ '/src/components/A.tsx': 'a' }),
    });

    const read = await context.readComponents([
      '/src/components/A.tsx',
      '/src/components/Missing.tsx',
    ]);

    expect(read.map((file) => file.path)).toEqual(['/src/components/A.tsx']);
  });
});
