/**
 * Foundation Skills admin routes — mounted under /api/platform-admin/foundation-skills
 *
 * All routes inherit the `requireSuperAdmin` guard applied by the parent
 * platformAdmin.ts router before this sub-router is reached.
 */

import path from 'path';
import fs from 'fs';
import { Router, Request, Response } from 'express';
import { getUserId, getUserEmail } from '../utils/requestUser';
import {
  listReleases,
  getRelease,
  createRelease,
  publishRelease,
  deprecateRelease,
  deleteDraftRelease,
  getReleaseAudit,
  updateRelease,
  getSkillsMatrix,
  getProjectAvailableSkills,
  listRollbackTargets,
  rejectNonShippableSkills,
  type CatalogSkillEntry,
} from '../services/foundationSkillReleaseService';
import {
  checkCompatibility,
  listRepoStatuses,
} from '../services/foundationSkillCompatibilityService';
import { getFoundationSkillTeams } from '../services/foundationSkillTeamsService';
import { sweepAllRepos } from '../services/foundationSkillScanScheduler';
import { listCandidates } from '../services/azureArtifactsSkillService';
import {
  updateRepoWithFoundationSkills,
  rollbackRepoWithFoundationSkills,
} from '../services/foundationSkillRepoUpdateService';
import { AzureDevOpsService } from '../services/azureDevOps';
import type { CreateFoundationSkillReleaseRequest } from '../../shared/types/foundationSkills';

// ── Catalog helper ────────────────────────────────────────────────────────────

interface CatalogFile {
  suiteVersion: string;
  skills: CatalogSkillEntry[];
}

let _catalogCache: CatalogFile | null = null;

/**
 * Resolve catalog.json across local (ts-node) and deployed (dist/) layouts.
 *
 * Candidates (first existing wins):
 *   1. ../../../foundation-skills — repo root from src/server/routes, or wwwroot from dist/server/routes
 *   2. ../../foundation-skills    — dist/foundation-skills when catalog is copied next to compiled server
 *   3. process.cwd()/foundation-skills — App Service wwwroot cwd fallback
 */
