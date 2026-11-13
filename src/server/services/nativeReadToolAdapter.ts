import type { SDKCustomTool, SDKJsonValue } from '@cursor/sdk';
import type { RepoReader } from '../../shared/types/repoReader';

const pathInputSchema: Record<string, SDKJsonValue> = {
  type: 'object',
  additionalProperties: false,
  required: ['path'],
  properties: {
    path: {
      type: 'string',
      description: 'Repository-relative path',
    },
  },
};

const SEARCH_SCOPE_KEYS = [
  'path',
  'repoPath',
  'repo_path',
  'repositoryPath',
  'repository_path',
  'sourcePath',
  'source_path',
  'target_directory',
  'targetDirectory',
  'directory',
  'dir',
  'source',
  'sourceId',
  'source_id',
] as const;

const searchInputSchema: Record<string, SDKJsonValue> = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: {
      type: 'string',
      description: 'Literal repository search query',
    },
    limit: {
      type: 'integer',
      description: 'Maximum number of matching files',
    },
    path: {
      type: 'string',
      description: 'Optional repository-relative path or mounted source prefix (e.g. sources/<sourceId>) to scope the search',
    },
    repoPath: {
      type: 'string',
      description: 'Alias for path (e.g. sources/<sourceId>)',
    },
    repo_path: {
      type: 'string',
      description: 'Alias for path (e.g. sources/<sourceId>)',
    },
    repositoryPath: {
      type: 'string',
      description: 'Alias for path (e.g. sources/<sourceId>)',
    },
    repository_path: {
      type: 'string',
      description: 'Alias for path (e.g. sources/<sourceId>)',
    },
  },
};

function resolveScopedSearchPath(record: Record<string, unknown>): string | undefined {
  for (const key of SEARCH_SCOPE_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === 'query') continue;
    if (typeof value === 'string' && /^\/?sources\//i.test(value.trim())) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * Exposes the authorized repository reader through Cursor's in-process,
 * read-only custom-tool surface. Path confinement and search validation remain
 * the responsibility of the supplied RepoReader (normally LocalCheckoutReader).
 */
export function createNativeReadTools(
  repoReader: RepoReader,
  options?: { allowSearch?: boolean },
): Record<string, SDKCustomTool> {
  const allowSearch = options?.allowSearch !== false;
  const tools: Record<string, SDKCustomTool> = {
    get_skill_file: {
      description: 'Read a file from the authorized pinned repository checkout.',
      inputSchema: pathInputSchema,
      // Ignore any root-widening keys (root, checkoutPath, command, …); confinement
      // is owned by the constructed RepoReader, not caller-supplied roots.
      execute: ({ path: requestedPath }) =>
        repoReader.readFile(String(requestedPath ?? '')),
    },
    list_repo_dir: {
      description: 'List a directory in the authorized pinned repository checkout.',
      inputSchema: pathInputSchema,
      execute: async ({ path: requestedPath }) => ({
        content: [{
          type: 'text',
          text: JSON.stringify(
            await repoReader.listDir(String(requestedPath ?? '')),
            null,
            2,
          ),
        }],
      }),
    },
  };
  if (allowSearch) {
    tools.search_repo_code = {
      description: 'Search code in the authorized pinned repository checkout.',
      inputSchema: searchInputSchema,
      execute: async (rawArgs) => {
        const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
        const scopedPath = resolveScopedSearchPath(args);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(
              await repoReader.searchCode(
                String(args.query ?? ''),
                typeof args.limit === 'number' ? args.limit : undefined,
                ...(scopedPath ? [scopedPath] : []),
              ),
              null,
              2,
            ),
          }],
        };
      },
    };
  }
  return tools;
}
