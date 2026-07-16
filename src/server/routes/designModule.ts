import { Router } from 'express';
import { requirePermission } from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import {
  createModule,
  deleteModule,
  getModule,
  listModules,
  regenerateModule,
  updateModule,
} from '../services/designModuleService';
import type {
  CreateDesignModuleInput,
  RegenerateDesignModuleInput,
  UpdateDesignModuleInput,
} from '../../shared/types/designModule';

const router = Router();

router.get(
  '/',
  requirePermission('design-module:view'),
  async (_req, res, next) => {
    try {
      return res.json(await listModules());
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/:slug',
  requirePermission('design-module:view'),
  async (req, res, next) => {
    try {
      const module = await getModule(req.params.slug);
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
      const created = await createModule(
        req.body as CreateDesignModuleInput,
        getUserId(req)
      );
      return res.status(201).json(created);
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
      return res.json(
        await updateModule(
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
      const deleted = await deleteModule(req.params.slug);
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