function resolveCatalogPath(): string | null {
  const candidates = [
    path.resolve(__dirname, '../../../foundation-skills/catalog.json'),
    path.resolve(__dirname, '../../foundation-skills/catalog.json'),
    path.resolve(process.cwd(), 'foundation-skills/catalog.json'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Reads foundation-skills/catalog.json — the single source of truth for which
 * skills exist. Cached per process, so a newly added skill needs a server
 * restart (or a call to invalidateCatalogCache) to appear.
 */
function loadCatalogFile(): CatalogFile {
  if (_catalogCache) return _catalogCache;
  try {
    const catalogPath = resolveCatalogPath();
    if (!catalogPath) {
      console.error(
        '[foundation-skills] catalog.json not found. Tried paths relative to',
        __dirname,
        'and cwd',
        process.cwd(),
        '— Skills picker will be empty until the file is packaged into the deploy.',
      );
      _catalogCache = { suiteVersion: '0.0.0', skills: [] };
      return _catalogCache;
    }
    const raw = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    _catalogCache = {
      suiteVersion: raw.suiteVersion ?? '0.0.0',
      skills: (raw.skills as Array<{ name: string; summary?: string; tier?: string }>).map((s) => ({
        name:    s.name,
        summary: s.summary ?? '',
        // Absent tier means the skill ships to teams.
        tier:    s.tier === 'apex-only' ? 'apex-only' as const : 'shippable' as const,
      })),
    };
    console.log(
      `[foundation-skills] Loaded catalog ${_catalogCache.suiteVersion} ` +
      `(${_catalogCache.skills.length} skills) from ${catalogPath}`,
    );
  } catch (err) {
    console.error('[foundation-skills] Failed to parse catalog.json:', err);
    _catalogCache = { suiteVersion: '0.0.0', skills: [] };
  }
  return _catalogCache;
}

function loadCatalog(): CatalogSkillEntry[] {
  return loadCatalogFile().skills;
}

/** Exported for tests and for picking up a newly added skill without a restart. */
export function invalidateCatalogCache(): void {
  _catalogCache = null;
}

const router = Router();

function actor(req: Request) {
  return { id: getUserId(req) ?? 'unknown', email: getUserEmail(req) ?? null };
}

// ── Candidates (from Azure Artifacts Local view) ──────────────────────────────

router.get('/candidates', async (_req: Request, res: Response): Promise<void> => {
  try {
    const candidates = await listCandidates();
    res.json({ candidates });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to list candidates' });
  }
});

// ── Releases CRUD ─────────────────────────────────────────────────────────────

router.get('/releases', async (_req: Request, res: Response): Promise<void> => {
  try {
    const releases = await listReleases();
    res.json({ releases });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to list releases' });
  }
});

router.post('/releases', async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body as CreateFoundationSkillReleaseRequest;
    if (!body.version?.trim())         { res.status(400).json({ error: 'version is required' }); return; }
    if (!body.artifactVersion?.trim()) { res.status(400).json({ error: 'artifactVersion is required' }); return; }
    if (!Array.isArray(body.selectedSkills)) { res.status(400).json({ error: 'selectedSkills must be an array' }); return; }
    // skillTargets is optional — default {} means all skills inherit release-level targetProjects
    if (body.skillTargets !== undefined && (typeof body.skillTargets !== 'object' || Array.isArray(body.skillTargets))) {
      res.status(400).json({ error: 'skillTargets must be an object mapping skill names to project arrays' });
      return;
    }
    const notShippable = rejectNonShippableSkills(body.selectedSkills, loadCatalog());
    if (notShippable.length > 0) {
      res.status(400).json({
        error: `These skills run inside Apex and cannot be released to projects: ${notShippable.join(', ')}`,
      });
      return;
    }

    const release = await createRelease(body, actor(req));
    res.status(201).json({ release });
  } catch (err: any) {
    if (err.message?.includes('unique')) {
      res.status(409).json({ error: `A release with this version already exists` });
      return;
    }
    res.status(500).json({ error: err.message ?? 'Failed to create release' });
  }
});

router.get('/releases/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const release = await getRelease(req.params.id);
    if (!release) { res.status(404).json({ error: 'Release not found' }); return; }
    res.json({ release });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to get release' });
  }
});

router.post('/releases/:id/publish', async (req: Request, res: Response): Promise<void> => {
  try {
    const release = await publishRelease(req.params.id, actor(req));
    res.json({ release });
  } catch (err: any) {
    if (err.message?.includes('not in \'draft\'')) {
      res.status(409).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err.message ?? 'Failed to publish release' });
  }
});

router.post('/releases/:id/deprecate', async (req: Request, res: Response): Promise<void> => {
  try {
    const release = await deprecateRelease(req.params.id, actor(req), req.body?.reason ?? null);
    res.json({ release });
  } catch (err: any) {
    if (err.message?.includes('draft')) {
      res.status(409).json({ error: err.message });
      return;
    }
    if (err.message?.includes('not found')) {
      res.status(404).json({ error: 'Release not found' });
      return;
    }
    res.status(500).json({ error: err.message ?? 'Failed to deprecate release' });
  }
});

router.delete('/releases/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    await deleteDraftRelease(req.params.id, actor(req));
    res.status(204).send();
  } catch (err: any) {
    if (err.message?.includes('not found')) {
      res.status(404).json({ error: 'Release not found' });
      return;
    }
    if (err.message?.includes('Only draft')) {
      res.status(409).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err.message ?? 'Failed to delete release' });
  }
});

