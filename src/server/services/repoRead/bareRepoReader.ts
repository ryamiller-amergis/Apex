import { cpus } from 'node:os';

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

// Reading one object is a single lookup, but grep has to inflate every blob in
// the tree because a bare mirror has no working copy to scan. Sharing one
// budget meant search on a large repo was always killed mid-flight while the
// object reads it was sized for finished in ~100ms.
const OBJECT_READ_TIMEOUT_MS = 10_000;
const SEARCH_TIMEOUT_MS = 60_000;

// Blob inflation parallelizes well. Clamped because the App Service instance
// also serves requests, and unbounded threads starve them.
const SEARCH_THREADS = Math.max(2, Math.min(8, cpus().length || 2));

const SEARCH_TIMEOUT_MESSAGE =
  'Repository search timed out. Narrow the query or scope it to a directory.';

function isTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { killed, signal, code } = error as {
    killed?: unknown;
    signal?: unknown;
    code?: unknown;
  };
  return killed === true || signal === 'SIGTERM' || code === 'ETIMEDOUT';
}

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
    return this.measured('readFile', () =>
      this.controlled(async () => {
        const { portablePath } = validateRepoRelativePath(filePath);
        const spec = `${this.identity.sha}:${portablePath}`;
        return git(safeArgs(this.mirrorPath, ['cat-file', '-p', spec]), {
          cwd: this.mirrorPath,
          timeout: OBJECT_READ_TIMEOUT_MS,
        });
      }),
    );
  }

  async listDir(dirPath: string): Promise<RepoDirEntry[]> {
    return this.measured('listDir', () =>
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
          { cwd: this.mirrorPath, timeout: OBJECT_READ_TIMEOUT_MS },
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
    return this.measured('searchCode', async () => {
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
              `--threads=${SEARCH_THREADS}`,
              '-e',
              query,
              this.identity.sha,
              '--',
              '.',
            ]),
            {
              cwd: this.mirrorPath,
              timeout: SEARCH_TIMEOUT_MS,
              maxBuffer: 2 * 1024 * 1024,
            },
          );
        } catch (error) {
          if (error instanceof Error && /exit code 1$/i.test(error.message)) {
            return [];
          }
          // A timed-out search is not worth retrying: the next attempt scans
          // the same tree and dies at the same limit, which is what turned one
          // slow grep into a run that respawned every minute. Tell the caller
          // to narrow the query instead of letting it loop.
          if (isTimeout(error)) {
            throw new RepoReaderError(
              'SEARCH_TIMEOUT',
              SEARCH_TIMEOUT_MESSAGE,
              false,
            );
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

  private async measured<T>(
    operationName: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAt = this.now();
    try {
      return await operation();
    } finally {
      if (this.telemetryContext) {
        try {
          this.telemetry.localRead(
            this.telemetryContext,
            this.now() - startedAt,
            operationName,
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
