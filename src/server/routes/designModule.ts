import { Router } from 'express';
import { requirePermission } from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import {
  createModule,
  deleteModule,
  getModule,
  listModules,
  regenerateModule,
  resolveGlobFiles,
  updateModule,
} from '../services/designModuleService';
import {
  cancelScoping,
  getScopingResult,
  startScoping,
} from '../services/designModuleScopingService';
import type {
  CreateDesignModuleInput,
  RegenerateDesignModuleInput,
  UpdateDesignModuleInput,
} from '../../shared/types/designModule';
import type {
  DesignModuleGlobPreviewRequest,
  DesignModuleScopingRequest,
} from '../../shared/types/designModuleScoping';
import { DesignModuleScopingError } from '../../shared/types/designModuleScoping';

const router = Router();

function handleScopingError(err: unknown, res: import('express').Response): void {
  if (err instanceof DesignModuleScopingError) {
    const status =
      err.code === 'NO_REPO_CONNECTED'
        ? 409
        : err.code === 'THREAD_NOT_FOUND'
          ? 404
          : err.code === 'DESIGN_MODULE_SCOPING_VALIDATION'
            ? 400
            : 400;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  throw err;
}

router.get(
  '/',
  requirePermission('design-module:view'),
  async (req, res, next) => {
    try {
      const project =
        typeof req.query.project === 'string' ? req.query.project.trim() : '';
      if (!project) {
        return res.status(400).json({ error: 'project query parameter is required' });
      }
      return res.json(await listModules(project));
    } catch (error) {
      next(error);
    }
  }
);

// Registered before /:slug so these paths are not captured as slugs.
router.post(
  '/scoping',
  requirePermission('design-module:manage'),
  async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as DesignModuleScopingRequest;
      if (!body.project?.trim()) {
        return res.status(400).json({ error: 'project is required' });
      }
      const started = await startScoping(
        body.project.trim(),
        body,
        getUserId(req)
      );
      return res.status(202).json(started);
    } catch (err) {
      try {
        handleScopingError(err, res);
      } catch {
        next(err);
      }
    }
  }
);

router.get(
  '/scoping/:threadId/result',
  requirePermission('design-module:manage'),
  async (req, res, next) => {
    try {
      const result = await getScopingResult(req.params.threadId, getUserId(req));
      return res.json(result);
    } catch (err) {
      try {
        handleScopingError(err, res);
      } catch {
        next(err);
      }
    }
  }
);

router.post(
  '/scoping/:threadId/cancel',
  requirePermission('design-module:manage'),
  async (req, res, next) => {
    try {
      const result = await cancelScoping(req.params.threadId, getUserId(req));
      return res.json(result);
    } catch (err) {
      try {
        handleScopingError(err, res);
      } catch {
        next(err);
      }
    }
  }
);

router.post(
  '/preview-globs',
  requirePermission('design-module:manage'),
  async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as DesignModuleGlobPreviewRequest & { project?: string };
      if (!Array.isArray(body.sourceGlobs) || body.sourceGlobs.length === 0) {
        return res
          .status(400)
          .json({ error: 'sourceGlobs must be a non-empty string array' });
      }
      const project = typeof body.project === 'string' ? body.project.trim() : '';
      if (project && project !== 'Apex') {
        return res.json({
          matches: body.sourceGlobs.map((g) => ({ pattern: g, files: [] })),
        });
      }
      const matches = resolveGlobFiles(body.sourceGlobs);
      return res.json({ matches });
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      if (status >= 400 && status < 500) {
        return res.status(status).json({
          error: error instanceof Error ? error.message : 'Invalid globs',
        });
      }
      next(error);
    }
  }
);

router.get(
  '/:slug',
  requirePermission('design-module:view'),
  async (req, res, next) => {
    try {
      const project =
        typeof req.query.project === 'string' ? req.query.project.trim() : '';
      if (!project) {
        return res.status(400).json({ error: 'project query parameter is required' });
      }
      const module = await getModule(project, req.params.slug);
      if (!module)
        return res.status(404).json({ error: 'Design module not found' });
      return res.json(module);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/',
  requirePermission('design-module:manage'),
  async (req, res, next) => {
    try {
      const body = req.body as CreateDesignModuleInput;
      if (!body.project?.trim()) {
        return res.status(400).json({ error: 'project is required' });
      }
      const project = body.project.trim();
      const created = await createModule({ ...body, project }, getUserId(req));

      try {
        const generation = await regenerateModule(created.slug, {
          project,
          force: true,
          actorId: getUserId(req),
        });
        return res.status(201).json({ ...created, generation });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Generation failed to start';
        return res.status(201).json({
          ...created,
          generation: { started: false, error: message },
        });
      }
    } catch (error) {
      next(error);
    }
  }
);

router.put(
  '/:slug',
  requirePermission('design-module:manage'),
  async (req, res, next) => {
    try {
      const project =
        typeof req.query.project === 'string' ? req.query.project.trim() : '';
      if (!project) {
        return res.status(400).json({ error: 'project query parameter is required' });
      }
      return res.json(
        await updateModule(
          project,
          req.params.slug,
          req.body as UpdateDesignModuleInput,
          getUserId(req)
        )
      );
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  '/:slug',
  requirePermission('design-module:manage'),
  async (req, res, next) => {
    try {
      const project =
        typeof req.query.project === 'string' ? req.query.project.trim() : '';
      if (!project) {
        return res.status(400).json({ error: 'project query parameter is required' });
      }
      const deleted = await deleteModule(project, req.params.slug);
      if (!deleted)
        return res.status(404).json({ error: 'Design module not found' });
      return res.status(204).send();
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/:slug/regenerate',
  requirePermission('design-module:regenerate'),
  async (req, res, next) => {
    try {
      const input = req.body as Partial<RegenerateDesignModuleInput>;
      if (!input.project?.trim()) {
        return res.status(400).json({ error: 'project is required' });
      }
      const result = await regenerateModule(req.params.slug, {
        project: input.project.trim(),
        force: input.force === true,
        actorId: getUserId(req),
      });
      return res.status(result.started ? 202 : 200).json(result);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
