import { Router, type Request, type Response } from 'express';
import {
  SkillExperimentError,
  cancelSkillExperiment,
  getSkillExperiment,
  getSkillLearningSettings,
  listReplayableSkills,
  listSkillExperiments,
  retryPromotion,
  setSkillLearningBudget,
  startSkillExperiment,
  sweepSkillExperiments,
  type SkillExperimentErrorCode,
} from '../services/skillExperimentService';
import { sweepAbandonedBuildIntakes } from '../services/buildIntakeAbandonSweep';
import { sweepPostRelease } from '../services/skillPostRelease';
import { listCandidateFrontier } from '../services/skillCandidateFrontier';
import { sweepArtifactJudge } from '../services/skillArtifactJudge';
import { decideMinedCheck, listMinedChecks, MINED_STAGE_KEYS } from '../services/skillMinedChecks';
import {
  SkillSemanticCheckError,
  decideSemanticCheck,
  listSemanticChecks,
  startCheckMining,
  sweepStuckCheckMining,
  type SkillSemanticCheckErrorCode,
} from '../services/skillSemanticChecks';
import { getUserId } from '../utils/requestUser';
import {
  isSkillExperimentSubjectType,
  type StartSkillExperimentRequest,
} from '../../shared/types/skillExperiment';

/** Mounted under Skill Health, inside the Platform Admin router, which already requires a super admin. */
const router = Router();

const SWEEP_INTERVAL_MS = 2 * 60_000;
const SIGNAL_SWEEP_INTERVAL_MS = 60 * 60_000;
const MAX_CANDIDATE_CHARS = 200_000;

async function remainingBudget(project: string): Promise<number | null> {
  const settings = await getSkillLearningSettings(project);
  return settings.monthlyBudgetUsd === null ? null : settings.monthlyBudgetUsd - settings.spentThisMonthUsd;
}

if (process.env.NODE_ENV !== 'test') {
  setInterval(() => {
    sweepSkillExperiments().catch((err: unknown) => console.error('[skill-experiments] sweep failed:', err));
  }, SWEEP_INTERVAL_MS).unref();
  setInterval(() => {
    sweepAbandonedBuildIntakes().catch((err: unknown) => console.error('[skill-learning] abandoned-intake sweep failed:', err));
    sweepPostRelease().catch((err: unknown) => console.error('[skill-learning] post-release sweep failed:', err));
    sweepArtifactJudge({ remainingBudget }).catch((err: unknown) => console.error('[skill-learning] artifact judge sweep failed:', err));
    sweepStuckCheckMining().catch((err: unknown) => console.error('[skill-learning] check suggestion sweep failed:', err));
  }, SIGNAL_SWEEP_INTERVAL_MS).unref();
}

function statusFor(code: SkillExperimentErrorCode): number {
  switch (code) {
    case 'not_found':
      return 404;
    case 'flag_off':
    case 'budget_off':
      return 403;
    case 'budget_exceeded':
    case 'no_baseline':
    case 'not_enough_cases':
    case 'no_definition':
    case 'invalid_state':
      return 409;
    case 'candidate_invalid':
      return 422;
    default: {
      const unhandled: never = code;
      return unhandled;
    }
  }
}

function sendError(res: Response, err: unknown, action: string): void {
  if (err instanceof SkillExperimentError) {
    res.status(statusFor(err.code)).json({ error: err.message, code: err.code });
    return;
  }
  console.error(`[skill-experiments] Failed to ${action}:`, err);
  res.status(500).json({ error: `Failed to ${action}` });
}

function projectOf(req: Request, res: Response): string | null {
  const raw = req.method === 'GET' ? req.query.project : (req.body as { project?: unknown } | undefined)?.project;
  const project = typeof raw === 'string' ? raw.trim() : '';
  if (!project) {
    res.status(400).json({ error: 'project is required' });
    return null;
  }
  return project;
}

