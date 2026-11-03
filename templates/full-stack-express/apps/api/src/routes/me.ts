import {
  getMe,
  putMe,
  zodIssuesToProblemErrors,
  type AnyRoute,
} from '@project-scope/contracts';
import express, { type Router } from 'express';
import { RequestValidationError } from '../http/problems.ts';
import { getPrincipal } from '../identity/index.ts';
import type { ProfileService } from '../services/profileService.ts';
import { mountedAt } from './inventory.ts';

export const API_V1_PREFIX = '/api/v1';

function pathUnder(prefix: string, route: AnyRoute): string {
  if (!route.path.startsWith(`${prefix}/`)) {
    throw new Error(`${route.id} is not under ${prefix}`);
  }
  return route.path.slice(prefix.length);
}

/**
 * The caller's own profile. The router registers no path parameter, and the
 * handlers read the caller only through getPrincipal(res): nothing in the
 * path, query, headers, or body can pick whose profile is used. Responses go
 * through the contract schema, so a handler cannot send a field it omits.
 */
export function createMeRouter(deps: { profiles: ProfileService }): Router {
  const router = mountedAt(express.Router(), API_V1_PREFIX);

  router.get(pathUnder(API_V1_PREFIX, getMe), async (_req, res) => {
    const profile = await deps.profiles.getOwnProfile(getPrincipal(res));
    res.json(getMe.responses[200].body.parse(profile));
  });

  router.put(pathUnder(API_V1_PREFIX, putMe), async (req, res) => {
    const parsed = putMe.request.body.safeParse(req.body);
    if (!parsed.success) {
      throw new RequestValidationError(
        zodIssuesToProblemErrors(parsed.error.issues)
      );
    }
    const profile = await deps.profiles.updateOwnProfile(
      getPrincipal(res),
      parsed.data
    );
    res.json(putMe.responses[200].body.parse(profile));
  });

  return router;
}
