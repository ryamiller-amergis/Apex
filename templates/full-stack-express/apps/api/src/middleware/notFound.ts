import type { RequestHandler } from 'express';
import { problems, sendProblem } from '../http/problems.ts';

/** Problem Details 404, so an unknown path never gets Express's HTML page. */
export function notFound(): RequestHandler {
  return (_req, res) => {
    sendProblem(res, problems.notFound);
  };
}
