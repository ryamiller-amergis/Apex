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
  publishCaseRun,
  removeRunAttachment,
  saveCaseRun,
} from '../services/qaCaseRunService';
import type { QaLabSaveCaseRunRequest } from '../../shared/types/qaLab';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_RUN_ATTACHMENT_BYTES, files: 1 } });
const RUN_PATH = '/ado-test-suites/:suiteId/cases/:localCaseId/run';

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
    res.json(await getCaseRunState(req.params.suiteId, req.params.localCaseId, await runAdo(req)));
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
      await runAdo(req),
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
      const rawStepId = (req.body as { stepId?: unknown } | undefined)?.stepId;
      const stepId = rawStepId === undefined || rawStepId === '' ? undefined : Number(rawStepId);
      if (stepId !== undefined && !Number.isInteger(stepId)) {
        res.status(400).json({ error: 'stepId must be a step id' });
        return;
      }
      res.status(201).json(await addRunAttachment(
        req.params.suiteId,
        req.params.localCaseId,
        { fileName: file.originalname.slice(0, 200), content: file.buffer, ...(stepId !== undefined ? { stepId } : {}) },
        runUser(req),
        await runAdo(req),
      ));
    } catch (err) {
      sendRunError(err, res, next);
    }
  });
});

router.delete(`${RUN_PATH}/attachments/:attachmentId`, requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    res.json(await removeRunAttachment(req.params.suiteId, req.params.localCaseId, req.params.attachmentId));
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
