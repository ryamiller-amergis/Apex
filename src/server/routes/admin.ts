import { Router, type Request, type Response } from 'express';
import { requirePermission, requireSuperAdmin } from '../middleware/rbac';
import * as rbacService from '../services/rbacService';
import * as projectSettingsService from '../services/projectSettingsService';
import * as groupService from '../services/groupService';
import * as menuSettingsService from '../services/menuSettingsService';
import { getDefaultModel, setAppSetting } from '../services/appSettingsService';
import { fetchAvailableModels } from '../services/modelsService';
import type {
  CreateRoleRequest,
  UpdateRoleRequest,
  UpdateRolePermissionsRequest,
  AssignRoleRequest,
} from '../../shared/types/rbac';
import type { UpsertProjectSkillConfigRequest, SetApproversRequest } from '../../shared/types/projectSettings';
import type { CreateGroupRequest, UpdateGroupRequest, SetGroupMembersRequest } from '../../shared/types/groups';
import type { UpsertProjectMenuConfigRequest } from '../../shared/types/menuSettings';

const router = Router();

// All admin routes require authentication (ensureAuthenticated is applied globally upstream)
// and the admin:roles permission
router.use(requirePermission('admin:roles'));

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

// ── Groups ──────────────────────────────────────────────────────────────────

router.get('/groups', async (req: Request, res: Response): Promise<void> => {
  try {
    const withMembers = req.query.withMembers === 'true';
    const groups = withMembers
      ? await groupService.listGroupsWithMembers()
      : await groupService.listGroups();
    res.json(groups);
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/groups', async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, description } = req.body as CreateGroupRequest;
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const createdBy = (req.user as any)?.profile?.oid ?? undefined;
    const group = await groupService.createGroup(name, description, createdBy);
    res.status(201).json(group);
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/groups/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const group = await groupService.getGroupWithMembers(id);
    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    res.json(group);
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/groups/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const updates = req.body as UpdateGroupRequest;
    const group = await groupService.updateGroup(id, updates);
    res.json(group);
  } catch (err: any) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/groups/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    await groupService.deleteGroup(id);
    res.status(204).send();
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/groups/:id/members', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { userIds } = req.body as SetGroupMembersRequest;
    if (!Array.isArray(userIds)) {
      res.status(400).json({ error: 'userIds must be an array' });
      return;
    }
    const addedBy = (req.user as any)?.profile?.oid ?? undefined;
    const members = await groupService.setGroupMembers(id, userIds, addedBy);
    res.json(members);
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Project Skill Settings ────────────────────────────────────────────────────

router.get('/project-settings', async (_req: Request, res: Response): Promise<void> => {
  try {
    const [configs, approversByProject] = await Promise.all([
      projectSettingsService.listSkillConfigs(),
      projectSettingsService.listApproversForAllProjects(),
    ]);
    const enriched = configs.map((cfg) => {
      const approvers = approversByProject[cfg.project] ?? [];
      return {
        ...cfg,
        designDocApproverCount: approvers.filter((a) => a.documentType === 'design_doc').length,
        prdApproverCount: approvers.filter((a) => a.documentType === 'prd').length,
      };
    });
    res.json(enriched);
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/project-settings/:project', async (req: Request, res: Response): Promise<void> => {
  try {
    const { project } = req.params;
    const { skillRepo, skillBranch, interviewSkillPath, prdSkillPath, designDocSkillPath, designDocQaSkillPath, designDocAssistantSkillPath, designDocValidationSkillPath, interviewModel, prdModel, designDocModel, designDocQaModel, designDocAssistantModel, designDocValidationModel, quickSkillPills, defaultModel, approvalMode, quickMcpPills, prdAssistantSkillPath, prdAssistantModel } = req.body as UpsertProjectSkillConfigRequest;
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
      quickSkillPills,
      defaultModel,
      approvalMode,
      quickMcpPills,
      prdAssistantSkillPath,
      prdAssistantModel,
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

// ── Project Approvers ────────────────────────────────────────────────────────

router.get('/project-settings/:project/approvers', async (req: Request, res: Response): Promise<void> => {
  try {
    const { project } = req.params;
    const [approvers, approverGroups] = await Promise.all([
      projectSettingsService.listApprovers(project),
      projectSettingsService.listApproverGroupsForProject(project),
    ]);
    res.json({ approvers, approverGroups });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/project-settings/:project/approvers', async (req: Request, res: Response): Promise<void> => {
  try {
    const { project } = req.params;
    const { designDocApprovers, prdApprovers, designDocApproverGroups, prdApproverGroups } = req.body as SetApproversRequest;
    if (!Array.isArray(designDocApprovers) || !Array.isArray(prdApprovers)) {
      res.status(400).json({ error: 'designDocApprovers and prdApprovers must be arrays' });
      return;
    }
    const assignedBy = (req.user as any)?.profile?.oid ?? undefined;
    const [designDoc, prd] = await Promise.all([
      projectSettingsService.setApprovers(project, 'design_doc', designDocApprovers, assignedBy),
      projectSettingsService.setApprovers(project, 'prd', prdApprovers, assignedBy),
    ]);

    await Promise.all([
      projectSettingsService.setApproverGroups(project, 'design_doc', designDocApproverGroups ?? [], assignedBy),
      projectSettingsService.setApproverGroups(project, 'prd', prdApproverGroups ?? [], assignedBy),
    ]);

    res.json({ designDoc, prd });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Available Approver Pool (grouped) ─────────────────────────────────────
router.get('/project-settings/:project/approver-pool/:documentType', async (req: Request, res: Response): Promise<void> => {
  try {
    const { project, documentType } = req.params;
    if (documentType !== 'prd' && documentType !== 'design_doc') {
      res.status(400).json({ error: 'documentType must be prd or design_doc' });
      return;
    }
    const excludeSelf = req.query.excludeSelf === 'true';
    const userId = excludeSelf ? (req.user as any)?.profile?.oid : undefined;
    const pool = await projectSettingsService.getApproverPool(project, documentType);
    if (userId) {
      pool.individuals = pool.individuals.filter((a) => a.userId !== userId);
      pool.groups = pool.groups.map((g) => ({
        ...g,
        members: g.members.filter((m) => m.userId !== userId),
      }));
    }
    res.json(pool);
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

// ── Project Menu Settings (super-admin only) ─────────────────────────────────

router.get('/project-menu-settings', requireSuperAdmin, async (_req: Request, res: Response): Promise<void> => {
  try {
    const configs = await menuSettingsService.listMenuConfigs();
    res.json(configs);
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/project-menu-settings/:project', requireSuperAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const config = await menuSettingsService.getMenuConfig(req.params.project);
    if (!config) {
      res.status(404).json({ error: 'No menu config found for this project' });
      return;
    }
    res.json(config);
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/project-menu-settings/:project', requireSuperAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const { project } = req.params;
    const { enabledViews } = req.body as UpsertProjectMenuConfigRequest;
    if (!Array.isArray(enabledViews)) {
      res.status(400).json({ error: 'enabledViews must be an array' });
      return;
    }
    const userId = (req.user as any)?.profile?.displayName ?? (req.user as any)?.profile?.upn ?? 'unknown';
    const config = await menuSettingsService.upsertMenuConfig(project, enabledViews, userId);
    res.json(config);
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
