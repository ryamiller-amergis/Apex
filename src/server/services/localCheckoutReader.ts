import { promises as fs } from 'fs';
import path from 'path';
import type {
  RepoCodeSearchResult,
  RepoDirEntry,
  RepoReader,
  RepoSearchResult,
  RepositoryIdentity,
} from '../../shared/types/repoReader';
import type { GroundingTelemetryContext } from '../../shared/types/groundingOperations';
import { git, safeArgs } from '../utils/asyncGit';
import { createGroundingTelemetry } from './groundingTelemetry';
import {
  boundedSearchLimit,
  MAX_REPO_DIRECTORY_ENTRIES,
  RepoReaderError,
} from './repoReader';
import { trackEvent } from './telemetry';

export interface LocalCheckoutReaderOptions {
  identity: RepositoryIdentity;
  checkoutPath: string;
  telemetryContext?: GroundingTelemetryContext;
  telemetry?: typeof trackEvent;
  now?: () => number;
}

const ACCESS_DENIED_MESSAGE = 'Repository path access denied';
const LOCAL_UNAVAILABLE_MESSAGE = 'Repository content is unavailable';

export class LocalCheckoutReader implements RepoReader {
  readonly identity: RepositoryIdentity;
  private readonly checkoutPath: string;
  private readonly telemetryContext?: GroundingTelemetryContext;
  private readonly telemetry: ReturnType<typeof createGroundingTelemetry>;
  private readonly now: () => number;

  constructor(options: LocalCheckoutReaderOptions) {
    this.identity = { ...options.identity };
    this.checkoutPath = options.checkoutPath;
    this.telemetryContext = options.telemetryContext;
    this.telemetry = createGroundingTelemetry(options.telemetry ?? trackEvent);
    this.now = options.now ?? Date.now;
  }

  async readFile(filePath: string): Promise<string> {
    return this.measured(() =>
      this.controlled(async () => {
        const { target } = await this.resolveSafeTarget(filePath);
        return fs.readFile(target, 'utf-8');
      }),
    );
  }

  async listDir(dirPath: string): Promise<RepoDirEntry[]> {
    return this.measured(() =>
      this.controlled(async () => {
        const { target, portablePath } = await this.resolveSafeTarget(dirPath);
        const entries = await fs.readdir(target, { withFileTypes: true });

        return entries
          .sort((left, right) => {
            const leftDirectory = left.isDirectory();
            const rightDirectory = right.isDirectory();
            if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;
            return left.name.localeCompare(right.name);
          })
          .slice(0, MAX_REPO_DIRECTORY_ENTRIES)
          .map((entry) => ({
            path: `/${[portablePath, entry.name].filter(Boolean).join('/')}`,
            name: entry.name,
            isFolder: entry.isDirectory(),
          }));
      }),
    );
  }

  async searchCode(query: string, limit?: number): Promise<RepoSearchResult[]> {
    return this.measured(async () => {
      if (!query.trim()) return [];
      return this.controlled(async () => {
        const root = await this.resolveCheckoutRoot();
        const maxResults = boundedSearchLimit(limit);
        const hasGitRoot = await fs.stat(path.join(root, '.git')).then(() => true, () => false);
        if (hasGitRoot) {
          try {
            const output = await git(
              safeArgs(root, ['grep', '-n', '-I', '--full-name', '-F', '-e', query, '--', '.']),
              {
                cwd: root,
                timeout: 10_000,
                maxBuffer: 2 * 1024 * 1024,
              },
            );
            return this.shapeSearchResults(output, maxResults);
          } catch (error) {
            if (error instanceof Error && /exit code 1$/i.test(error.message)) return [];
            throw error;
          }
        }
        // Un-grounded workspaces (e.g. Brainstorm) have mounted git repos under `sources/<id>`.
        const sourcesDir = path.join(root, 'sources');
        const entries = await fs.readdir(sourcesDir).catch(() => [] as string[]);
        if (entries.length === 0) return [];
        const combined: RepoCodeSearchResult[] = [];
        for (const entry of entries) {
          if (combined.length >= maxResults) break;
          const sourceRoot = await fs.realpath(path.join(sourcesDir, entry)).catch(() => null);
          if (!sourceRoot) continue;
          try {
            const sourceOut = await git(
              safeArgs(sourceRoot, ['grep', '-n', '-I', '--full-name', '-F', '-e', query, '--', '.']),
              {
                cwd: sourceRoot,
                timeout: 10_000,
                maxBuffer: 2 * 1024 * 1024,
              },
            );
            const shaped = this.shapeSearchResults(
              sourceOut,
              maxResults - combined.length,
              `sources/${entry}`,
            );
            combined.push(...shaped);
          } catch (sourceErr) {
            if (sourceErr instanceof Error && /exit code 1$/i.test(sourceErr.message)) continue;
          }
        }
        return combined;
      });
    });
  }

