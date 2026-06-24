import { Router, type Request, type Response } from 'express';
import { requirePermission } from '../middleware/rbac';
import * as rbacService from '../services/rbacService';
import * as projectSettingsService from '../services/projectSettingsService';
import * as groupService from '../services/groupService';
import { getDefaultModel, getAppSetting, setAppSetting } from '../services/appSettingsService';
import { fetchAvailableModels } from '../services/modelsService';
import { listAvailableBedrockModels } from '../services/bedrockService';
import type {
  CreateRoleRequest,
  UpdateRoleRequest,
  UpdateRolePermissionsRequest,
  AssignRoleRequest,
} from '../../shared/types/rbac';
import type { UpsertProjectSkillConfigRequest, SetApproversRequest } from '../../shared/types/projectSettings';
import type { CreateGroupRequest, UpdateGroupRequest, SetGroupMembersRequest } from '../../shared/types/groups';
import type { NotificationType } from '../../shared/types/notification';

const ALL_NOTIFICATION_TYPES: NotificationType[] = ['system', 'ai', 'user-action', 'background'];

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

router.get('/available-bedrock-models', async (_req: Request, res: Response): Promise<void> => {
  try {
    const models = await listAvailableBedrockModels();
    res.json({ models });
  } catch {
    res.status(500).json({ error: 'Failed to fetch Bedrock models' });
  }
});

// ── Groups ──────────────────────────────────────────────────────────────────

