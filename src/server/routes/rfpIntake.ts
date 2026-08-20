import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import {
  RFP_ATTACHMENT_MAX_BYTES,
  isRfpHumanStatus,
  isRfpVerdict,
  validateRfpAttachments,
  validateRfpIntakePayload,
  type RfpHumanStatus,
  type RfpIntakePayload,
  type RfpVerdict,
} from '../../shared/types/rfpIntake';
import { getUserId } from '../utils/requestUser';
import { isSuperAdminRequest } from '../utils/superAdmin';
import { requirePermission } from '../middleware/rbac';
import { isFeatureEnabled } from '../services/featureFlagService';
import {
  APEX_PROJECT,
  addAttachment,
  addComment,
  answerClarification,
  createRequest,
  dispatchRfpNotifications,
  getAttachment,
  getOwnerRequestDetail,
  getTriageDetail,
  listComments,
  listMentionCandidates,
  listOwnerRequests,
  listTriageRequests,
  reevaluate,
  reopenRequest,
  resolveRfpSubmissionRecipients,
  retryEvaluation,
  applyReviewerDecision,
  RfpIntakeError,
  setRfpEvaluationNotificationHook,
  transitionStatus,
} from '../services/rfpIntakeService';
import { askEvaluationChat, listEvaluationChat } from '../services/rfpEvaluationChatService';
import { createNotification } from '../services/notificationService';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: RFP_ATTACHMENT_MAX_BYTES, files: 5 },
});

function acceptAttachments(
  req: import('express').Request,
  res: import('express').Response,
  next: import('express').NextFunction,
): void {
  upload.array('attachments', 5)(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(400).json({ error: 'Attachment exceeds 10 MB' });
        return;
      }
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        res.status(400).json({ error: 'At most 5 attachments are allowed' });
        return;
      }
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  });
}

function emptyToNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function parseIntakeBody(body: Record<string, unknown>): RfpIntakePayload {
  const requestType = emptyToNull(body.requestType);
  return {
    title: typeof body.title === 'string' ? body.title : '',
    stakeholder: typeof body.stakeholder === 'string' ? body.stakeholder : '',
    request: typeof body.request === 'string' ? body.request : '',
    problem: typeof body.problem === 'string' ? body.problem : '',
    audience: (typeof body.audience === 'string' ? body.audience : '') as RfpIntakePayload['audience'],
    dataSensitivity: (typeof body.dataSensitivity === 'string'
      ? body.dataSensitivity
      : '') as RfpIntakePayload['dataSensitivity'],
    existingSolution: typeof body.existingSolution === 'string' ? body.existingSolution : '',
    advantage: emptyToNull(body.advantage),
    constraints: emptyToNull(body.constraints),
    requestType: requestType as RfpIntakePayload['requestType'],
    existingSystemStack: requestType === 'change-existing' ? emptyToNull(body.existingSystemStack) : null,
  };
}

function fieldErrors(messages: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const message of messages) {
    const key = message.split(' ')[0];
    if (key) fields[key] = message;
  }
  return fields;
}

function handleRfpError(
  err: unknown,
  res: import('express').Response,
  next: import('express').NextFunction,
): void {
  if (err instanceof RfpIntakeError) {
    const payload: { error: string; code: string; fields?: Record<string, string> } = {
      error: err.message,
      code: err.code,
    };
    if (err.code === 'VALIDATION') {
      payload.fields = fieldErrors(err.message.split('; '));
    }
    res.status(err.status).json(payload);
    return;
  }
  next(err);
}

function filesFromRequest(req: import('express').Request): Express.Multer.File[] {
  if (Array.isArray(req.files)) return req.files;
  return [];
}

async function persistUploadedFiles(
  rfpId: string,
  actorId: string,
  files: Express.Multer.File[],
): Promise<void> {
  for (const file of files) {
    await addAttachment(rfpId, actorId, {
      filename: file.originalname,
      contentType: file.mimetype,
      sizeBytes: file.size,
      buffer: file.buffer,
    });
  }
}

async function notifySubmission(created: { id: string; title: string }): Promise<void> {
  const recipients = await resolveRfpSubmissionRecipients();
  for (const userId of recipients) {
    await createNotification(userId, {
      type: 'user-action',
      title: 'New request for product',
      body: created.title,
      link: `/rfp-intake/${created.id}`,
    });
  }
}

