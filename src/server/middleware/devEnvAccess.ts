import type { Request, Response } from 'express';
import {
  DEV_ENV_ACCESS_DENIED_CODE,
  DEV_ENV_ACCESS_DENIED_MESSAGE,
} from '../../shared/types/devEnvAllowlist';
import { isDevEnvironmentAllowed } from '../services/devEnvAllowlistService';
import { getAppEnvironment } from '../utils/superAdmin';
import { getUserEmail } from '../utils/requestUser';

/**
 * On the dev site, allow the request only for platform admins and emails on the
 * dev access list. Returns true when the request may continue.
 * Sends 403 and returns false when the signed-in user is not approved.
 */
export async function enforceDevEnvironmentAccess(req: Request, res: Response): Promise<boolean> {
  if (getAppEnvironment() !== 'dev') return true;
  const allowed = await isDevEnvironmentAllowed(getUserEmail(req));
  if (allowed) return true;
  res.status(403).json({
    error: DEV_ENV_ACCESS_DENIED_MESSAGE,
    code: DEV_ENV_ACCESS_DENIED_CODE,
  });
  return false;
}