router.patch('/releases/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      releaseNotes, breakingChanges, targetProjects, skillTargets, selectedSkills,
      version, artifactVersion, artifactFeed,
    } = req.body;
    if (Array.isArray(selectedSkills)) {
      const notShippable = rejectNonShippableSkills(selectedSkills, loadCatalog());
      if (notShippable.length > 0) {
        res.status(400).json({
          error: `These skills run inside Apex and cannot be released to projects: ${notShippable.join(', ')}`,
        });
        return;
      }
    }
    const release = await updateRelease(req.params.id, actor(req), {
      ...(releaseNotes    !== undefined && { releaseNotes }),
      ...(breakingChanges !== undefined && { breakingChanges }),
      ...(targetProjects  !== undefined && { targetProjects }),
      ...(skillTargets    !== undefined && { skillTargets }),
      ...(selectedSkills  !== undefined && { selectedSkills }),
      ...(version         !== undefined && { version }),
      ...(artifactVersion !== undefined && { artifactVersion }),
      ...(artifactFeed    !== undefined && { artifactFeed }),
    });
    res.json({ release });
  } catch (err: any) {
    if (err.message?.includes('not found')) { res.status(404).json({ error: 'Release not found' }); return; }
    if (err.message?.includes('draft')) { res.status(409).json({ error: err.message }); return; }
    res.status(500).json({ error: err.message ?? 'Failed to update release' });
  }
});

router.get('/releases/:id/audit', async (req: Request, res: Response): Promise<void> => {
  try {
    const entries = await getReleaseAudit(req.params.id);
    res.json({ entries });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to get audit log' });
  }
});

// ── Repo status ───────────────────────────────────────────────────────────────

router.get('/repo-statuses', async (_req: Request, res: Response): Promise<void> => {
  try {
    const statuses = await listRepoStatuses();
    res.json({ statuses });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to list repo statuses' });
  }
});

// ── Repo update PR ────────────────────────────────────────────────────────────

/**
 * POST /api/platform-admin/foundation-skills/update-repo
 * Clone a consumer repo, install the selected release, and open a PR.
 * Body: { project, repo, provider?, defaultBranch?, releaseId?, selectedSkills? }
 */