function parseStartRequest(body: unknown): StartSkillExperimentRequest | string {
  const input = (body ?? {}) as Record<string, unknown>;
  if (!isSkillExperimentSubjectType(input.subjectType)) return 'subjectType must be prd or design_doc';
  if (typeof input.skillPath !== 'string' || !input.skillPath.trim()) return 'skillPath is required';
  if (input.candidateContent !== undefined && typeof input.candidateContent !== 'string') return 'candidateContent must be text';
  if (typeof input.candidateContent === 'string' && input.candidateContent.length > MAX_CANDIDATE_CHARS) {
    return 'candidateContent is too long';
  }
  if (input.changeNotes !== undefined && typeof input.changeNotes !== 'string') return 'changeNotes must be text';
  if (input.maxCases !== undefined && (!Number.isInteger(input.maxCases) || (input.maxCases as number) < 1)) {
    return 'maxCases must be a positive whole number';
  }
  return {
    subjectType: input.subjectType,
    skillPath: input.skillPath.trim(),
    candidateContent: input.candidateContent as string | undefined,
    changeNotes: input.changeNotes as string | undefined,
    maxCases: input.maxCases as number | undefined,
  };
}

router.get('/settings', async (req: Request, res: Response): Promise<void> => {
  const project = projectOf(req, res);
  if (!project) return;
  try {
    res.json(await getSkillLearningSettings(project));
  } catch (err) {
    sendError(res, err, 'load Skill Learning settings');
  }
});

router.put('/settings', async (req: Request, res: Response): Promise<void> => {
  const project = projectOf(req, res);
  if (!project) return;
  const raw = (req.body as { monthlyBudgetUsd?: unknown }).monthlyBudgetUsd;
  if (raw !== null && (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 100_000)) {
    res.status(400).json({ error: 'monthlyBudgetUsd must be null or a number from 0 to 100000' });
    return;
  }
  try {
    res.json(await setSkillLearningBudget(project, raw, getUserId(req)));
  } catch (err) {
    sendError(res, err, 'save Skill Learning settings');
  }
});

router.get('/skills', async (req: Request, res: Response): Promise<void> => {
  const project = projectOf(req, res);
  if (!project) return;
  try {
    res.json(await listReplayableSkills(project));
  } catch (err) {
    sendError(res, err, 'list replayable Skills');
  }
});

router.get('/frontier', async (req: Request, res: Response): Promise<void> => {
  const project = projectOf(req, res);
  if (!project) return;
  const skillPath = typeof req.query.skillPath === 'string' ? req.query.skillPath.trim() : '';
  if (!skillPath) {
    res.status(400).json({ error: 'skillPath is required' });
    return;
  }
  try {
    res.json(await listCandidateFrontier(project, skillPath));
  } catch (err) {
    sendError(res, err, 'list the best candidates');
  }
});

router.get('/mined-checks', async (req: Request, res: Response): Promise<void> => {
  const project = projectOf(req, res);
  if (!project) return;
  try {
    res.json(await listMinedChecks(project));
  } catch (err) {
    sendError(res, err, 'list mined checks');
  }
});

router.put('/mined-checks', async (req: Request, res: Response): Promise<void> => {
  const project = projectOf(req, res);
  if (!project) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { stageKey, heading, support, decision } = body;
  if (typeof stageKey !== 'string' || !(MINED_STAGE_KEYS as readonly string[]).includes(stageKey)) {
    res.status(400).json({ error: 'stageKey is not a mined stage' });
    return;
  }
  if (typeof heading !== 'string' || !heading.trim() || heading.length > 80) {
    res.status(400).json({ error: 'heading must be 1 to 80 characters' });
    return;
  }
  if (!Number.isInteger(support) || (support as number) < 0) {
    res.status(400).json({ error: 'support must be a whole number' });
    return;
  }
  if (decision !== 'accepted' && decision !== 'dismissed') {
    res.status(400).json({ error: 'decision must be accepted or dismissed' });
    return;
  }
  try {
    await decideMinedCheck(project, getUserId(req), { stageKey, heading, support: support as number, decision });
    res.json(await listMinedChecks(project));
  } catch (err) {
    sendError(res, err, 'save the mined check');
  }
});

