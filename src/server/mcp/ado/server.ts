import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  listProjects,
  listRepos,
  listSkills,
  getSkill,
  getSkillFile,
  listRepoDir,
  searchRepoCode,
  searchSkills,
} from '../../services/skillCatalog';
import {
  listWikis,
  listWikiPages,
  getWikiPage,
} from '../../services/wikiCatalog';
import { AzureDevOpsService } from '../../services/azureDevOps';
import { getThread } from '../../services/chatAgentService';
import { updateDesignDocContent, syncDesignDocContent, getDesignDoc } from '../../services/designDocService';
import { resolveComment } from '../../services/reviewCommentService';
import { db } from '../../db/drizzle';
import { eq } from 'drizzle-orm';
import { prds } from '../../db/schema';

// ── Exported handlers (testable units) ────────────────────────────────────────

export async function handleUpdatePrd(params: {
  threadId: string;
  prdId: string;
  section: 'content' | 'backlog';
  content: string;
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const thread = await getThread(params.threadId);
  if (!thread) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: 'Thread not found' }) }] };
  }
  try {
    const now = new Date().toISOString();
    if (params.section === 'content') {
      await db
        .update(prds)
        .set({ proposedContent: params.content, updatedAt: now })
        .where(eq(prds.id, params.prdId));
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(params.content);
      } catch {
        parsed = params.content;
      }
      await db
        .update(prds)
        .set({ proposedBacklogJson: parsed as any, updatedAt: now })
        .where(eq(prds.id, params.prdId));
    }
    console.log(`[MCP] update_prd: saved ${params.section} for prd ${params.prdId}`);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, section: params.section }) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[MCP] update_prd: FAILED ${params.section} for prd ${params.prdId} — ${message}`);
    return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
  }
}

export async function handleResolvePrdComment(params: {
  threadId: string;
  commentId: string;
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const thread = await getThread(params.threadId);
  if (!thread) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: 'Thread not found' }) }] };
  }
  try {
    await resolveComment(params.commentId, thread.userId);
    console.log(`[MCP] resolve_prd_comment: resolved comment ${params.commentId}`);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, commentId: params.commentId }) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[MCP] resolve_prd_comment: FAILED ${params.commentId} — ${message}`);
    return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
  }
}

