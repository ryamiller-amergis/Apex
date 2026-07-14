import { Router } from 'express';
import { requirePermission } from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import {
  createFeatureRequest,
  listFeatureRequests,
  getFeatureRequest,
  updateFeatureRequest,
  linkInterview,
  resolveApexReviewers,
} from '../services/featureRequestService';
import type { UpdateFeatureRequestDTO } from '../../shared/types/featureRequest';
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
    const { title, request, advantage, project } = req.body as {
      title?: string;
      request?: string;
      advantage?: string;
      project?: string;
    };

    if (!title?.trim() || !request?.trim() || !advantage?.trim() || !project?.trim()) {
      return res.status(400).json({ error: 'title, request, advantage, and project are required' });
    }

    const created = await createFeatureRequest(userId, project, { title, request, advantage });

    // Notify Apex reviewers
    const reviewers = await resolveApexReviewers();
    for (const reviewerId of reviewers) {
      await createNotification(reviewerId, {
        type: 'user-action',
        title: 'New feature request',
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
