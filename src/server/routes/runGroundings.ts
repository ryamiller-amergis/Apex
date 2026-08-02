import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import type {
  GroundingSurface,
  RepoRole,
} from '../../shared/types/runGrounding';
import { requirePermission } from '../middleware/rbac';
import { isFeatureEnabled as evaluateFeatureFlag } from '../services/featureFlagService';
import {
  resolveRunGroundingSurface,
  runGroundingService,
  type ResolvedRunGroundingSurface,
  type RunGroundingService,
} from '../services/runGroundingService';
import { getUserId } from '../utils/requestUser';

const FEATURE_FLAG = 'repo-grounding-workspace-profile';

interface RunGroundingsRouterDependencies {
  service?: RunGroundingService;
  resolveSurface?: (
    surface: GroundingSurface,
    domainRunId: string
  ) => Promise<ResolvedRunGroundingSurface | null>;
  isFeatureEnabled?: typeof evaluateFeatureFlag;
  permissionMiddleware?: (...keys: string[]) => RequestHandler;
}

type GroundingRequest = Request & {
  groundingSurface?: ResolvedRunGroundingSurface;
};

const permissionBySurface: Record<GroundingSurface, string> = {
  interview: 'interviews:view',
  prd: 'prds:review',
  design_doc: 'design-docs:review',
};

function requestedRole(value: unknown): RepoRole | null {
  if (value === undefined) return 'target';
  return value === 'target' || value === 'skill' ? value : null;
}

export function createRunGroundingsRouter(
  dependencies: RunGroundingsRouterDependencies = {}
): express.Router {
  const router = express.Router();
  const service = dependencies.service ?? runGroundingService;
  const resolveSurface =
    dependencies.resolveSurface ?? resolveRunGroundingSurface;
  const isFeatureEnabled = dependencies.isFeatureEnabled ?? evaluateFeatureFlag;
  const permissionMiddleware =
    dependencies.permissionMiddleware ?? requirePermission;

  const loadAuthorizedSurface =
    (surface: GroundingSurface): RequestHandler =>
    async (req, res, next): Promise<void> => {
      try {
        const resolved = await resolveSurface(surface, req.params.domainRunId);
        const userId = getUserId(req);
        if (!resolved || !resolved.participantIds.includes(userId)) {
          res.status(404).json({ error: 'Run grounding not found' });
          return;
        }
        (req as GroundingRequest).groundingSurface = resolved;
        req.headers['x-apex-project'] = resolved.run.project;
        next();
      } catch (error) {
        next(error);
      }
    };

  async function withEnabledFeature(
    req: GroundingRequest,
    res: Response,
    action: (resolved: ResolvedRunGroundingSurface) => Promise<void>
  ): Promise<void> {
    const resolved = req.groundingSurface;
    if (!resolved) {
      res.status(404).json({ error: 'Run grounding not found' });
      return;
    }
    const enabled = await isFeatureEnabled(FEATURE_FLAG, {
      userId: getUserId(req),
      project: resolved.run.project,
    });

    // Retain the enabled branch after two stable sprints at full rollout.
    // @feature-flag:repo-grounding-workspace-profile start winner=enabled
    if (!enabled) {
      // @feature-flag:repo-grounding-workspace-profile disabled-start
      res.status(404).json({ error: 'Run grounding not found' });
      // @feature-flag:repo-grounding-workspace-profile disabled-end
      return;
    }

    // @feature-flag:repo-grounding-workspace-profile enabled-start
    await action(resolved);
    // @feature-flag:repo-grounding-workspace-profile enabled-end
    // @feature-flag:repo-grounding-workspace-profile end
  }

  const statusHandler = async (
    req: GroundingRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const role = requestedRole(req.query.role);
      if (!role) {
        res.status(400).json({ error: 'Invalid grounding role' });
        return;
      }
      await withEnabledFeature(req, res, async (resolved) => {
        const status = await service.getStatus(
          resolved.run,
          role,
          resolved.ownerId === getUserId(req)
        );
        res.json(status ? [status] : []);
      });
    } catch (error) {
      next(error);
    }
  };

  const reGroundHandler = async (
    req: GroundingRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const role = requestedRole(
        (req.body as { role?: unknown } | undefined)?.role
      );
      if (!role) {
        res.status(400).json({ error: 'Invalid grounding role' });
        return;
      }
      await withEnabledFeature(req, res, async (resolved) => {
        if (resolved.ownerId !== getUserId(req)) {
          res.status(403).json({ error: 'Forbidden' });
          return;
        }
        const result = await service.reGroundFromCache(resolved.run, role);
        if (!result) {
          res.status(409).json({ error: 'Cached origin is unavailable' });
          return;
        }
        res.json(result);
      });
    } catch (error) {
      next(error);
    }
  };

  for (const surface of Object.keys(
    permissionBySurface
  ) as GroundingSurface[]) {
    const basePath = `/${surface}/:domainRunId`;
    const authorize = permissionMiddleware(permissionBySurface[surface]);
    router.get(
      basePath,
      loadAuthorizedSurface(surface),
      authorize,
      statusHandler
    );
    router.post(
      `${basePath}/re-ground`,
      loadAuthorizedSurface(surface),
      authorize,
      reGroundHandler
    );
  }

  return router;
}

export default createRunGroundingsRouter();