export function createAdoMcpServer(): McpServer {
  const server = new McpServer({
    name: 'ado-skills',
    version: '1.0.0',
  });

  // ── Skills namespace ────────────────────────────────────────────────────────

  server.tool(
    'list_projects',
    'List all Azure DevOps projects the configured PAT can access.',
    {},
    async () => {
      const projects = await listProjects();
      return {
        content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }],
      };
    },
  );

  server.tool(
    'list_repos',
    'List all repositories in an Azure DevOps project.',
    { project: z.string().describe('ADO project name') },
    async ({ project }) => {
      const repos = await listRepos(project);
      return {
        content: [{ type: 'text', text: JSON.stringify(repos, null, 2) }],
      };
    },
  );

  server.tool(
    'list_skills',
    'List all skills (SKILL.md files) available in a repository. Skills are discovered under skills/ and .cursor/skills/ directories.',
    {
      project: z.string().describe('ADO project name'),
      repo: z.string().describe('Repository name'),
      branch: z.string().optional().describe('Branch name (defaults to repo default branch)'),
    },
    async ({ project, repo, branch }) => {
      const skills = await listSkills(project, repo, branch);
      return {
        content: [{ type: 'text', text: JSON.stringify(skills, null, 2) }],
      };
    },
  );

  server.tool(
    'get_skill',
    'Get the full content and metadata of a skill, including its SKILL.md body and a list of supporting files in the same folder (e.g. PRD-FORMAT.md, INTERVIEW-RUBRIC.md).',
    {
      project: z.string().describe('ADO project name'),
      repo: z.string().describe('Repository name'),
      path: z.string().describe('Path to the SKILL.md file, e.g. /skills/product/prd-generation/SKILL.md'),
      branch: z.string().optional().describe('Branch name'),
    },
    async ({ project, repo, path, branch }) => {
      const skill = await getSkill(project, repo, path, branch);
      return {
        content: [{ type: 'text', text: JSON.stringify(skill, null, 2) }],
      };
    },
  );

  server.tool(
    'list_repo_dir',
    'List the immediate children (files and sub-folders) of a directory in the repo. Use this BEFORE calling get_skill_file when you are unsure of exact file paths — e.g. to discover whether /docs/adr/, /docs/, /handbook/, or /CONTEXT.md exist. Returns each entry with its full path, name, and whether it is a folder. If a path does not exist the tool returns an empty list.',
    {
      project: z.string().describe('ADO project name'),
      repo: z.string().describe('Repository name'),
      path: z.string().describe('Directory path to list (e.g. "/", "/docs", "/docs/adr"). Leading slash is optional.'),
      branch: z.string().optional().describe('Branch name'),
    },
    async ({ project, repo, path, branch }) => {
      try {
        const entries = await listRepoDir(project, repo, path, branch);
        return {
          content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }],
        };
      } catch {
        return {
          content: [{ type: 'text', text: '[]' }],
        };
      }
    },
  );

  server.tool(
    'get_skill_file',
    'Get the raw content of ANY file in the repo by absolute path (path starts with "/"). Use this for skill supporting files (PRD-FORMAT.md, INTERVIEW-RUBRIC.md, examples/) AND for repo-wide context files the skill may reference such as /CONTEXT.md, /AGENTS.md, /README.md, /docs/adr/*.md, glossaries, etc. The agent runs in a sandbox workspace with no local clone of the repo, so this is the only way to read project files.',
    {
      project: z.string().describe('ADO project name'),
      repo: z.string().describe('Repository name'),
      path: z.string().describe('Absolute path in the repo, starting with "/" (e.g. "/CONTEXT.md", "/.cursor/skills/foo/PRD-FORMAT.md", "/docs/adr/0001-foo.md")'),
      branch: z.string().optional().describe('Branch name'),
    },
    async ({ project, repo, path, branch }) => {
      const content = await getSkillFile(project, repo, path, branch);
      return {
        content: [{ type: 'text', text: content }],
      };
    },
  );

  server.tool(
    'search_repo_code',
    'Search code in a repository by keyword and return matching file paths with snippets. Use this when you need to locate implementation areas quickly before reading full files.',
    {
      project: z.string().describe('ADO project name'),
      repo: z.string().describe('Repository name'),
      query: z.string().describe('Search query (keywords, symbol, or phrase)'),
      branch: z.string().optional().describe('Branch name (best-effort; may use indexed default branch)'),
      limit: z.number().int().min(1).max(50).optional().describe('Maximum results (default 10)'),
    },
    async ({ project, repo, query, branch, limit }) => {
      const results = await searchRepoCode(project, repo, query, branch, limit ?? 10);
      return {
        content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
      };
    },
  );

  server.tool(
    'search_skills',
    'Search for skills by keyword across name and description fields.',
    {
      project: z.string().describe('ADO project name'),
      repo: z.string().describe('Repository name'),
      query: z.string().describe('Search query'),
      branch: z.string().optional().describe('Branch name'),
      limit: z.number().int().min(1).max(20).optional().describe('Maximum results (default 10)'),
    },
    async ({ project, repo, query, branch, limit }) => {
      const allSkills = await listSkills(project, repo, branch);
      const results = searchSkills(allSkills, query, limit ?? 10);
      return {
        content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
      };
    },
  );

  // ── Design Doc write-back ───────────────────────────────────────────────────

  server.tool(
    'update_design_doc',
    'Update one section of the current design doc (design, tech-spec, or assumptions) and save it to the database. ' +
    'Call this when the user explicitly asks you to apply, save, or write changes to the doc. ' +
    'Only one section can be updated per call — make multiple calls to update multiple sections.',
    {
      threadId: z.string().describe('The current session thread ID (from .ai-pilot/session.json)'),
      docId: z.string().describe('The design doc ID (from .ai-pilot/kickoff-context.md)'),
      section: z.enum(['design', 'tech-spec', 'assumptions']).describe('Which section to update'),
      content: z.string().describe('The full new markdown content for the section'),
    },
    async ({ threadId, docId, section, content }) => {
      const thread = await getThread(threadId);
      if (!thread) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Thread not found' }) }] };
      }
      const opts =
        section === 'design'      ? { designContent: content } :
        section === 'tech-spec'   ? { techSpecContent: content } :
                                    { assumptionsContent: content };
      try {
        // Check if the doc is in fix mode (has fixBaseline set). If so, the
        // update was initiated by the fix-validation flow and the thread may
        // have been created by a different user (e.g. a reviewer). Use the
        // auth-free syncDesignDocContent to avoid permission mismatches.
        const doc = await getDesignDoc(docId);
        if (doc?.fixBaseline) {
          await syncDesignDocContent(docId, opts);
        } else {
          await updateDesignDocContent(docId, thread.userId, opts);
        }
        console.log(`[MCP] update_design_doc: saved ${section} for doc ${docId} (fixMode=${!!doc?.fixBaseline})`);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, section }) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[MCP] update_design_doc: FAILED ${section} for doc ${docId} — ${message}`);
        return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
      }
    },
  );

  // ── PRD write-back ──────────────────────────────────────────────────────────

  server.tool(
    'update_prd',
    'Update the proposed content or backlog of the current PRD and save it to the database as a draft proposal. ' +
    'Call this when the user asks you to apply, save, or write changes to the PRD or its backlog. ' +
    'Pass section="content" to update the PRD narrative; pass section="backlog" to update the backlog JSON.',
    {
      threadId: z.string().describe('The current session thread ID (from .ai-pilot/session.json)'),
      prdId: z.string().describe('The PRD ID (from .ai-pilot/kickoff-context.md)'),
      section: z.enum(['content', 'backlog']).describe('Which part to update: "content" for the PRD narrative, "backlog" for the JSON backlog'),
      content: z.string().describe('The full new content for the section (markdown for content; JSON string for backlog)'),
    },
    async (params) => handleUpdatePrd(params),
  );

  server.tool(
    'resolve_prd_comment',
    'Mark a review comment on the current PRD as resolved. Call this after you have addressed a comment by updating the PRD or backlog.',
    {
      threadId: z.string().describe('The current session thread ID (from .ai-pilot/session.json)'),
      commentId: z.string().describe('The ID of the comment to resolve (from the Review Comments section in kickoff-context.md)'),
    },
    async (params) => handleResolvePrdComment(params),
  );

  // ── Wiki namespace ──────────────────────────────────────────────────────────

  server.tool(
    'list_wikis',
    'List all wikis in an Azure DevOps project.',
    { project: z.string().describe('ADO project name') },
    async ({ project }) => {
      const wikis = await listWikis(project);
      return {
        content: [{ type: 'text', text: JSON.stringify(wikis, null, 2) }],
      };
    },
  );

  server.tool(
    'list_wiki_pages',
    'List pages under a wiki path (one level deep).',
    {
      project: z.string().describe('ADO project name'),
      wikiId: z.string().describe('Wiki ID or name'),
      path: z.string().optional().describe('Parent path (default: root)'),
    },
    async ({ project, wikiId, path }) => {
      const pages = await listWikiPages(project, wikiId, path ?? '/');
      return {
        content: [{ type: 'text', text: JSON.stringify(pages, null, 2) }],
      };
    },
  );

  server.tool(
    'get_wiki_page',
    'Get the content of a wiki page. Use to read PRDs or other documents stored in the project wiki.',
    {
      project: z.string().describe('ADO project name'),
      wikiId: z.string().describe('Wiki ID or name'),
      path: z.string().describe('Page path, e.g. /PRDs/Foo-Feature'),
    },
    async ({ project, wikiId, path }) => {
      const page = await getWikiPage(project, wikiId, path);
      return {
        content: [{ type: 'text', text: JSON.stringify(page, null, 2) }],
      };
    },
  );

  // ── Work items namespace ─────────────────────────────────────────────────────

  const workItemSpec = z.object({
    type: z
      .enum(['Epic', 'Feature', 'Product Backlog Item', 'Task', 'Bug'])
      .describe('ADO work item type'),
    title: z.string().describe('Work item title'),
    description: z.string().optional().describe('HTML or plain-text description'),
    parentTitle: z
      .string()
      .optional()
      .describe('Title of a previously created item in this batch to use as parent'),
    tags: z.array(z.string()).optional().describe('Tags to apply'),
  });

  server.tool(
    'query_work_items',
    'Run a WIQL query and return matching work items with selected fields.',
    {
      project: z.string().describe('ADO project name'),
      wiql: z.string().describe('Raw WIQL query text'),
      areaPath: z
        .string()
        .optional()
        .describe('Optional area path override (e.g. "MyProject\\MyTeam")'),
      fields: z
        .array(z.string())
        .optional()
        .describe('Optional list of fields to hydrate (defaults to all available fields)'),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('Maximum number of items to return (default 200, capped at 500)'),
      includeRelations: z
        .boolean()
        .optional()
        .describe('When true, include work item relations in each result'),
    },
    async ({ project, wiql, areaPath, fields, maxResults, includeRelations }) => {
      const adoService = new AzureDevOpsService(project, areaPath);
      const result = await adoService.queryWorkItemsByWiql({
        wiql,
        fields,
        maxResults,
        includeRelations,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'get_work_item_history',
    'Get revision history for a work item, including changed date/by and field snapshots.',
    {
      project: z.string().describe('ADO project name'),
      workItemId: z.number().int().describe('Work item ID'),
      areaPath: z
        .string()
        .optional()
        .describe('Optional area path override (e.g. "MyProject\\MyTeam")'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('Maximum number of most recent revisions to return (default 100)'),
    },
    async ({ project, workItemId, areaPath, limit }) => {
      const adoService = new AzureDevOpsService(project, areaPath);
      const history = await adoService.getWorkItemRevisionHistory(workItemId, limit ?? 100);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ workItemId, revisions: history }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'get_work_item_comment_history',
    'Get comment history for a work item, including author and timestamps.',
    {
      project: z.string().describe('ADO project name'),
      workItemId: z.number().int().describe('Work item ID'),
      areaPath: z
        .string()
        .optional()
        .describe('Optional area path override (e.g. "MyProject\\MyTeam")'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('Maximum number of most recent comments to return (default 200)'),
    },
    async ({ project, workItemId, areaPath, limit }) => {
      const adoService = new AzureDevOpsService(project, areaPath);
      const comments = await adoService.getWorkItemCommentHistory(workItemId, limit ?? 200);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ workItemId, comments }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'create_work_items',
    'Create one or more Azure DevOps work items from a PRD-generated list. ' +
    'Items are created in order so parents must appear before their children. ' +
    'Returns the created item IDs and URLs.',
    {
      project: z.string().describe('ADO project name'),
      areaPath: z
        .string()
        .optional()
        .describe('Area path override (e.g. "MyProject\\MyTeam"). Omit to use project root.'),
      wikiId: z
        .string()
        .optional()
        .describe('Wiki ID — when provided the PRD page URL will be linked to each work item'),
      wikiPagePath: z
        .string()
        .optional()
        .describe('Path to the PRD wiki page used for linking, e.g. /scrum-app-requirement/prd'),
      items: z.array(workItemSpec).min(1).describe('Work items to create, in dependency order'),
    },
    async ({ project, areaPath, wikiId, wikiPagePath, items }) => {
      // Resolve PRD wiki URL for hyperlinking (non-fatal if unavailable)
      let prdUrl: string | undefined;
      if (wikiId && wikiPagePath) {
        try {
          const page = await getWikiPage(project, wikiId, wikiPagePath, false);
          prdUrl = page.remoteUrl ?? page.url;
        } catch {
          // proceed without the link
        }
      }

      const adoService = new AzureDevOpsService(project, areaPath);
      const created: { title: string; id: number; url: string }[] = [];
      const titleToId = new Map<string, number>();

      for (const spec of items) {
        const parentId = spec.parentTitle ? titleToId.get(spec.parentTitle) : undefined;
        const wi = await adoService.createWorkItemForPrd({
          type: spec.type,
          title: spec.title,
          description: spec.description,
          parentId,
          prdUrl,
          tags: spec.tags,
        });
        titleToId.set(spec.title, wi.id);
        created.push({ title: spec.title, id: wi.id, url: wi.url });
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({ created }, null, 2) }],
      };
    },
  );

  // ── Prompts ──────────────────────────────────────────────────────────────────

  server.prompt(
    'start_skill',
    'Load and follow a skill from the ADO skills catalog.',
    {
      project: z.string().describe('ADO project name'),
      repo: z.string().describe('Repository name'),
      path: z.string().describe('Path to SKILL.md'),
      context: z.string().optional().describe('Additional context to pass to the skill'),
    },
    ({ project, repo, path, context }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Use the get_skill tool to load the skill at project="${project}" repo="${repo}" path="${path}", then follow the skill's instructions exactly.${context ? `\n\nContext:\n${context}` : ''}`,
          },
        },
      ],
    }),
  );

  server.prompt(
    'generate_prd',
    'Load the prd-generation skill and produce a PRD from a prior chat transcript.',
    {
      project: z.string().describe('ADO project name'),
      repo: z.string().describe('Repository containing the skill'),
      transcript: z.string().optional().describe('Prior chat transcript or context'),
    },
    ({ project, repo, transcript }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Use the list_skills tool to find the prd-generation skill in project="${project}" repo="${repo}".`,
              `Then load it with get_skill and follow its instructions to produce a PRD.`,
              transcript
                ? `\nThe following is a prior chat transcript to use as input context:\n\n${transcript}`
                : '',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        },
      ],
    }),
  );

  return server;
}
