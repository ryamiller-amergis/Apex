import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getSkillFile,
  listRepoDir,
  searchRepoCode,
  listSkills,
} from '../../services/skillCatalogGitHub';

/**
 * Lightweight GitHub-backed MCP server that exposes read-only repo browsing
 * tools. Used by the Ask Apex agent to look up source code, docs, and skills
 * on demand without needing a local clone of the repo.
 */
export function createGitHubMcpServer(): McpServer {
  const server = new McpServer({
    name: 'github-repo',
    version: '1.0.0',
  });

  server.tool(
    'get_skill_file',
    'Read the raw content of any file in the GitHub repo by path. ' +
    'Use this to read source code, documentation, SKILL.md files, CHANGELOG, README, etc.',
    {
      repo: z.string().describe('Repository name'),
      path: z.string().describe('File path in the repo (e.g. "src/client/components/Foo.tsx", "README.md")'),
      branch: z.string().optional().describe('Branch name (defaults to "main")'),
      org: z.string().optional().describe('GitHub org (defaults to GITHUB_ORG env)'),
    },
    async ({ repo, path, branch, org }) => {
      try {
        const content = await getSkillFile(repo, path, branch, org);
        return { content: [{ type: 'text', text: content }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error reading file: ${message}` }] };
      }
    },
  );

  server.tool(
    'list_repo_dir',
    'List the immediate children (files and sub-folders) of a directory in the GitHub repo. ' +
    'Use this to discover file structure before reading specific files.',
    {
      repo: z.string().describe('Repository name'),
      path: z.string().describe('Directory path (e.g. "/", "src/client/components", ".cursor/skills")'),
      branch: z.string().optional().describe('Branch name (defaults to "main")'),
      org: z.string().optional().describe('GitHub org (defaults to GITHUB_ORG env)'),
    },
    async ({ repo, path, branch, org }) => {
      try {
        const entries = await listRepoDir(repo, path, branch, org);
        return { content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }] };
      } catch {
        return { content: [{ type: 'text', text: '[]' }] };
      }
    },
  );

  server.tool(
    'search_repo_code',
    'Search code in the GitHub repo by keyword. Returns matching file paths with text snippets. ' +
    'Use this to find where a feature, component, or concept is implemented.',
    {
      repo: z.string().describe('Repository name'),
      query: z.string().describe('Search query (keywords, symbol name, or phrase)'),
      branch: z.string().optional().describe('Branch name (best-effort)'),
      org: z.string().optional().describe('GitHub org (defaults to GITHUB_ORG env)'),
      limit: z.number().int().min(1).max(30).optional().describe('Maximum results (default 10)'),
    },
    async ({ repo, query, branch, org, limit }) => {
      try {
        const results = await searchRepoCode(repo, query, branch, org, limit ?? 10);
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Search error: ${message}` }] };
      }
    },
  );

  server.tool(
    'list_skills',
    'List all available skills (SKILL.md files) in the repo.',
    {
      repo: z.string().describe('Repository name'),
      branch: z.string().optional().describe('Branch name (defaults to "main")'),
      org: z.string().optional().describe('GitHub org (defaults to GITHUB_ORG env)'),
    },
    async ({ repo, branch, org }) => {
      try {
        const skills = await listSkills(repo, branch, org);
        const summary = skills.map(s => ({
          name: s.name,
          description: s.description,
          path: s.path,
        }));
        return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error listing skills: ${message}` }] };
      }
    },
  );

  return server;
}