router.post('/update-repo', async (req: Request, res: Response): Promise<void> => {
  const { project, repo, provider, defaultBranch, releaseId, selectedSkills, apexProject } = req.body;
  if (!project?.trim()) { res.status(400).json({ error: 'project is required' }); return; }
  if (!repo?.trim())    { res.status(400).json({ error: 'repo is required' }); return; }

  console.log(
    `[foundationSkillsAdmin] update-repo ` +
    `${provider ?? 'ado'}/${project}/${repo}@${defaultBranch ?? 'main'}` +
    (apexProject ? ` apexProject=${apexProject}` : '') +
    (releaseId ? ` releaseId=${releaseId}` : ''),
  );

  const actorInfo = actor(req);

  // Build an ADO service using the app-level PAT (Platform Admin action — no user token needed)
  let adoService: AzureDevOpsService | null = null;
  if (!provider || provider === 'ado') {
    try {
      adoService = new AzureDevOpsService(project);
    } catch {
      // Non-fatal — PR creation will be skipped with a warning
    }
  }

  try {
    const result = await updateRepoWithFoundationSkills(
      {
        project,
        repo,
        provider: provider ?? 'ado',
        defaultBranch: defaultBranch ?? 'main',
        releaseId,
        selectedSkills: Array.isArray(selectedSkills) ? selectedSkills : undefined,
        apexProject: apexProject ?? null,
        actor: { id: actorInfo.id, email: actorInfo.email },
      },
      adoService,
    );
    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /api/platform-admin/foundation-skills/rollback-targets
 * Published releases older than installedVersion and visible to the Apex project.
 * Query: apexProject, installedVersion
 */
router.get('/rollback-targets', async (req: Request, res: Response): Promise<void> => {
  const apexProject = (req.query.apexProject as string | undefined)?.trim();
  const installedVersion = (req.query.installedVersion as string | undefined)?.trim();
  if (!apexProject) { res.status(400).json({ error: 'apexProject query param is required' }); return; }
  if (!installedVersion) { res.status(400).json({ error: 'installedVersion query param is required' }); return; }

  try {
    const releases = await listRollbackTargets(apexProject, installedVersion);
    res.json({ releases });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to list rollback targets' });
  }
});

/**
 * POST /api/platform-admin/foundation-skills/rollback-repo
 * Roll a consumer repo back to a lower published release and open a PR.
 * Body: { project, repo, apexProject, releaseId, provider?, defaultBranch?, fromVersion? }
 */
router.post('/rollback-repo', async (req: Request, res: Response): Promise<void> => {
  const { project, repo, provider, defaultBranch, releaseId, apexProject, fromVersion } = req.body;
  if (!project?.trim())     { res.status(400).json({ error: 'project is required' }); return; }
  if (!repo?.trim())        { res.status(400).json({ error: 'repo is required' }); return; }
  if (!apexProject?.trim()) { res.status(400).json({ error: 'apexProject is required' }); return; }
  if (!releaseId?.trim())   { res.status(400).json({ error: 'releaseId is required' }); return; }

  const actorInfo = actor(req);

  let adoService: AzureDevOpsService | null = null;
  if (!provider || provider === 'ado') {
    try {
      adoService = new AzureDevOpsService(project);
    } catch {
      // Non-fatal — PR creation will be skipped with a warning
    }
  }

  try {
    const result = await rollbackRepoWithFoundationSkills(
      {
        project,
        repo,
        provider: provider ?? 'ado',
        defaultBranch: defaultBranch ?? 'main',
        apexProject: apexProject.trim(),
        releaseId: releaseId.trim(),
        fromVersion: fromVersion ?? null,
        actor: { id: actorInfo.id, email: actorInfo.email },
      },
      adoService,
    );
    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ── Skills matrix ─────────────────────────────────────────────────────────────

/**
 * GET /api/platform-admin/foundation-skills/skills/matrix
 * Returns the skills matrix: all 31 skills × all releases they appear in,
 * with resolved effective audience per release.
 */
/**
 * The catalog of known skills. This is the single source of truth the admin UI
 * reads, so adding a skill to catalog.json is enough to make it selectable.
 */
router.get('/catalog', (_req: Request, res: Response): void => {
  const { suiteVersion, skills } = loadCatalogFile();
  res.json({ suiteVersion, skills });
});

router.get('/skills/matrix', async (_req: Request, res: Response): Promise<void> => {
  try {
    const catalog = loadCatalog();
    const skills = await getSkillsMatrix(catalog);
    res.json({ skills });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to build skills matrix' });
  }
});

/**
 * GET /api/platform-admin/foundation-skills/project-skills?project=<name>
 * Returns skills available to the given Apex project from the latest published release.
 * Safe for Project Admin consumption — only returns published data.
 */
router.get('/project-skills', async (req: Request, res: Response): Promise<void> => {
  const project = req.query.project as string | undefined;
  if (!project?.trim()) { res.status(400).json({ error: 'project query param is required' }); return; }
  try {
    const catalog = loadCatalog();
    const skills = await getProjectAvailableSkills(project.trim(), catalog);
    res.json({ skills });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to get project skills' });
  }
});

/**
 * GET /api/platform-admin/foundation-skills/teams
 * Active teams grid: every Apex project with a registered skills repo, its
 * installed version, that version's release status, and the skills shipped to it.
 */
router.get('/teams', async (_req: Request, res: Response): Promise<void> => {
  try {
    const teams = await getFoundationSkillTeams();
    res.json({ teams });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to load teams' });
  }
});

/**
 * POST /api/platform-admin/foundation-skills/repos/scan-all
 * Re-checks every registered repo on demand. The scheduler does this on a timer;
 * this is the manual refresh for when an admin wants current data immediately.
 */
router.post('/repos/scan-all', async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await sweepAllRepos(getUserId(req));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to sweep repos' });
  }
});

router.post('/check-compatibility', async (req: Request, res: Response): Promise<void> => {
  try {
    const { provider, project, repo, branch, candidateVersion, apexProject } = req.body;
    if (!project?.trim()) { res.status(400).json({ error: 'project is required' }); return; }
    if (!repo?.trim())    { res.status(400).json({ error: 'repo is required' }); return; }

    const report = await checkCompatibility(
      { provider: provider ?? 'ado', project, repo, branch, candidateVersion, apexProject: apexProject ?? null },
      { id: getUserId(req) },
    );
    res.json({ report });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to check compatibility' });
  }
});

export default router;
