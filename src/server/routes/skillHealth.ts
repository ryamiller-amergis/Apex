import { Router, type Request, type Response } from 'express';
import { getSkillHealthOverview } from '../services/skillHealthService';
import { createSkillHealthWorkItem, parseSkillHealthWorkItemRequest } from '../services/skillHealthWorkItemService';
import { getAdoTokenForUser } from '../services/adoUserToken';
import { isAdoUserAuthError } from '../services/adoFactory';
import { getUserId } from '../utils/requestUser';
import { SKILL_HEALTH_PERIOD_OPTIONS, type SkillHealthPeriodDays } from '../../shared/types/skillHealth';

/** Mounted under the Platform Admin router, which already requires a super admin. */
const router = Router();

function parsePeriod(raw: unknown): SkillHealthPeriodDays | null {
  const value = Number(raw ?? SKILL_HEALTH_PERIOD_OPTIONS[0]);
  return (SKILL_HEALTH_PERIOD_OPTIONS as readonly number[]).includes(value) ? (value as SkillHealthPeriodDays) : null;
}

router.get('/', async (req: Request, res: Response): Promise<void> => {
  const periodDays = parsePeriod(req.query.days);
  if (periodDays === null) {
    res.status(400).json({ error: `days must be one of ${SKILL_HEALTH_PERIOD_OPTIONS.join(', ')}` });
    return;
  }
  try {
    res.json(await getSkillHealthOverview(periodDays));
  } catch (err) {
    console.error('[skill-health] Failed to build overview:', err);
    res.status(500).json({ error: 'Failed to load Skill Health' });
  }
});

router.post('/work-items', async (req: Request, res: Response): Promise<void> => {
  const parsed = parseSkillHealthWorkItemRequest(req.body);
  if (typeof parsed === 'string') {
    res.status(400).json({ error: parsed });
    return;
  }
  try {
    const adoToken = parsed.destination === 'project-ado' ? await getAdoTokenForUser(req) : null;
    res.status(201).json(await createSkillHealthWorkItem(getUserId(req), adoToken, parsed));
  } catch (err) {
    if (isAdoUserAuthError(err)) {
      res.status(403).json({ error: err.message });
      return;
    }
    console.error('[skill-health] Failed to create work item:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to create work item' });
  }
});

export default router;
