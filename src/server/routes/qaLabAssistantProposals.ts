import { Router, type NextFunction, type Response } from 'express';
import { requirePermission } from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import { AdoTestSuiteConflictError } from '../services/adoTestCaseSuiteService';
import { QaCaseNotFoundError } from '../services/qaCaseRegenerationService';
import { QaLabAssistantThreadError } from '../services/qaLabAssistantService';
import {
  confirmAllProposals,
  confirmProposal,
  discardAllProposals,
  discardProposal,
  listProposals,
} from '../services/qaLabAssistantProposalService';

const router = Router();
const PROPOSALS_PATH = '/qa-lab/assistant-threads/:threadId/proposals';

function sendProposalError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof QaCaseNotFoundError || err instanceof QaLabAssistantThreadError) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof AdoTestSuiteConflictError) {
    res.status(409).json({ error: err.message });
    return;
  }
  next(err);
}

router.get(PROPOSALS_PATH, requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    res.json(await listProposals(req.params.threadId, getUserId(req)));
  } catch (err) {
    sendProposalError(err, res, next);
  }
});

router.post(`${PROPOSALS_PATH}/confirm-all`, requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    res.json(await confirmAllProposals(req.params.threadId, getUserId(req)));
  } catch (err) {
    sendProposalError(err, res, next);
  }
});

router.post(`${PROPOSALS_PATH}/discard-all`, requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    res.json(await discardAllProposals(req.params.threadId, getUserId(req)));
  } catch (err) {
    sendProposalError(err, res, next);
  }
});

router.post(`${PROPOSALS_PATH}/:proposalId/confirm`, requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    res.json(await confirmProposal(req.params.threadId, req.params.proposalId, getUserId(req)));
  } catch (err) {
    sendProposalError(err, res, next);
  }
});

router.post(`${PROPOSALS_PATH}/:proposalId/discard`, requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    res.json(await discardProposal(req.params.threadId, req.params.proposalId, getUserId(req)));
  } catch (err) {
    sendProposalError(err, res, next);
  }
});

export default router;
