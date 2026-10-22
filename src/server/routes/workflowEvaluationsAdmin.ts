/**
 * Admin reads for workflow evaluations. Mounted by the workflow evaluations
 * router at /admin, so its project pin and project access checks run first.
 */
import { Router, type NextFunction, type Response } from 'express';
import { requirePermission } from '../middleware/rbac';
import { requireWorkflowEvaluationFlag } from '../middleware/workflowEvaluationAccess';
import { getUserId } from '../utils/requestUser';
import {
  ADMIN_EVALUATION_EXPORT_FORMATS,
  type AdminEvaluationExportFormat,
} from '../../shared/types/workflowEvaluationAdmin';
import {
  AdminEvaluationRequestError,
  decodeAdminEvaluationCursor,
  exportAdminEvaluationEvents,
  getAdminEvaluationEventDetail,
  getAdminEvaluationJudgeAppendix,
  listAdminEvaluationEvents,
  parseAdminEvaluationFilters,
  parseAdminEvaluationLimit,
  type JudgeAppendixResult,
} from '../services/workflowEvaluationAdminService';

const router = Router({ mergeParams: true });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use(requirePermission('admin:roles'));
router.use(requireWorkflowEvaluationFlag);

function projectId(params: Record<string, string | undefined>): string {
  return params.projectId ?? '';
}

function handleError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof AdminEvaluationRequestError) {
    res.status(400).json({ error: err.message });
    return;
  }
  next(err);
}

router.get('/events', async (req, res, next) => {
  try {
    const filters = parseAdminEvaluationFilters(req.query);
    const limit = parseAdminEvaluationLimit(req.query.limit);
    const cursor = decodeAdminEvaluationCursor(req.query.cursor);
    res.json(await listAdminEvaluationEvents(projectId(req.params), filters, { limit, cursor }));
  } catch (err) {
    handleError(err, res, next);
  }
});

router.get('/events/:eventId', async (req, res, next) => {
  try {
    const { eventId } = req.params;
    const event = UUID_RE.test(eventId)
      ? await getAdminEvaluationEventDetail(projectId(req.params), eventId)
      : null;
    if (!event) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json({ event });
  } catch (err) {
    handleError(err, res, next);
  }
});

router.get('/events/:eventId/judge-appendix', async (req, res, next) => {
  try {
    const { eventId } = req.params;
    if (!UUID_RE.test(eventId)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    let result: JudgeAppendixResult;
    try {
      result = await getAdminEvaluationJudgeAppendix(projectId(req.params), eventId);
    } catch (err) {
      console.error('[workflow-evaluations] judge appendix read failed', err);
      res.status(502).json({ error: 'The judge narrative could not be read.' });
      return;
    }
    if (result.status === 'not_found') {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json({ markdown: result.markdown });
  } catch (err) {
    handleError(err, res, next);
  }
});

function isExportFormat(value: unknown): value is AdminEvaluationExportFormat {
  return typeof value === 'string' && (ADMIN_EVALUATION_EXPORT_FORMATS as readonly string[]).includes(value);
}

router.get('/export', async (req, res, next) => {
  try {
    const { format } = req.query;
    if (!isExportFormat(format)) {
      res.status(400).json({ error: 'format must be json or csv' });
      return;
    }
    const filters = parseAdminEvaluationFilters(req.query);
    const result = await exportAdminEvaluationEvents(
      projectId(req.params),
      filters,
      format,
      getUserId(req),
    );
    if (result.status === 'too_many') {
      res.status(422).json({
        error: `More than ${result.limit} events match. Narrow the filters and export again.`,
        code: 'EXPORT_TOO_LARGE',
      });
      return;
    }
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('X-Export-Row-Count', String(result.rowCount));
    res.send(result.body);
  } catch (err) {
    handleError(err, res, next);
  }
});

export default router;
