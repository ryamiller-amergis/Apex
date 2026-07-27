/**
 * Foundation Skills admin routes — mounted under /api/platform-admin/foundation-skills
 *
 * All routes inherit the `requireSuperAdmin` guard applied by the parent
 * platformAdmin.ts router before this sub-router is reached.
 */

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
} from '../services/foundationSkillReleaseService';
import {
  checkCompatibility,
  listRepoStatuses,
} from '../services/foundationSkillCompatibilityService';
import { listCandidates } from '../services/azureArtifactsSkillService';
import type { CreateFoundationSkillReleaseRequest } from '../../shared/types/foundationSkills';

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

router.post('/check-compatibility', async (req: Request, res: Response): Promise<void> => {
  try {
    const { provider, project, repo, branch, candidateVersion } = req.body;
    if (!project?.trim()) { res.status(400).json({ error: 'project is required' }); return; }
    if (!repo?.trim())    { res.status(400).json({ error: 'repo is required' }); return; }

    const report = await checkCompatibility(
      { provider: provider ?? 'ado', project, repo, branch, candidateVersion },
      { id: getUserId(req) },
    );
    res.json({ report });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to check compatibility' });
  }
});

export default router;
