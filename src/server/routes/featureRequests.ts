import { Router } from 'express';
import { requirePermission } from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import {
  createFeatureRequest,
  listFeatureRequests,
  getFeatureRequest,
  listAcceptedAdrsForProject,
  updateFeatureRequest,
  linkInterview,
  resolveApexReviewers,
} from '../services/featureRequestService';
import {
  WORK_ITEM_TYPES,
  type UpdateFeatureRequestDTO,
  type WorkItemType,
} from '../../shared/types/featureRequest';
import {
  autoStartFeatureRequestAnalysis,
  reanalyzeFeatureRequest,
} from '../services/featureRequestAnalysisService';
import { createNotification } from '../services/notificationService';

const router = Router();

// POST / — submit a new feature request
router.post('/', requirePermission('feature-requests:submit'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { type, title, request, advantage, project, adrIds } = req.body as {
      type?: WorkItemType;
      title?: string;
      request?: string;
      advantage?: string;
      project?: string;
      adrIds?: unknown;
    };

    if (!type || !WORK_ITEM_TYPES.includes(type)) {
      return res.status(400).json({ error: 'type must be feature, technical, or issue' });
    }
    if (!title?.trim() || !request?.trim() || !project?.trim()) {
      return res.status(400).json({ error: 'title, request, and project are required' });
    }
    if (adrIds !== undefined && (!Array.isArray(adrIds) || adrIds.some((id) => typeof id !== 'string'))) {
      return res.status(400).json({ error: 'adrIds must be an array of UUID strings' });
    }

    const created = await createFeatureRequest(userId, project, {
      type,
      title: title.trim(),
      request: request.trim(),
      advantage: advantage?.trim() || null,
      adrIds: adrIds as string[] | undefined,
    });

    // Notify Apex reviewers
    const reviewers = await resolveApexReviewers();
    for (const reviewerId of reviewers) {
      await createNotification(reviewerId, {
        type: 'user-action',
        title: {
          feature: 'New feature request',
          technical: 'New technical item',
          issue: 'New issue reported',
        }[type],
        body: created.title,
        link: '/feature-requests',
      });
    }

    // Fire-and-forget analysis
    autoStartFeatureRequestAnalysis(created.id).catch((err) => {
      console.error('[featureRequests] autoStartFeatureRequestAnalysis failed:', err);
    });

    return res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

// GET / — list feature requests (Apex project only)
router.get('/', requirePermission('feature-requests:view'), async (req, res, next) => {
  try {
    const project = req.query.project as string | undefined;
    if (project !== 'Apex') {
      return res.status(400).json({ error: 'project query parameter must be "Apex"' });
    }

    const requests = await listFeatureRequests();
    return res.json(requests);
  } catch (err) {
    next(err);
  }
});

router.get('/available-adrs', requirePermission('feature-requests:submit'), async (req, res, next) => {
  try {
    const project = (req.query.project as string | undefined)?.trim();
    if (!project) {
      return res.status(400).json({ error: 'project query parameter is required' });
    }
    return res.json(await listAcceptedAdrsForProject(project));
  } catch (err) {
    next(err);
  }
});

// GET /:id — get a single feature request
router.get('/:id', requirePermission('feature-requests:view'), async (req, res, next) => {
  try {
    const featureRequest = await getFeatureRequest(req.params.id);
    if (!featureRequest) {
      return res.status(404).json({ error: 'Feature request not found' });
    }
    return res.json(featureRequest);
  } catch (err) {
    next(err);
  }
});

// PATCH /:id — update a feature request (status, teamPriority, teamRisk, rank)
router.patch('/:id', requirePermission('feature-requests:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const patch = req.body as UpdateFeatureRequestDTO;

    if (patch.status === undefined && patch.teamPriority === undefined && patch.teamRisk === undefined && patch.rank === undefined) {
      return res.status(400).json({ error: 'At least one field (status, teamPriority, teamRisk, rank) is required' });
    }

    const existing = await getFeatureRequest(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Feature request not found' });
    }

    const updated = await updateFeatureRequest(req.params.id, userId, patch);
    return res.json(updated);
  } catch (err) {
    next(err);
  }
});

// POST /:id/link-interview — link a created interview to a feature request
router.post('/:id/link-interview', requirePermission('feature-requests:manage'), async (req, res, next) => {
  try {
    const { interviewId } = req.body as { interviewId?: string };
    const normalizedInterviewId = interviewId?.trim();
    if (!normalizedInterviewId) {
      return res.status(400).json({ error: 'interviewId is required' });
    }

    const existing = await getFeatureRequest(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Feature request not found' });
    }

    const updated = await linkInterview(req.params.id, normalizedInterviewId);
    return res.json(updated);
  } catch (err) {
    next(err);
  }
});

// POST /:id/reanalyze — trigger re-analysis
router.post('/:id/reanalyze', requirePermission('feature-requests:manage'), async (req, res, next) => {
  try {
    const existing = await getFeatureRequest(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Feature request not found' });
    }

    await reanalyzeFeatureRequest(req.params.id);
    return res.status(202).json({ message: 'Re-analysis started' });
  } catch (err) {
    next(err);
  }
});

export default router;
