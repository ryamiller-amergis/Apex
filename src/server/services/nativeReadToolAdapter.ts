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
      execute: (args) => repoReader.readFile(args.path as string),
    },
    list_repo_dir: {
      description: 'List a directory in the authorized pinned repository checkout.',
      inputSchema: pathInputSchema,
      execute: async (args) => ({
        content: [{
          type: 'text',
          text: JSON.stringify(await repoReader.listDir(args.path as string), null, 2),
        }],
      }),
    },
    search_repo_code: {
      description: 'Search code in the authorized pinned repository checkout.',
      inputSchema: searchInputSchema,
      execute: async (args) => ({
        content: [{
          type: 'text',
          text: JSON.stringify(
            await repoReader.searchCode(
              args.query as string,
              args.limit as number | undefined,
            ),
            null,
            2,
          ),
        }],
      }),
    },
  };
}
