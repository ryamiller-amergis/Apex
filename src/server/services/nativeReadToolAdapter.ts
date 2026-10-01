import type { SDKCustomTool, SDKJsonValue } from '@cursor/sdk';
import type { RepoReader } from '../../shared/types/repoReader';
import { RepoReaderError } from './repoReader';

function toolErrorResult(error: unknown) {
  return {
    content: [{
      type: 'text' as const,
      text: error instanceof Error
        ? error.message
        : 'Repository content is unavailable',
    }],
    isError: true,
  };
}

function missingFileResult(path: string) {
  return {
    content: [{
      type: 'text' as const,
      text: `File not found in repository: ${path}`,
    }],
  };
}

async function executeRepoRead<T>(
  operation: () => Promise<T>,
  missingPath?: string,
): Promise<T | ReturnType<typeof toolErrorResult> | ReturnType<typeof missingFileResult>> {
  try {
    return await operation();
  } catch (error) {
    if (
      missingPath !== undefined &&
      error instanceof RepoReaderError &&
      error.code === 'LOCAL_READ_UNAVAILABLE'
    ) {
      // A missing optional file is repository state, not a failed tool call.
      // This matters for first-run skills such as Product Foundation, where
      // PRODUCT.md is expected not to exist yet.
      return missingFileResult(missingPath);
    }
    if (error instanceof RepoReaderError && !error.fallbackEligible) {
      throw error;
    }
    // Resolve with an MCP error result instead of rejecting the custom-tool
    // callback. The Cursor SDK can then emit the terminal tool event and avoid
    // leaving Apex's owner-deadline tracker with a stale in-flight call.
    return toolErrorResult(error);
  }
}

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
  },
};

/**
 * Exposes the authorized repository reader through Cursor's in-process,
 * read-only custom-tool surface. Path confinement and search validation remain
 * the responsibility of the supplied RepoReader (normally LocalCheckoutReader).
 */
export function createNativeReadTools(
  repoReader: RepoReader,
): Record<string, SDKCustomTool> {
  return {
    get_skill_file: {
      description: 'Read a file from the authorized pinned repository checkout.',
      inputSchema: pathInputSchema,
      // Ignore any root-widening keys (root, checkoutPath, command, …); confinement
      // is owned by the constructed RepoReader, not caller-supplied roots.
      execute: ({ path: requestedPath }) => {
        const path = String(requestedPath ?? '');
        return executeRepoRead(
          () => repoReader.readFile(path),
          path,
        );
      },
    },
    list_repo_dir: {
      description: 'List a directory in the authorized pinned repository checkout.',
      inputSchema: pathInputSchema,
      execute: ({ path: requestedPath }) =>
        executeRepoRead(async () => ({
          content: [{
            type: 'text' as const,
            text: JSON.stringify(
              await repoReader.listDir(String(requestedPath ?? '')),
              null,
              2,
            ),
          }],
        })),
    },
    search_repo_code: {
      description: 'Search code in the authorized pinned repository checkout.',
      inputSchema: searchInputSchema,
      execute: ({ query, limit }) =>
        executeRepoRead(async () => ({
          content: [{
            type: 'text' as const,
            text: JSON.stringify(
              await repoReader.searchCode(
                String(query ?? ''),
                typeof limit === 'number' ? limit : undefined,
              ),
              null,
              2,
            ),
          }],
        })),
    },
  };
}
