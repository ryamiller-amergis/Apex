import type { SDKCustomTool } from '@cursor/sdk';
import type { RepoReader } from '../../shared/types/repoReader';
import { createNativeReadTools } from '../services/nativeReadToolAdapter';

function reader(): jest.Mocked<RepoReader> {
  return {
    identity: {
      provider: 'ado',
      project: 'Apex',
      repo: 'AI-Pilot',
      sha: 'pinned-sha',
    },
    readFile: jest.fn().mockResolvedValue('pinned content'),
    listDir: jest.fn().mockResolvedValue([
      { path: '/src', name: 'src', isFolder: true },
    ]),
    searchCode: jest.fn().mockResolvedValue([
      {
        path: '/src/example.ts',
        fileName: 'example.ts',
        repository: 'AI-Pilot',
        project: 'Apex',
        branch: 'pinned-sha',
        matches: [{ lineNumber: 3, snippet: 'needle' }],
      },
    ]),
  };
}

async function execute(
  tool: SDKCustomTool,
  args: Parameters<SDKCustomTool['execute']>[0],
): Promise<unknown> {
  return tool.execute(args, {});
}

describe('native read custom-tool adapter', () => {
  it('exposes exactly the three read-only repository tools', () => {
    // Arrange
    const repoReader = reader();

    // Act
    const tools = createNativeReadTools(repoReader);

    // Assert
    expect(Object.keys(tools)).toEqual([
      'get_skill_file',
      'list_repo_dir',
      'search_repo_code',
    ]);
    expect(Object.values(tools).every((tool) => tool.inputSchema?.additionalProperties === false))
      .toBe(true);
  });

  it('delegates file and directory paths unchanged to the authorized reader', async () => {
    // Arrange
    const repoReader = reader();
    const tools = createNativeReadTools(repoReader);

    // Act
    const fileResult = await execute(tools.get_skill_file, {
      path: '../reader-must-reject-this',
    });
    const dirResult = await execute(tools.list_repo_dir, {
      path: '/src',
    });

    // Assert
    expect(repoReader.readFile).toHaveBeenCalledWith('../reader-must-reject-this');
    expect(repoReader.listDir).toHaveBeenCalledWith('/src');
    expect(fileResult).toEqual('pinned content');
    expect(dirResult).toEqual({
      content: [{
        type: 'text',
        text: JSON.stringify([
          { path: '/src', name: 'src', isFolder: true },
        ], null, 2),
      }],
    });
  });

  it('delegates search validation and limit handling to the authorized reader', async () => {
    // Arrange
    const repoReader = reader();
    const tools = createNativeReadTools(repoReader);

    // Act
    const result = await execute(tools.search_repo_code, {
      query: 'needle',
      limit: 7,
    });

    // Assert
    expect(repoReader.searchCode).toHaveBeenCalledWith('needle', 7);
    expect(result).toEqual({
      content: [{
        type: 'text',
        text: JSON.stringify(await repoReader.searchCode.mock.results[0].value, null, 2),
      }],
    });
  });
});