function semanticStatusFor(code: SkillSemanticCheckErrorCode): number {
  switch (code) {
    case 'not_found':
      return 404;
    case 'flag_off':
    case 'budget_off':
      return 403;
    case 'invalid_stage':
      return 400;
    case 'budget_exceeded':
    case 'not_enough_corrections':
    case 'already_running':
    case 'limit_reached':
      return 409;
    default: {
      const unhandled: never = code;
      return unhandled;
    }
  }
}

function sendSemanticError(res: Response, err: unknown, action: string): void {
  if (err instanceof SkillSemanticCheckError) {
    res.status(semanticStatusFor(err.code)).json({ error: err.message, code: err.code });
    return;
  }
  sendError(res, err, action);
}

router.get('/semantic-checks', async (req: Request, res: Response): Promise<void> => {
  const project = projectOf(req, res);
  if (!project) return;
  try {
    res.json(await listSemanticChecks(project));
  } catch (err) {
    sendError(res, err, 'list meaning checks');
  }
});

router.post('/semantic-checks/suggest', async (req: Request, res: Response): Promise<void> => {
  const project = projectOf(req, res);
  if (!project) return;
  const stageKey = (req.body as { stageKey?: unknown }).stageKey;
  if (typeof stageKey !== 'string') {
    res.status(400).json({ error: 'stageKey is required' });
    return;
  }
  try {
    await startCheckMining(project, getUserId(req), stageKey, { remainingBudget });
    res.status(202).json(await listSemanticChecks(project));
  } catch (err) {
    sendSemanticError(res, err, 'suggest meaning checks');
  }
});

router.put('/semantic-checks/:id', async (req: Request, res: Response): Promise<void> => {
  const project = projectOf(req, res);
  if (!project) return;
  const decision = (req.body as { decision?: unknown }).decision;
  if (decision !== 'accepted' && decision !== 'dismissed') {
    res.status(400).json({ error: 'decision must be accepted or dismissed' });
    return;
  }
  try {
    await decideSemanticCheck(project, getUserId(req), req.params.id, decision);
    res.json(await listSemanticChecks(project));
  } catch (err) {
    sendSemanticError(res, err, 'save the meaning check');
  }
});

router.get('/', async (req: Request, res: Response): Promise<void> => {
  const project = projectOf(req, res);
  if (!project) return;
  try {
    res.json(await listSkillExperiments(project));
  } catch (err) {
    sendError(res, err, 'list Skill experiments');
  }
});

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const project = projectOf(req, res);
  if (!project) return;
  const parsed = parseStartRequest(req.body);
  if (typeof parsed === 'string') {
    res.status(400).json({ error: parsed });
    return;
  }
  try {
    res.status(201).json(await startSkillExperiment(project, getUserId(req), parsed));
  } catch (err) {
    sendError(res, err, 'start the Skill experiment');
  }
});

router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  const project = projectOf(req, res);
  if (!project) return;
  try {
    const detail = await getSkillExperiment(project, req.params.id);
    if (!detail) {
      res.status(404).json({ error: 'Experiment not found' });
      return;
    }
    res.json(detail);
  } catch (err) {
    sendError(res, err, 'load the Skill experiment');
  }
});

router.post('/:id/cancel', async (req: Request, res: Response): Promise<void> => {
  const project = projectOf(req, res);
  if (!project) return;
  try {
    res.json(await cancelSkillExperiment(project, req.params.id));
  } catch (err) {
    sendError(res, err, 'cancel the Skill experiment');
  }
});

router.post('/:id/retry-promotion', async (req: Request, res: Response): Promise<void> => {
  const project = projectOf(req, res);
  if (!project) return;
  try {
    res.json(await retryPromotion(project, req.params.id));
  } catch (err) {
    sendError(res, err, 'open the pull request');
  }
});

export default router;
