/**
 * Reads design source out of the repository through a RepoReader.
 *
 * Replaces the Azure DevOps fetch in designSystemService, which reads at most
 * twenty component files to stay inside the API rate limit. A RepoReader works
 * against a pinned SHA without a PAT, so coverage is limited by what the model
 * can use rather than by an API quota — see designContextBudget.
 */
import type { RepoReader } from '../../../shared/types/repoReader';

export type DesignSourceFile = Readonly<{ path: string; content: string }>;

export type RepoDesignContextReader = {
  readComponents(paths: string[]): Promise<DesignSourceFile[]>;
};

export function createRepoDesignContextReader(deps: {
  reader: RepoReader;
  concurrency?: number;
}): RepoDesignContextReader {
  const concurrency = deps.concurrency ?? 8;

  return {
    async readComponents(paths) {
      const collected: DesignSourceFile[] = [];
      for (let index = 0; index < paths.length; index += concurrency) {
        const batch = paths.slice(index, index + concurrency);
        const read = await Promise.all(
          batch.map(async (path) => {
            try {
              return { path, content: await deps.reader.readFile(path) };
            } catch {
              // One unreadable file must not cost us the rest of the context.
              return null;
            }
          }),
        );
        for (const file of read) {
          if (file) collected.push(file);
        }
      }
      return collected;
    },
  };
}
