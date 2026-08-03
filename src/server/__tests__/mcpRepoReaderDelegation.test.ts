import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { RepoReader } from '../../shared/types/repoReader';

type ToolHandler = (input: Record<string, unknown>) => Promise<unknown>;

class TestMcpServer {
  readonly handlers = new Map<string, ToolHandler>();
  readonly schemas = new Map<string, Record<string, unknown>>();

  tool(name: string, ...args: unknown[]): void {
    const handler = args[args.length - 1];
    if (typeof handler !== 'function') throw new Error(`Missing handler for ${name}`);
    this.schemas.set(name, args[1] as Record<string, unknown>);
    this.handlers.set(name, handler as ToolHandler);
  }

  prompt(): void {}

  invoke(name: string, input: Record<string, unknown>): Promise<unknown> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`Unknown tool ${name}`);
    return handler(input);
  }
}

jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: TestMcpServer,
}));

const adoCatalog = {
  listProjects: jest.fn().mockResolvedValue([{ name: 'Apex' }]),
  listRepos: jest.fn().mockResolvedValue([{ name: 'AI-Pilot' }]),
  listSkills: jest.fn().mockResolvedValue([]),
  getSkill: jest.fn().mockResolvedValue({ name: 'skill' }),
  getSkillFile: jest.fn(),
  listRepoDir: jest.fn(),
  searchRepoCode: jest.fn(),
  searchSkills: jest.fn().mockReturnValue([]),
};
const mockQueryWorkItemsByWiql = jest.fn().mockResolvedValue([{ id: 42 }]);
const mockAzureDevOpsService = jest.fn().mockImplementation(() => ({
  queryWorkItemsByWiql: mockQueryWorkItemsByWiql,
}));
const mockGetThread = jest.fn().mockResolvedValue({ userId: 'developer-1' });
const mockAddTestCaseToPrd = jest.fn().mockResolvedValue({
  testCaseId: 'TC-1',
  totalCases: 1,
});
const mockDb = {
  query: {
    standupSessions: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'standup-1',
        sessionDate: '2026-08-02',
        status: 'active',
        config: { project: 'Apex', areaPath: 'Apex' },
        participants: [],
      }),
    },
  },
};

jest.mock('../services/skillCatalog', () => adoCatalog);
jest.mock('../services/skillCatalogGitHub', () => ({
  getSkillFile: jest.fn(),
  listRepoDir: jest.fn(),
  searchRepoCode: jest.fn(),
  listSkills: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/wikiCatalog', () => ({
  listWikis: jest.fn().mockResolvedValue([]),
  listWikiPages: jest.fn().mockResolvedValue([]),
  getWikiPage: jest.fn().mockResolvedValue({ path: '/Home' }),
}));
jest.mock('../services/chatAgentService', () => ({ getThread: mockGetThread }));
jest.mock('../services/designDocService', () => ({}));
jest.mock('../services/prdService', () => ({}));
jest.mock('../services/testCaseService', () => ({
  addTestCaseToPrd: mockAddTestCaseToPrd,
}));
jest.mock('../services/adrService', () => ({}));
jest.mock('../services/azureDevOps', () => ({
  AzureDevOpsService: mockAzureDevOpsService,
}));
jest.mock('../db/drizzle', () => ({ db: mockDb }));
jest.mock('../db/schema', () => ({
  prds: {},
  standupSessions: {},
  appUsers: {},
  chatMessages: {},
}));
jest.mock('drizzle-orm', () => ({ eq: jest.fn() }));

import { createGitHubMcpServer } from '../mcp/github/server';
import { createAdoMcpServer } from '../mcp/ado/server';
import { GroundingProfileResolver } from '../services/groundingProfileResolver';
import { LocalCheckoutReader } from '../services/localCheckoutReader';

function reader(): jest.Mocked<RepoReader> {
  return {
    identity: {
      provider: 'github',
      project: 'Apex',
      repo: 'AI-Pilot',
      sha: 'pinned-sha',
    },
    readFile: jest.fn().mockResolvedValue('local file'),
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
        matches: [{ lineNumber: 1, snippet: 'needle' }],
      },
    ]),
  };
}

