import { Router, type Request, type Response } from 'express';
import { requirePermission } from '../middleware/rbac';
import * as rbacService from '../services/rbacService';
import * as projectSettingsService from '../services/projectSettingsService';
import { getDefaultModel, setAppSetting } from '../services/appSettingsService';
import { Cursor } from '@cursor/sdk';
import type {
  CreateRoleRequest,
  UpdateRoleRequest,
  UpdateRolePermissionsRequest,
  AssignRoleRequest,
} from '../../shared/types/rbac';
import type { UpsertProjectSkillConfigRequest } from '../../shared/types/projectSettings';

const router = Router();

// All admin routes require authentication (ensureAuthenticated is applied globally upstream)
// and the admin:roles permission
router.use(requirePermission('admin:roles'));

// ── Available Models cache ────────────────────────────────────────────────────

interface AvailableModel {
  id: string;
  displayName: string;
}

let modelsCache: AvailableModel[] | null = null;
let modelsCacheExpiry = 0;
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchAvailableModels(): Promise<AvailableModel[]> {
  const now = Date.now();
  if (modelsCache && now < modelsCacheExpiry) return modelsCache;

  try {
    const result = await Cursor.models.list();
    const models: AvailableModel[] = (result ?? []).map((m: { id: string; displayName?: string }) => ({
      id: m.id,
      displayName: m.displayName ?? m.id,
    }));
    modelsCache = models;
    modelsCacheExpiry = now + MODELS_CACHE_TTL_MS;
    return models;
  } catch {
    return modelsCache ?? [];
  }
}

// ── Roles ──────────────────────────────────────────────────────────────────────

router.get('/roles', async (_req: Request, res: Response): Promise<void> => {
  try {
    const roles = await rbacService.listRoles();
    res.json(roles);
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/roles', async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, description, permissionIds = [] } = req.body as CreateRoleRequest;
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const role = await rbacService.createRole(name, description, permissionIds);
    res.status(201).json(role);
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/roles/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const updates = req.body as UpdateRoleRequest;
    await rbacService.updateRole(id, updates);
    const updated = await rbacService.getRole(id);
    if (!updated) {
      res.status(404).json({ error: 'Role not found' });
      return;
    }
    res.json(updated);
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/roles/:id/permissions', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { permissionIds } = req.body as UpdateRolePermissionsRequest;
    if (!Array.isArray(permissionIds)) {
      res.status(400).json({ error: 'permissionIds must be an array' });
      return;
    }
    await rbacService.updateRolePermissions(id, permissionIds);
    res.status(204).send();
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/roles/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    await rbacService.deleteRole(id);
    res.status(204).send();
  } catch (err: any) {
    if (err instanceof Error && err.message.includes('default')) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Permissions ────────────────────────────────────────────────────────────────

router.get('/permissions', async (_req: Request, res: Response): Promise<void> => {
  try {
    const permissions = await rbacService.listPermissions();
    res.json(permissions);
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Users ──────────────────────────────────────────────────────────────────────

router.get('/users', async (_req: Request, res: Response): Promise<void> => {
  try {
    const users = await rbacService.listUsers();
    res.json(users);
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/users/:oid/roles', async (req: Request, res: Response): Promise<void> => {
  try {
    const { oid } = req.params;
    const { roleId } = req.body as AssignRoleRequest;
    if (!roleId) {
      res.status(400).json({ error: 'roleId is required' });
      return;
    }
    const assignedBy = (req.user as any)?.profile?.oid ?? 'unknown';
    await rbacService.assignRole(oid, roleId, assignedBy);
    res.status(201).send();
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/users/:oid/roles/:roleId', async (req: Request, res: Response): Promise<void> => {
  try {
    const { oid, roleId } = req.params;
    await rbacService.removeRole(oid, roleId);
    res.status(204).send();
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Available Models ──────────────────────────────────────────────────────────

router.get('/available-models', async (_req: Request, res: Response): Promise<void> => {
  try {
    const models = await fetchAvailableModels();
    res.json({ models });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Project Skill Settings ────────────────────────────────────────────────────

router.get('/project-settings', async (_req: Request, res: Response): Promise<void> => {
  try {
    const configs = await projectSettingsService.listSkillConfigs();
    res.json(configs);
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/project-settings/:project', async (req: Request, res: Response): Promise<void> => {
  try {
    const { project } = req.params;
    const { skillRepo, skillBranch, interviewSkillPath, prdSkillPath, designDocSkillPath, designDocQaSkillPath, designDocAssistantSkillPath, designDocValidationSkillPath, interviewModel, prdModel, designDocModel, designDocQaModel, designDocAssistantModel, designDocValidationModel } = req.body as UpsertProjectSkillConfigRequest;
    if (!skillRepo || !skillBranch) {
      res.status(400).json({ error: 'skillRepo and skillBranch are required' });
      return;
    }
    const updatedBy = (req.user as any)?.profile?.displayName ?? (req.user as any)?.profile?.upn ?? undefined;
    const config = await projectSettingsService.upsertSkillConfig(
      project,
      skillRepo,
      skillBranch,
      updatedBy,
      interviewSkillPath,
      prdSkillPath,
      designDocSkillPath,
      interviewModel,
      prdModel,
      designDocModel,
      designDocQaSkillPath,
      designDocQaModel,
      designDocAssistantSkillPath,
      designDocAssistantModel,
      designDocValidationSkillPath,
      designDocValidationModel,
    );
    res.json(config);
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/project-settings/:project', async (req: Request, res: Response): Promise<void> => {
  try {
    const { project } = req.params;
    await projectSettingsService.deleteSkillConfig(project);
    res.status(204).send();
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── App Settings ──────────────────────────────────────────────────────────────

router.get('/app-settings/defaultModel', async (_req: Request, res: Response): Promise<void> => {
  try {
    const value = await getDefaultModel();
    res.json({ value });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/app-settings/defaultModel', async (req: Request, res: Response): Promise<void> => {
  try {
    const { value } = req.body as { value: string };
    if (!value || typeof value !== 'string') {
      res.status(400).json({ error: 'value is required' });
      return;
    }
    const updatedBy = (req.user as any)?.profile?.displayName ?? (req.user as any)?.profile?.upn ?? undefined;
    await setAppSetting('defaultModel', value, updatedBy);
    res.json({ value });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
