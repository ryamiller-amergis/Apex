import { Router } from 'express';
import { requireAiRunnerAuth } from '../middleware/aiRunnerAuth';
import {
  CabReleaseBrokerError,
  forwardCabAdoRequest,
} from '../services/cabReleaseBrokerService';

const router = Router();

router.post('/ado', requireAiRunnerAuth, async (req, res, next) => {
  try {
    const result = await forwardCabAdoRequest(req.body);
    res.status(200).json(result);
  } catch (error) {
    if (error instanceof CabReleaseBrokerError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    next(error);
  }
});

export default router;
