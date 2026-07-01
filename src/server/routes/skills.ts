import { Router, Request, Response } from 'express';
import {
  listProjects,
  searchSkills,
  invalidateCache,
} from '../services/skillCatalog';
import * as facade from '../services/skillCatalogFacade';
import type { SkillProvider } from '../../shared/types/projectSettings';

const router = Router();

function resolveProvider(raw?: string): SkillProvider {
  return raw === 'github' ? 'github' : 'ado';
}

/**
 * GET /api/skills/projects
 * List all ADO projects the PAT can see.
 */
router.get('/projects', async (_req: Request, res: Response) => {
  try {
    const projects = await listProjects();
    res.json(projects);
  } catch (err: any) {
    console.error('[skills] listProjects error:', err.message);
    res.status(500).json({ error: err.message ?? 'Failed to list projects' });
  }
});

/**
 * GET /api/skills/repos?project=<name>&provider=<ado|github>
 * List repos in a project (or GitHub org).
 */
router.get('/repos', async (req: Request, res: Response) => {
  const { project, provider: providerRaw } = req.query as { project?: string; provider?: string };
  if (!project) return res.status(400).json({ error: 'project is required' });

  const provider = resolveProvider(providerRaw);
  try {
    const repos = await facade.listRepos(project, provider);
    res.json(repos);
  } catch (err: any) {
    console.error('[skills] listRepos error:', err.message);
    res.status(500).json({ error: err.message ?? 'Failed to list repos' });
  }
});

/**
 * GET /api/skills/branches?project=<name>&repo=<name>&provider=<ado|github>
 * List branch names for a repo, sorted with defaultBranch first.
 */
router.get('/branches', async (req: Request, res: Response) => {
  const { project, repo, provider: providerRaw } = req.query as { project?: string; repo?: string; provider?: string };
  if (!project) return res.status(400).json({ error: 'project is required' });
  if (!repo) return res.status(400).json({ error: 'repo is required' });

  const provider = resolveProvider(providerRaw);
  try {
    const branches = await facade.listBranches(project, repo, provider);
    res.json(branches);
  } catch (err: any) {
    console.error('[skills] listBranches error:', err.message);
    res.status(500).json({ error: err.message ?? 'Failed to list branches' });
  }
});

/**
 * GET /api/skills/list?project=<name>&repo=<name>&branch=<name>&provider=<ado|github>
 * List all skills (SKILL.md files) in a repo.
 */
router.get('/list', async (req: Request, res: Response) => {
  const { project, repo, branch, provider: providerRaw } = req.query as {
    project?: string;
    repo?: string;
    branch?: string;
    provider?: string;
  };

  if (!project) return res.status(400).json({ error: 'project is required' });
  if (!repo) return res.status(400).json({ error: 'repo is required' });

  const provider = resolveProvider(providerRaw);
  try {
    const skills = await facade.listSkills(project, repo, branch, provider);
    res.json(skills);
  } catch (err: any) {
    console.error('[skills] listSkills error:', err.message);
    res.status(500).json({ error: err.message ?? 'Failed to list skills' });
  }
});

/**
 * GET /api/skills/get?project=<name>&repo=<name>&path=<path>&branch=<name>&provider=<ado|github>
 * Get full skill detail (content + frontmatter + supporting files).
 */
router.get('/get', async (req: Request, res: Response) => {
  const { project, repo, path, branch, provider: providerRaw } = req.query as {
    project?: string;
    repo?: string;
    path?: string;
    branch?: string;
    provider?: string;
  };

  if (!project) return res.status(400).json({ error: 'project is required' });
  if (!repo) return res.status(400).json({ error: 'repo is required' });
  if (!path) return res.status(400).json({ error: 'path is required' });

  const provider = resolveProvider(providerRaw);
  try {
    const skill = await facade.getSkill(project, repo, path, branch, provider);
    res.json(skill);
  } catch (err: any) {
    console.error('[skills] getSkill error:', err.message);
    res.status(500).json({ error: err.message ?? 'Failed to get skill' });
  }
});

/**
 * GET /api/skills/file?project=<name>&repo=<name>&path=<path>&branch=<name>&provider=<ado|github>
 * Get raw content of a skill supporting file.
 */
router.get('/file', async (req: Request, res: Response) => {
  const { project, repo, path, branch, provider: providerRaw } = req.query as {
    project?: string;
    repo?: string;
    path?: string;
    branch?: string;
    provider?: string;
  };

  if (!project) return res.status(400).json({ error: 'project is required' });
  if (!repo) return res.status(400).json({ error: 'repo is required' });
  if (!path) return res.status(400).json({ error: 'path is required' });

  const provider = resolveProvider(providerRaw);
  try {
    const content = await facade.getSkillFile(project, repo, path, branch, provider);
    res.type('text/markdown').send(content);
  } catch (err: any) {
    console.error('[skills] getSkillFile error:', err.message);
    res.status(500).json({ error: err.message ?? 'Failed to get skill file' });
  }
});

/**
 * GET /api/skills/search?q=<query>&project=<name>&repo=<name>&limit=<n>&provider=<ado|github>
 * Search skills by name/description across a repo.
 */
router.get('/search', async (req: Request, res: Response) => {
  const { q, project, repo, branch, limit, provider: providerRaw } = req.query as {
    q?: string;
    project?: string;
    repo?: string;
    branch?: string;
    limit?: string;
    provider?: string;
  };

  if (!q) return res.status(400).json({ error: 'q is required' });
  if (!project) return res.status(400).json({ error: 'project is required' });
  if (!repo) return res.status(400).json({ error: 'repo is required' });

  const provider = resolveProvider(providerRaw);
  try {
    const allSkills = await facade.listSkills(project, repo, branch, provider);
    const results = searchSkills(allSkills, q, limit ? parseInt(limit, 10) : 10);
    res.json(results);
  } catch (err: any) {
    console.error('[skills] searchSkills error:', err.message);
    res.status(500).json({ error: err.message ?? 'Failed to search skills' });
  }
});

/**
 * POST /api/skills/refresh?project=<name>&repo=<name>&provider=<ado|github>
 * Manually invalidate the skill cache for a project/repo.
 */
router.post('/refresh', (req: Request, res: Response) => {
  const { project, repo, provider: providerRaw } = req.query as { project?: string; repo?: string; provider?: string };
  const provider = resolveProvider(providerRaw);
  facade.invalidateCache(project, repo, provider);
  if (provider === 'ado') {
    invalidateCache(project, repo);
  }
  res.json({ ok: true });
});

export default router;