router.get('/groups', async (req: Request, res: Response): Promise<void> => {
  try {
    const withMembers = req.query.withMembers === 'true';
    const project = req.query.project as string | undefined;
    const groups = withMembers
      ? await groupService.listGroupsWithMembers(project)
      : await groupService.listGroups(project);
    res.json(groups);
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/groups', async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, description, project } = req.body as CreateGroupRequest;
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const createdBy = (req.user as any)?.profile?.oid ?? undefined;
    const group = await groupService.createGroup(name, description, createdBy, project);
    res.status(201).json(group);
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/groups/seed/:project', async (req: Request, res: Response): Promise<void> => {
  try {
    const { project } = req.params;
    const createdBy = (req.user as any)?.profile?.oid ?? undefined;
    await groupService.seedDefaultGroupsForProject(project, createdBy);
    const groups = await groupService.listGroupsWithMembers(project);
    res.json(groups);
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
    const [configs, approversByProject, approverGroupsByProject] = await Promise.all([
      projectSettingsService.listSkillConfigs(),
      projectSettingsService.listApproversForAllProjects(),
      projectSettingsService.listApproverGroupsForAllProjects(),
    ]);
    const enriched = configs.map((cfg) => {
      const approvers = approversByProject[cfg.project] ?? [];
      const approverGroups = approverGroupsByProject[cfg.project] ?? [];
      const countByType = (documentType: string) =>
        approvers.filter((a) => a.documentType === documentType).length +
        approverGroups.filter((g) => g.documentType === documentType).length;
      return {
        ...cfg,
        designDocApproverCount: countByType('design_doc'),
        prdApproverCount: countByType('prd'),
        designPrototypeApproverCount: countByType('design_prototype'),
        testCaseApproverCount: countByType('test_case'),
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
    const { skillRepo, skillBranch, interviewSkillPath, prdSkillPath, designDocSkillPath, designDocAssistantSkillPath, designPrototypeSkillPath, testCaseSkillPath, designDocValidationSkillPath, prdValidationSkillPath, interviewModel, prdModel, designDocModel, designDocAssistantModel, designPrototypeModel, testCaseModel, designDocValidationModel, prdValidationModel, quickSkillPills, defaultModel, approvalMode, quickMcpPills, prdAssistantSkillPath, prdAssistantModel, prdReviewBedrockModelId, prdReviewBedrockMaxTokens, designPrototypeBedrockModelId, designPrototypeBedrockMaxTokens, designPrototypeBedrockTimeoutMs, designPrototypeRegenBedrockModelId, designPrototypeRegenBedrockMaxTokens, designPlanBedrockModelId, designPlanBedrockMaxTokens, developmentSkillPath, developmentModel, prdValidationScoreThreshold } = req.body as UpsertProjectSkillConfigRequest;
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
      designDocAssistantSkillPath,
      designDocAssistantModel,
      designPrototypeSkillPath,
      designPrototypeModel,
      designDocValidationSkillPath,
      designDocValidationModel,
      quickSkillPills,
      defaultModel,
      approvalMode,
      quickMcpPills,
      prdAssistantSkillPath,
      prdAssistantModel,
      prdReviewBedrockModelId,
      prdReviewBedrockMaxTokens,
      designPrototypeBedrockModelId,
      designPrototypeBedrockMaxTokens,
      designPrototypeBedrockTimeoutMs,
      designPrototypeRegenBedrockModelId,
      designPrototypeRegenBedrockMaxTokens,
      testCaseSkillPath,
      testCaseModel,
      prdValidationSkillPath,
      prdValidationModel,
      designPlanBedrockModelId,
      designPlanBedrockMaxTokens,
      developmentSkillPath,
      developmentModel,
      prdValidationScoreThreshold,
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
    const { designDocApprovers, prdApprovers, designDocApproverGroups, prdApproverGroups, designPrototypeApprovers, designPrototypeApproverGroups, testCaseApprovers, testCaseApproverGroups } = req.body as SetApproversRequest;
    if (!Array.isArray(designDocApprovers) || !Array.isArray(prdApprovers) || !Array.isArray(designPrototypeApprovers)) {
      res.status(400).json({ error: 'designDocApprovers, prdApprovers, and designPrototypeApprovers must be arrays' });
      return;
    }
    const assignedBy = (req.user as any)?.profile?.oid ?? undefined;
    const [designDoc, prd, designPrototype, testCase] = await Promise.all([
      projectSettingsService.setApprovers(project, 'design_doc', designDocApprovers, assignedBy),
      projectSettingsService.setApprovers(project, 'prd', prdApprovers, assignedBy),
      projectSettingsService.setApprovers(project, 'design_prototype', designPrototypeApprovers, assignedBy),
      projectSettingsService.setApprovers(project, 'test_case', testCaseApprovers ?? [], assignedBy),
    ]);

    await Promise.all([
      projectSettingsService.setApproverGroups(project, 'design_doc', designDocApproverGroups ?? [], assignedBy),
      projectSettingsService.setApproverGroups(project, 'prd', prdApproverGroups ?? [], assignedBy),
      projectSettingsService.setApproverGroups(project, 'design_prototype', designPrototypeApproverGroups ?? [], assignedBy),
      projectSettingsService.setApproverGroups(project, 'test_case', testCaseApproverGroups ?? [], assignedBy),
    ]);

    res.json({ designDoc, prd, designPrototype, testCase });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Available Approver Pool (grouped) ─────────────────────────────────────
router.get('/project-settings/:project/approver-pool/:documentType', async (req: Request, res: Response): Promise<void> => {
  try {
    const { project, documentType } = req.params;
    if (documentType !== 'prd' && documentType !== 'design_doc' && documentType !== 'design_prototype' && documentType !== 'test_case') {
      res.status(400).json({ error: 'documentType must be prd, design_doc, design_prototype, or test_case' });
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

// ── Teams Notification Settings ───────────────────────────────────────────────

router.get('/app-settings/teamsNotifications', async (_req: Request, res: Response): Promise<void> => {
  try {
    const raw = await getAppSetting('teams_notification_enabled_types');
    if (raw === null) {
      res.json({ enabledTypes: ALL_NOTIFICATION_TYPES });
      return;
    }
    let enabledTypes: NotificationType[];
    try {
      enabledTypes = JSON.parse(raw) as NotificationType[];
    } catch {
      enabledTypes = ALL_NOTIFICATION_TYPES;
    }
    res.json({ enabledTypes });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/app-settings/teamsNotifications', async (req: Request, res: Response): Promise<void> => {
  try {
    const { enabledTypes } = req.body as { enabledTypes: NotificationType[] };
    if (!Array.isArray(enabledTypes)) {
      res.status(400).json({ error: 'enabledTypes must be an array' });
      return;
    }
    const invalid = enabledTypes.filter((t) => !ALL_NOTIFICATION_TYPES.includes(t));
    if (invalid.length > 0) {
      res.status(400).json({ error: `Invalid notification types: ${invalid.join(', ')}` });
      return;
    }
    const updatedBy = (req.user as any)?.profile?.displayName ?? (req.user as any)?.profile?.upn ?? undefined;
    await setAppSetting('teams_notification_enabled_types', JSON.stringify(enabledTypes), updatedBy);
    res.json({ enabledTypes });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
