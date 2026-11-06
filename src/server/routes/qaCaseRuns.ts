import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { requirePermission } from '../middleware/rbac';
import { getDisplayName, getUserId } from '../utils/requestUser';
import { adoWriteForRequest, isAdoUserAuthError } from '../services/adoFactory';
import { AdoTestSuiteConflictError, getLatestAdoTestSuite } from '../services/adoTestCaseSuiteService';
import { QaCaseNotFoundError } from '../services/qaCaseRegenerationService';
import {
  MAX_RUN_ATTACHMENT_BYTES,
  QaCaseRunInputError,
  addRunAttachment,
  createRunBug,
  getCaseRunState,
  getRunAttachmentFile,
  publishCaseRun,
  removeRunAttachment,
  saveCaseRun,
} from '../services/qaCaseRunService';
import type { QaLabSaveCaseRunRequest } from '../../shared/types/qaLab';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_RUN_ATTACHMENT_BYTES, files: 1 } });
const RUN_PATH = '/ado-test-suites/:suiteId/cases/:localCaseId/run';
/** Only these open in the browser; anything else downloads, so an uploaded file cannot run script. */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain']);

async function runAdo(req: Request) {
  const suite = await getLatestAdoTestSuite(undefined, undefined, req.params.suiteId);
  if (!suite) throw new QaCaseNotFoundError('QA suite not found');
  return adoWriteForRequest(req, suite.project);
}

function runUser(req: Request) {
  return { id: getUserId(req), name: getDisplayName(req) };
}

function sendRunError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof QaCaseNotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof QaCaseRunInputError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof AdoTestSuiteConflictError) {
    res.status(409).json({ error: err.message });
    return;
  }
  if (isAdoUserAuthError(err)) {
    res.status(403).json({ error: err.message });
    return;
  }
  const status = (err as { statusCode?: number; status?: number })?.statusCode
    ?? (err as { status?: number })?.status;
  if (status === 401 || status === 403) {
    res.status(403).json({
      error: 'Azure DevOps denied access. Running tests needs Test Plans access (Basic + Test Plans or Visual Studio Enterprise).',
    });
    return;
  }
  next(err);
}

router.get(RUN_PATH, requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    res.json(await getCaseRunState(req.params.suiteId, req.params.localCaseId));
  } catch (err) {
    sendRunError(err, res, next);
  }
});

router.put(RUN_PATH, requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    res.json(await saveCaseRun(
      req.params.suiteId,
      req.params.localCaseId,
      (req.body ?? {}) as QaLabSaveCaseRunRequest,
      runUser(req),
    ));
  } catch (err) {
    sendRunError(err, res, next);
  }
});

router.post(`${RUN_PATH}/attachments`, requirePermission('interviews:manage'), (req, res, next) => {
  upload.single('file')(req, res, async (uploadErr: unknown) => {
    if (uploadErr) {
      const tooLarge = uploadErr instanceof multer.MulterError && uploadErr.code === 'LIMIT_FILE_SIZE';
      res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? 'Attachments can be up to 10 MB' : 'Invalid upload' });
      return;
    }
    try {
      const file = req.file;
      if (!file?.buffer) {
        res.status(400).json({ error: 'file is required' });
        return;
      }
      const rawStep = (req.body as { stepOrder?: unknown } | undefined)?.stepOrder;
      const stepOrder = rawStep === undefined || rawStep === '' ? undefined : Number(rawStep);
      if (stepOrder !== undefined && !Number.isInteger(stepOrder)) {
        res.status(400).json({ error: 'stepOrder must be a step number' });
        return;
      }
      res.status(201).json(await addRunAttachment(
        req.params.suiteId,
        req.params.localCaseId,
        {
          fileName: file.originalname.slice(0, 200),
          contentType: file.mimetype || null,
          content: file.buffer,
          ...(stepOrder !== undefined ? { stepOrder } : {}),
        },
        runUser(req),
      ));
    } catch (err) {
      sendRunError(err, res, next);
    }
  });
});

router.get(`${RUN_PATH}/attachments/:fileId`, requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const file = await getRunAttachmentFile(req.params.suiteId, req.params.localCaseId, req.params.fileId);
    const inline = file.contentType !== null && INLINE_TYPES.has(file.contentType);
    res.setHeader('Content-Type', inline && file.contentType ? file.contentType : 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    );
    res.send(file.content);
  } catch (err) {
    sendRunError(err, res, next);
  }
});

router.delete(`${RUN_PATH}/attachments/:fileId`, requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    res.json(await removeRunAttachment(req.params.suiteId, req.params.localCaseId, req.params.fileId));
  } catch (err) {
    sendRunError(err, res, next);
  }
});

router.post(`${RUN_PATH}/bug`, requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    res.status(201).json(await createRunBug(req.params.suiteId, req.params.localCaseId, await runAdo(req)));
  } catch (err) {
    sendRunError(err, res, next);
  }
});

router.post(`${RUN_PATH}/publish`, requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    res.json(await publishCaseRun(req.params.suiteId, req.params.localCaseId, await runAdo(req)));
  } catch (err) {
    sendRunError(err, res, next);
  }
});

export default router;