function asTestServer(server: unknown): TestMcpServer {
  return server as TestMcpServer;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function checkout(label: string): { root: string; sha: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pbi-005-${label}-`));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'README.md'), `${label} pinned content\n`);
  fs.writeFileSync(
    path.join(root, 'src', `${label}.ts`),
    `export const profileNeedle = '${label}';\n`,
  );
  git(root, ['init']);
  git(root, ['config', 'user.name', 'Apex Test']);
  git(root, ['config', 'user.email', 'apex-test@example.com']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', `${label} fixture`]);
  return { root, sha: git(root, ['rev-parse', 'HEAD']) };
}

describe('PBI-005 MCP RepoReader delegation contracts', () => {
  it('VT-03 omits exactly ADO repo-browse tools and retains staging and non-browse tools', () => {
    // Arrange
    const enabled = asTestServer(createAdoMcpServer());

    // Act
    const disabled = asTestServer(createAdoMcpServer({ enableRepoBrowse: false }));
    const removed = [...enabled.handlers.keys()]
      .filter((name) => !disabled.handlers.has(name));

    // Assert
    expect(removed).toEqual([
      'list_repo_dir',
      'get_skill_file',
      'search_repo_code',
    ]);
    expect([...disabled.handlers.keys()]).toEqual(expect.arrayContaining([
      'update_design_doc',
      'update_prd',
      'update_adr',
      'resolve_prd_comment',
      'add_test_case',
      'list_skills',
      'search_skills',
      'query_work_items',
    ]));
  });

  it('VT-04 omits all three GitHub repo-browse tools and retains non-browse tools', () => {
    // Arrange
    const enabled = asTestServer(createGitHubMcpServer());

    // Act
    const disabled = asTestServer(createGitHubMcpServer({ enableRepoBrowse: false }));
    const removed = [...enabled.handlers.keys()]
      .filter((name) => !disabled.handlers.has(name));

    // Assert
    expect(removed).toEqual([
      'get_skill_file',
      'list_repo_dir',
      'search_repo_code',
    ]);
    expect([...disabled.handlers.keys()]).toEqual(['list_skills']);
  });

  it('AC-0 / VT-01 and VT-07: two profile-bound handlers read only their pinned checkout through all three tools', async () => {
    // Given two concurrent connection profiles pinned to distinct local checkouts.
    const alpha = checkout('alpha');
    const beta = checkout('beta');
    const resolver = new GroundingProfileResolver({
      authorization: { authorize: async () => true },
      isFeatureEnabled: async () => true,
    });
    const alphaProfile = resolver.registerConnectionProfile(
      {
        runRef: 'chat:alpha',
        provider: 'github',
        project: 'Apex',
        repo: 'alpha-repo',
        sha: alpha.sha,
        checkoutPath: alpha.root,
      },
      { userId: 'alpha-user', runRef: 'chat:alpha', project: 'Apex' },
      async () => true,
    );
    const betaProfile = resolver.registerConnectionProfile(
      {
        runRef: 'chat:beta',
        provider: 'ado',
        project: 'Apex',
        repo: 'beta-repo',
        sha: beta.sha,
        checkoutPath: beta.root,
      },
      { userId: 'beta-user', runRef: 'chat:beta', project: 'Apex' },
      async () => true,
    );

    try {
      // When each profile is resolved concurrently and used by every delegated handler.
      const [alphaReader, betaReader] = await Promise.all([
        resolver.resolveConnectionProfile(alphaProfile.id),
        resolver.resolveConnectionProfile(betaProfile.id),
      ]);
      expect(alphaReader).toBeInstanceOf(LocalCheckoutReader);
      expect(betaReader).toBeInstanceOf(LocalCheckoutReader);
      const alphaServer = asTestServer(createGitHubMcpServer({ repoReader: alphaReader }));
      const betaServer = asTestServer(createAdoMcpServer({ repoReader: betaReader }));
      const [alphaFile, alphaDir, alphaSearch, betaFile, betaDir, betaSearch] =
        await Promise.all([
          alphaServer.invoke('get_skill_file', {
            repo: 'alpha-repo',
            path: '/README.md',
          }),
          alphaServer.invoke('list_repo_dir', {
            repo: 'alpha-repo',
            path: '/src',
          }),
          alphaServer.invoke('search_repo_code', {
            repo: 'alpha-repo',
            query: 'profileNeedle',
          }),
          betaServer.invoke('get_skill_file', {
            project: 'Apex',
            repo: 'beta-repo',
            path: '/README.md',
          }),
          betaServer.invoke('list_repo_dir', {
            project: 'Apex',
            repo: 'beta-repo',
            path: '/src',
          }),
          betaServer.invoke('search_repo_code', {
            project: 'Apex',
            repo: 'beta-repo',
            query: 'profileNeedle',
          }),
        ]);

      // Then each existing MCP envelope contains only that profile's pinned content.
      expect(alphaFile).toEqual({
        content: [{ type: 'text', text: 'alpha pinned content\n' }],
      });
      expect(alphaDir).toEqual({
        content: [{
          type: 'text',
          text: JSON.stringify([
            { path: '/src/alpha.ts', name: 'alpha.ts', isFolder: false },
          ], null, 2),
        }],
      });
      expect(JSON.stringify(alphaSearch)).toContain('/src/alpha.ts');
      expect(JSON.stringify(alphaSearch)).not.toContain('/src/beta.ts');
      expect(betaFile).toEqual({
        content: [{ type: 'text', text: 'beta pinned content\n' }],
      });
      expect(betaDir).toEqual({
        content: [{
          type: 'text',
          text: JSON.stringify([
            { path: '/src/beta.ts', name: 'beta.ts', isFolder: false },
          ], null, 2),
        }],
      });
      expect(JSON.stringify(betaSearch)).toContain('/src/beta.ts');
      expect(JSON.stringify(betaSearch)).not.toContain('/src/alpha.ts');
    } finally {
      fs.rmSync(alpha.root, { recursive: true, force: true });
      fs.rmSync(beta.root, { recursive: true, force: true });
    }
  });

  it.each([
    ['GitHub', (repoReader: RepoReader) => createGitHubMcpServer({ repoReader })],
    ['ADO', (repoReader: RepoReader) => createAdoMcpServer({ repoReader })],
  ])('BR-008 / VT-01 delegates exactly three repo-browse tools through the bound reader on %s', async (
    _name,
    create,
  ) => {
    // Arrange
    const repoReader = reader();
    const server = asTestServer(create(repoReader));

    // Act
    await server.invoke('get_skill_file', {
      project: 'Apex',
      repo: 'AI-Pilot',
      path: '/README.md',
    });
    await server.invoke('list_repo_dir', {
      project: 'Apex',
      repo: 'AI-Pilot',
      path: '/src',
    });
    await server.invoke('search_repo_code', {
      project: 'Apex',
      repo: 'AI-Pilot',
      query: 'needle',
      limit: 7,
    });

    // Assert
    expect(repoReader.readFile).toHaveBeenCalledTimes(1);
    expect(repoReader.readFile).toHaveBeenCalledWith('/README.md');
    expect(repoReader.listDir).toHaveBeenCalledTimes(1);
    expect(repoReader.listDir).toHaveBeenCalledWith('/src');
    expect(repoReader.searchCode).toHaveBeenCalledTimes(1);
    expect(repoReader.searchCode).toHaveBeenCalledWith('needle', 7);
  });

  it('Performance NFR / VT-01 keeps all three delegated handlers inside raceWithTimeout', async () => {
    // Given a bound local reader whose three operations never settle.
    jest.useFakeTimers();
    const previousTimeout = process.env.MCP_TOOL_TIMEOUT_MS;
    process.env.MCP_TOOL_TIMEOUT_MS = '5';
    const never = () => new Promise<never>(() => undefined);
    const repoReader: RepoReader = {
      identity: {
        provider: 'github',
        project: 'Apex',
        repo: 'AI-Pilot',
        sha: 'pinned-sha',
      },
      readFile: jest.fn(never),
      listDir: jest.fn(never),
      searchCode: jest.fn(never),
    };

    try {
      // When all delegated handlers run and the deterministic watchdog advances.
      const server = asTestServer(createGitHubMcpServer({ repoReader }));
      const operations = [
        server.invoke('get_skill_file', { repo: 'AI-Pilot', path: '/README.md' }),
        server.invoke('list_repo_dir', { repo: 'AI-Pilot', path: '/src' }),
        server.invoke('search_repo_code', { repo: 'AI-Pilot', query: 'needle' }),
      ];
      await jest.advanceTimersByTimeAsync(5);

      // Then every operation terminates in its existing controlled MCP envelope.
      await expect(Promise.all(operations)).resolves.toEqual([
        {
          content: [{
            type: 'text',
            text: 'Error reading file: get_skill_file timed out after 5ms',
          }],
        },
        { content: [{ type: 'text', text: '[]' }] },
        {
          content: [{
            type: 'text',
            text: 'Search error: search_repo_code timed out after 5ms',
          }],
          isError: true,
        },
      ]);
    } finally {
      if (previousTimeout === undefined) delete process.env.MCP_TOOL_TIMEOUT_MS;
      else process.env.MCP_TOOL_TIMEOUT_MS = previousTimeout;
      jest.useRealTimers();
    }
  });

  it('AC-3 / BR-008 / VT-04 keeps every ADO non-repository category on existing implementations', async () => {
    // Given grounding is enabled and all representative non-repository handlers are registered.
    const repoReader = reader();
    const server = asTestServer(createAdoMcpServer({ repoReader }));
    const expectedNonRepoTools = [
      'list_projects',
      'list_repos',
      'list_skills',
      'get_skill',
      'search_skills',
      'list_wikis',
      'list_wiki_pages',
      'get_wiki_page',
      'query_work_items',
      'get_work_item_history',
      'get_work_item_comment_history',
      'create_work_items',
      'update_work_item',
      'add_work_item_comment',
      'get_standup_session',
      'create_standup_followup',
      'complete_standup_session',
      'update_design_doc',
      'update_prd',
      'update_adr',
      'resolve_prd_comment',
      'add_test_case',
    ];

    // When catalog, wiki, work-item, standup, and write-back tools are invoked.
    await server.invoke('list_projects', {});
    await server.invoke('list_skills', {
      project: 'Apex',
      repo: 'AI-Pilot',
    });
    await server.invoke('get_skill', {
      project: 'Apex',
      repo: 'AI-Pilot',
      path: '/.cursor/skills/example/SKILL.md',
    });
    await server.invoke('search_skills', {
      project: 'Apex',
      repo: 'AI-Pilot',
      query: 'example',
    });
    await server.invoke('get_wiki_page', {
      project: 'Apex',
      wikiId: 'wiki',
      path: '/Home',
    });
    await server.invoke('query_work_items', {
      project: 'Apex',
      wiql: 'SELECT [System.Id] FROM WorkItems',
    });
    await server.invoke('get_standup_session', {
      sessionId: 'standup-1',
    });
    await server.invoke('add_test_case', {
      threadId: 'thread-1',
      prdId: 'prd-1',
      pbiId: 'PBI-1',
      title: 'Preserve write-back',
      steps: ['Invoke existing PostgreSQL implementation'],
    });

    // Then registrations/contracts remain present and RepoReader is never used.
    expect([...server.handlers.keys()]).toEqual(expect.arrayContaining(expectedNonRepoTools));
    expect(adoCatalog.listProjects).toHaveBeenCalledTimes(1);
    expect(adoCatalog.listSkills).toHaveBeenCalledTimes(2);
    expect(adoCatalog.getSkill).toHaveBeenCalledTimes(1);
    expect(adoCatalog.searchSkills).toHaveBeenCalledTimes(1);
    expect(mockQueryWorkItemsByWiql).toHaveBeenCalledTimes(1);
    expect(mockDb.query.standupSessions.findFirst).toHaveBeenCalledTimes(1);
    expect(mockAddTestCaseToPrd).toHaveBeenCalledTimes(1);
    expect(repoReader.readFile).not.toHaveBeenCalled();
    expect(repoReader.listDir).not.toHaveBeenCalled();
    expect(repoReader.searchCode).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'GitHub',
      server: () => asTestServer(createGitHubMcpServer()),
      expectedSchemas: {
        get_skill_file: ['repo', 'path', 'branch', 'org'],
        list_repo_dir: ['repo', 'path', 'branch', 'org'],
        search_repo_code: ['repo', 'query', 'branch', 'org', 'limit'],
      },
    },
    {
      name: 'ADO',
      server: () => asTestServer(createAdoMcpServer()),
      expectedSchemas: {
        get_skill_file: ['project', 'repo', 'path', 'branch'],
        list_repo_dir: ['project', 'repo', 'path', 'branch'],
        search_repo_code: ['project', 'repo', 'query', 'branch', 'limit'],
      },
    },
  ])('BR-008 / VT-05 preserves delegated names and argument schemas on $name', ({
    server: create,
    expectedSchemas,
  }) => {
    // Given the MCP server is built with its public registrations.
    const server = create();

    // When the delegated allowlist and schemas are inspected.
    const delegated = ['get_skill_file', 'list_repo_dir', 'search_repo_code'];

    // Then exactly those three names exist with their backward-compatible arguments.
    expect(delegated.filter((name) => server.handlers.has(name))).toEqual(delegated);
    for (const [name, expectedKeys] of Object.entries(expectedSchemas)) {
      expect(Object.keys(server.schemas.get(name) ?? {})).toEqual(expectedKeys);
    }
  });
});
