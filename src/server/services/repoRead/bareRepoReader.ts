import type {
  RepoCodeSearchResult,
  RepoDirEntry,
  RepoReader,
  RepoSearchResult,
  RepositoryIdentity,
} from '../../../shared/types/repoReader';
import type { GroundingTelemetryContext } from '../../../shared/types/groundingOperations';
import { git, safeArgs } from '../../utils/asyncGit';
import { createGroundingTelemetry } from '../groundingTelemetry';
import {
  boundedSearchLimit,
  MAX_REPO_DIRECTORY_ENTRIES,
  RepoReaderError,
} from '../repoReader';
import { trackEvent } from '../telemetry';
import { validateRepoRelativePath } from './pathGuard';

export interface BareRepoReaderOptions {
  identity: RepositoryIdentity;
  mirrorPath: string;
  telemetryContext?: GroundingTelemetryContext;
  telemetry?: typeof trackEvent;
  now?: () => number;
}

const LOCAL_UNAVAILABLE_MESSAGE = 'Repository content is unavailable';

export class BareRepoReader implements RepoReader {
  readonly identity: RepositoryIdentity;
  private readonly mirrorPath: string;
  private readonly telemetryContext?: GroundingTelemetryContext;
  private readonly telemetry: ReturnType<typeof createGroundingTelemetry>;
  private readonly now: () => number;

  constructor(options: BareRepoReaderOptions) {
    this.identity = { ...options.identity };
    this.mirrorPath = options.mirrorPath;
    this.telemetryContext = options.telemetryContext;
    this.telemetry = createGroundingTelemetry(options.telemetry ?? trackEvent);
    this.now = options.now ?? Date.now;
  }

  async readFile(filePath: string): Promise<string> {
    return this.measured(() =>
      this.controlled(async () => {
        const { portablePath } = validateRepoRelativePath(filePath);
        const spec = `${this.identity.sha}:${portablePath}`;
        return git(safeArgs(this.mirrorPath, ['cat-file', '-p', spec]), {
          cwd: this.mirrorPath,
          timeout: 10_000,
        });
      }),
    );
  }

  async listDir(dirPath: string): Promise<RepoDirEntry[]> {
    return this.measured(() =>
      this.controlled(async () => {
        const { portablePath } = validateRepoRelativePath(dirPath);
        const spec = portablePath ? [`${portablePath}/`] : [];
        const output = await git(
          safeArgs(this.mirrorPath, [
            'ls-tree',
            '--full-tree',
            this.identity.sha,
            '--',
            ...spec,
          ]),
          { cwd: this.mirrorPath, timeout: 10_000 },
        );

        return output
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => parseLsTreeLine(line, portablePath))
          .filter((entry): entry is RepoDirEntry => entry !== null)
          .sort((left, right) => {
            if (left.isFolder !== right.isFolder) return left.isFolder ? -1 : 1;
            return left.name.localeCompare(right.name);
          })
          .slice(0, MAX_REPO_DIRECTORY_ENTRIES);
      }),
    );
  }

  async searchCode(query: string, limit?: number): Promise<RepoSearchResult[]> {
    return this.measured(async () => {
      if (!query.trim()) return [];
      return this.controlled(async () => {
        let output: string;
        try {
          output = await git(
            safeArgs(this.mirrorPath, [
              'grep',
              '-n',
              '-I',
              '--full-name',
              '-F',
              '-e',
              query,
              this.identity.sha,
              '--',
              '.',
            ]),
            {
              cwd: this.mirrorPath,
              timeout: 10_000,
              maxBuffer: 2 * 1024 * 1024,
            },
          );
        } catch (error) {
          if (error instanceof Error && /exit code 1$/i.test(error.message)) {
            return [];
          }
          throw error;
        }
        return this.shapeSearchResults(output, boundedSearchLimit(limit));
      });
    });
  }

  private shapeSearchResults(output: string, limit: number): RepoCodeSearchResult[] {
    const byPath = new Map<string, RepoCodeSearchResult>();

    for (const line of output.split(/\r?\n/)) {
      if (!line) continue;
      const match = /^(?:[0-9a-f]{40}:)?(.+?):(\d+):(.*)$/i.exec(line);
      if (!match) continue;

      const repoPath = match[1].replace(/\\/g, '/').replace(/^\.\//, '');
      let result = byPath.get(repoPath);
      if (!result) {
        if (byPath.size >= limit) continue;
        result = {
          path: `/${repoPath}`,
          fileName: repoPath.split('/').pop() ?? repoPath,
          repository: this.identity.repo,
          project: this.identity.project,
          branch: this.identity.sha,
          matches: [],
        };
        byPath.set(repoPath, result);
      }
      result.matches.push({
        lineNumber: Number(match[2]),
        snippet: match[3].trim(),
      });
    }

    return [...byPath.values()];
  }

  private async controlled<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RepoReaderError) throw error;
      throw new RepoReaderError(
        'LOCAL_READ_UNAVAILABLE',
        LOCAL_UNAVAILABLE_MESSAGE,
        true,
      );
    }
  }

  private async measured<T>(operation: () => Promise<T>): Promise<T> {
    const startedAt = this.now();
    try {
      return await operation();
    } finally {
      if (this.telemetryContext) {
        try {
          this.telemetry.localRead(
            this.telemetryContext,
            this.now() - startedAt,
          );
        } catch {
          // Observability must never change repository-read behavior.
        }
      }
    }
  }
}

function parseLsTreeLine(line: string, parentPortable: string): RepoDirEntry | null {
  const match = /^\S+\s+(\S+)\s+\S+\t(.+)$/.exec(line);
  if (!match) return null;
  const kind = match[1];
  const rawPath = match[2].replace(/\\/g, '/');
  const name = rawPath.split('/').pop() ?? rawPath;
  const relative = parentPortable ? `${parentPortable}/${name}` : name;
  return {
    path: `/${relative}`,
    name,
    isFolder: kind === 'tree',
  };
}