router.post('/requests', acceptAttachments, async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const payload = parseIntakeBody((req.body ?? {}) as Record<string, unknown>);
    const intakeErrors = validateRfpIntakePayload(payload);
    if (intakeErrors.length > 0) {
      return res.status(400).json({
        error: intakeErrors.join('; '),
        fields: fieldErrors(intakeErrors),
      });
    }

    const files = filesFromRequest(req);
    const fileErrors = validateRfpAttachments(
      files.map((file) => ({
        filename: file.originalname,
        contentType: file.mimetype,
        sizeBytes: file.size,
      })),
    );
    if (fileErrors.length > 0) {
      return res.status(400).json({ error: fileErrors.join('; '), fields: fieldErrors(fileErrors) });
    }

    const created = await createRequest(userId, payload);
    if (files.length > 0) {
    await persistUploadedFiles(created.id, userId, files);
    }
    await notifySubmission(created);
    return res.status(201).json(created);
  } catch (err) {
    handleRfpError(err, res, next);
  }
});

router.get('/requests/mine', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const limit = Number.parseInt(String(req.query.limit ?? '50'), 10);
    const offset = Number.parseInt(String(req.query.offset ?? '0'), 10);
    const result = await listOwnerRequests(userId, {
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    });
    return res.json(result);
  } catch (err) {
    handleRfpError(err, res, next);
  }
});

router.get('/requests/:id', async (req, res, next) => {
  try {
    const detail = await getOwnerRequestDetail(req.params.id, getUserId(req));
    return res.json(detail);
  } catch (err) {
    handleRfpError(err, res, next);
  }
});

router.post('/requests/:id/clarify', upload.none(), async (req, res, next) => {
  try {
    const payload = parseIntakeBody((req.body ?? {}) as Record<string, unknown>);
    const updated = await answerClarification(req.params.id, getUserId(req), payload);
    return res.json(updated);
  } catch (err) {
    handleRfpError(err, res, next);
  }
});

router.get('/requests/:id/comments', async (req, res, next) => {
  try {
    const comments = await listComments(req.params.id, getUserId(req));
    return res.json(comments);
  } catch (err) {
    handleRfpError(err, res, next);
  }
});

router.post('/requests/:id/comments', async (req, res, next) => {
  try {
    const body = typeof req.body?.body === 'string' ? req.body.body : '';
    const mentionedUserIds = Array.isArray(req.body?.mentionedUserIds)
      ? req.body.mentionedUserIds.filter((id: unknown) => typeof id === 'string')
      : [];
    const attachmentIds = Array.isArray(req.body?.attachmentIds)
      ? req.body.attachmentIds.filter((id: unknown) => typeof id === 'string')
      : [];
    const comment = await addComment(req.params.id, getUserId(req), {
      body,
      mentionedUserIds,
      attachmentIds,
    });
    return res.status(201).json(comment);
  } catch (err) {
    handleRfpError(err, res, next);
  }
});

router.get('/requests/:id/evaluation-chat', async (req, res, next) => {
  try {
    const messages = await listEvaluationChat(req.params.id, getUserId(req));
    return res.json(messages);
  } catch (err) {
    handleRfpError(err, res, next);
  }
});

router.post('/requests/:id/evaluation-chat', async (req, res, next) => {
  try {
    const message = typeof req.body?.message === 'string' ? req.body.message : '';
    const created = await askEvaluationChat(req.params.id, getUserId(req), message);
    return res.status(201).json(created);
  } catch (err) {
    handleRfpError(err, res, next);
  }
});

router.post('/requests/:id/attachments', acceptAttachments, async (req, res, next) => {
  try {
    const files = filesFromRequest(req);
    if (files.length === 0) {
      return res.status(400).json({ error: 'At least one attachment is required' });
    }
    const fileErrors = validateRfpAttachments(
      files.map((file) => ({
        filename: file.originalname,
        contentType: file.mimetype,
        sizeBytes: file.size,
      })),
    );
    if (fileErrors.length > 0) {
      return res.status(400).json({ error: fileErrors.join('; '), fields: fieldErrors(fileErrors) });
    }
    const stored = [];
    for (const file of files) {
      stored.push(await addAttachment(req.params.id, getUserId(req), {
        filename: file.originalname,
        contentType: file.mimetype,
        sizeBytes: file.size,
        buffer: file.buffer,
      }));
    }
    return res.status(201).json(stored.length === 1 ? stored[0] : stored);
  } catch (err) {
    handleRfpError(err, res, next);
  }
});

router.get('/requests/:id/attachments/:attachmentId', async (req, res, next) => {
  try {
    const { attachment, filePath } = await getAttachment(
      req.params.id,
      req.params.attachmentId,
      getUserId(req),
    );
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'RFP not found' });
    }
    res.setHeader('Content-Type', attachment.contentType);
    res.setHeader('Content-Disposition', `inline; filename="${attachment.filename.replace(/"/g, '')}"`);
    return fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    handleRfpError(err, res, next);
  }
});

function forceApexProject(
  req: import('express').Request,
  _res: import('express').Response,
  next: import('express').NextFunction,
): void {
  req.query = { ...req.query, project: APEX_PROJECT };
  next();
}