  private shapeSearchResults(
    output: string,
    limit: number,
    pathPrefix?: string,
  ): RepoCodeSearchResult[] {
    const byPath = new Map<string, RepoCodeSearchResult>();

    for (const line of output.split(/\r?\n/)) {
      if (!line) continue;
      const match = /^(.+?):(\d+):(.*)$/.exec(line);
      if (!match) continue;

      const rawPath = match[1].replace(/\\/g, '/').replace(/^\.\//, '');
      const repoPath = pathPrefix ? `${pathPrefix}/${rawPath}` : rawPath;
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

  private validateRequestedPath(requestedPath: string): {
    platformPath: string;
    portablePath: string;
  } {
    // MCP's existing ADO contract describes repo-root paths with one leading
    // slash (for example "/README.md"). Treat that slash as repository-relative
    // while continuing to reject host absolute, UNC, drive, and traversal paths.
    const repoRelativePath =
      requestedPath.startsWith('/') && !requestedPath.startsWith('//')
        ? requestedPath.slice(1)
        : requestedPath;
    if (
      requestedPath.includes('\0')
      || path.isAbsolute(repoRelativePath)
      || path.posix.isAbsolute(repoRelativePath)
      || path.win32.isAbsolute(repoRelativePath)
    ) {
      throw new RepoReaderError('ACCESS_DENIED', ACCESS_DENIED_MESSAGE, false);
    }

    const segments = repoRelativePath.replace(/\\/g, '/').split('/');
    if (segments.includes('..')) {
      throw new RepoReaderError('ACCESS_DENIED', ACCESS_DENIED_MESSAGE, false);
    }

    const safeSegments = segments.filter((segment) => segment && segment !== '.');
    return {
      platformPath: safeSegments.join(path.sep),
      portablePath: safeSegments.join('/'),
    };
  }

  private async resolveCheckoutRoot(): Promise<string> {
    return fs.realpath(this.checkoutPath);
  }

  private async resolveSafeTarget(requestedPath: string): Promise<{
    target: string;
    portablePath: string;
  }> {
    const normalized = this.validateRequestedPath(requestedPath);
    const root = await this.resolveCheckoutRoot();
    const joined = path.resolve(root, normalized.platformPath);
    const joinedRelative = path.relative(root, joined);

    if (
      joinedRelative === '..'
      || joinedRelative.startsWith(`..${path.sep}`)
      || path.isAbsolute(joinedRelative)
    ) {
      throw new RepoReaderError('ACCESS_DENIED', ACCESS_DENIED_MESSAGE, false);
    }

    // Mounted Brainstorm sources sit under `sources/<sourceId>` inside the
    // thread workspace (which may be a directory junction on Windows). Keep
    // realpath confinement inside that mounted source root when present, or
    // inside the checkout root otherwise.
    const segments = normalized.portablePath.split('/');
    const mountedSourceRoot =
      segments[0] === 'sources' && segments[1]
        ? await fs.realpath(path.join(root, 'sources', segments[1])).catch(() => null)
        : null;
    const confinementRoot = mountedSourceRoot ?? root;
    const target = await fs.realpath(joined);
    const relative = path.relative(confinementRoot, target);

    if (
      relative === '..'
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)
    ) {
      throw new RepoReaderError('ACCESS_DENIED', ACCESS_DENIED_MESSAGE, false);
    }

    return { target, portablePath: normalized.portablePath };
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