async function requireRfpIntakeFlag(
  req: import('express').Request,
  res: import('express').Response,
  next: import('express').NextFunction,
): Promise<void> {
  try {
    const enabled = await isFeatureEnabled('rfp-intake', {
      userId: getUserId(req),
      project: APEX_PROJECT,
    });
    // @feature-flag:rfp-intake start winner=enabled
    if (!enabled) {
      // @feature-flag:rfp-intake disabled-start
      res.status(404).json({ error: 'Not found' });
      return;
      // @feature-flag:rfp-intake disabled-end
    }
    // @feature-flag:rfp-intake enabled-start
    next();
    // @feature-flag:rfp-intake enabled-end
    // @feature-flag:rfp-intake end
  } catch (err) {
    next(err);
  }
}

const triageView = [requireRfpIntakeFlag, forceApexProject, requirePermission('rfp-intake:view')];
const triageManage = [requireRfpIntakeFlag, forceApexProject, requirePermission('rfp-intake:manage')];

router.get('/triage/requests', ...triageView, async (req, res, next) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const verdict = typeof req.query.verdict === 'string' ? req.query.verdict : undefined;
    const result = await listTriageRequests(getUserId(req), {
      status: status && isRfpHumanStatus(status) ? status : undefined,
      verdict: verdict && isRfpVerdict(verdict) ? verdict : undefined,
      q: typeof req.query.q === 'string' ? req.query.q : undefined,
      limit: Number.parseInt(String(req.query.limit ?? '50'), 10),
      offset: Number.parseInt(String(req.query.offset ?? '0'), 10),
    }, { isSuperAdmin: isSuperAdminRequest(req) });
    return res.json(result);
  } catch (err) {
    handleRfpError(err, res, next);
  }
});

router.get('/triage/requests/:id', ...triageView, async (req, res, next) => {
  try {
    const detail = await getTriageDetail(req.params.id, getUserId(req), {
      isSuperAdmin: isSuperAdminRequest(req),
    });
    return res.json(detail);
  } catch (err) {
    handleRfpError(err, res, next);
  }
});

router.patch('/triage/requests/:id/status', ...triageManage, async (req, res, next) => {
  try {
    const target = req.body?.target as RfpHumanStatus;
    const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
    const detail = await transitionStatus(req.params.id, target, getUserId(req), {
      note,
      isSuperAdmin: isSuperAdminRequest(req),
    });
    return res.json(detail);
  } catch (err) {
    handleRfpError(err, res, next);
  }
});

router.post('/triage/requests/:id/reopen', ...triageManage, async (req, res, next) => {
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
    const detail = await reopenRequest(req.params.id, getUserId(req), reason, {
      isSuperAdmin: isSuperAdminRequest(req),
    });
    return res.json(detail);
  } catch (err) {
    handleRfpError(err, res, next);
  }
});

router.post('/triage/requests/:id/retry', ...triageManage, async (req, res, next) => {
  try {
    const updated = await retryEvaluation(req.params.id, getUserId(req));
    return res.json(updated);
  } catch (err) {
    handleRfpError(err, res, next);
  }
});

router.post('/triage/requests/:id/reevaluate', ...triageManage, async (req, res, next) => {
  try {
    const updated = await reevaluate(req.params.id, getUserId(req));
    return res.json(updated);
  } catch (err) {
    handleRfpError(err, res, next);
  }
});

router.post('/triage/requests/:id/reviewer-decision', ...triageManage, async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const updated = await applyReviewerDecision(req.params.id, getUserId(req), {
      verdict: body.verdict as RfpVerdict,
      rationale: typeof body.rationale === 'string' ? body.rationale : '',
      constraintsToAdd: typeof body.constraintsToAdd === 'string' ? body.constraintsToAdd : null,
      sourceMessageIds: Array.isArray(body.sourceMessageIds) ? body.sourceMessageIds : [],
      reevaluate: body.reevaluate !== false,
    }, { isSuperAdmin: isSuperAdminRequest(req) });
    return res.json(updated);
  } catch (err) {
    handleRfpError(err, res, next);
  }
});

router.get('/mentions/candidates', ...triageView, async (req, res, next) => {
  try {
    const rfpId = typeof req.query.rfpId === 'string' ? req.query.rfpId : '';
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const candidates = await listMentionCandidates(rfpId, q);
    return res.json(candidates);
  } catch (err) {
    handleRfpError(err, res, next);
  }
});

setRfpEvaluationNotificationHook(async ({ kind, request }) => {
  await dispatchRfpNotifications({
    kind: kind === 'completed' ? 'evaluation-completed' : 'evaluation-failed',
    request,
  });
});

export default router;
