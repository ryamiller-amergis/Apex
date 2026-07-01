import { Router, type Request, type Response } from 'express';
import { requireSuperAdmin } from '../middleware/rbac';
import {
  bulkSetProjectAssignments,
  getAllAssignments,
  getAssignmentsForProject,
  groupAssignmentsByProject,
  listKnownApplicationUsers,
} from '../services/userProjectAssignmentService';
import * as menuSettingsService from '../services/menuSettingsService';
import * as featureFlagService from '../services/featureFlagService';
import * as groupService from '../services/groupService';
import { getUserId, getUserEmail } from '../utils/requestUser';
import { listProjectCatalog } from '../services/projectCatalogService';
import {
  approveProjectAccessRequest,
  listPlatformAdminAccessRequests,
  rejectProjectAccessRequest,
} from '../services/projectAccessRequestService';
import {
  addPendingAssignments,
  listPendingForProject,
  removePendingAssignment,
} from '../services/pendingAssignmentService';
import { CONFIGURABLE_MENU_ITEMS, type MenuItemKey, type UpsertProjectMenuConfigRequest } from '../../shared/types/menuSettings';
import type { ProjectAccessRequestStatus, SetProjectAssignmentsRequest } from '../../shared/types/platformAdmin';

const router = Router();
const validMenuItemKeys = new Set<MenuItemKey>(CONFIGURABLE_MENU_ITEMS.map((item) => item.key));

router.use(requireSuperAdmin);

router.get('/projects', async (_req: Request, res: Response): Promise<void> => {
  try {
    const projects = await listProjectCatalog();
    res.json({ projects });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

function isStringArrayOfNonEmptyItems(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim().length > 0);
}

function isMenuItemKeyArray(value: unknown): value is MenuItemKey[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && validMenuItemKeys.has(item as MenuItemKey));
}

function getActingUserId(req: Request): string | null {
  return (req.user as any)?.profile?.oid ?? null;
}

function getActingUserLabel(req: Request): string {
  const profile = (req.user as any)?.profile;
  return profile?.displayName ?? profile?.upn ?? profile?.email ?? profile?._json?.preferred_username ?? 'unknown';
}

function getStatusFilter(value: unknown): ProjectAccessRequestStatus | 'all' | null {
  if (value === undefined) return 'pending';
  if (value === 'all' || value === 'pending' || value === 'approved' || value === 'rejected') return value;
  return null;
}

router.get('/assignments', async (_req: Request, res: Response): Promise<void> => {
  try {
    const assignments = await getAllAssignments();
    res.json({ assignments: groupAssignmentsByProject(assignments) });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/users', async (_req: Request, res: Response): Promise<void> => {
  try {
    const users = await listKnownApplicationUsers();
    res.json({ users });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/groups', async (_req: Request, res: Response): Promise<void> => {
  try {
    const groups = await groupService.listGroups();
    res.json({
      groups: groups.map((group) => ({
        id: group.id,
        name: group.name,
        project: group.project,
      })),
    });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/access-requests', async (req: Request, res: Response): Promise<void> => {
  try {
    const status = getStatusFilter(req.query.status);
    if (!status) {
      res.status(400).json({ error: 'status must be pending, approved, rejected, or all' });
      return;
    }

    const requests = await listPlatformAdminAccessRequests(status);
    res.json({ requests });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/access-requests/:id/approve', async (req: Request, res: Response): Promise<void> => {
  try {
    const request = await approveProjectAccessRequest(req.params.id, getActingUserId(req), req.body?.reviewNote ?? null);
    if (!request) {
      res.status(404).json({ error: 'No pending access request found' });
      return;
    }

    res.json(request);
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/access-requests/:id/reject', async (req: Request, res: Response): Promise<void> => {
  try {
    const request = await rejectProjectAccessRequest(req.params.id, getActingUserId(req), req.body?.reviewNote ?? null);
    if (!request) {
      res.status(404).json({ error: 'No pending access request found' });
      return;
    }

    res.json(request);
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/assignments/:project', async (req: Request, res: Response): Promise<void> => {
  try {
    const { project } = req.params;
    const assignments = await getAssignmentsForProject(project);
    const [group] = groupAssignmentsByProject(assignments);
    res.json(group ?? { project, users: [] });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/assignments/:project', async (req: Request, res: Response): Promise<void> => {
  try {
    const { project } = req.params;
    const { userIds, pendingEmails } = req.body as SetProjectAssignmentsRequest & { pendingEmails?: string[] };

    if (!isStringArrayOfNonEmptyItems(userIds)) {
      res.status(400).json({ error: 'userIds must be an array of non-empty strings' });
      return;
    }

    const assignedBy = getActingUserId(req);
    await bulkSetProjectAssignments(project, userIds, assignedBy);

    if (pendingEmails && isStringArrayOfNonEmptyItems(pendingEmails)) {
      await addPendingAssignments(
        pendingEmails.map((email) => ({ email, project })),
        assignedBy,
      );
    }

    res.status(204).send();
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/pending-assignments', async (req: Request, res: Response): Promise<void> => {
  try {
    const { entries } = req.body as { entries: { email: string; project: string }[] };

    if (!Array.isArray(entries) || entries.some((e) => !e.email?.trim() || !e.project?.trim())) {
      res.status(400).json({ error: 'entries must be an array of { email, project } objects' });
      return;
    }

    await addPendingAssignments(entries, getActingUserId(req));
    res.status(204).send();
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/pending-assignments/:project', async (req: Request, res: Response): Promise<void> => {
  try {
    const pending = await listPendingForProject(req.params.project);
    res.json({ pending });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/pending-assignments/:project/:email', async (req: Request, res: Response): Promise<void> => {
  try {
    const { project, email } = req.params;
    await removePendingAssignment(decodeURIComponent(email), project);
    res.status(204).send();
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/menu-settings', async (_req: Request, res: Response): Promise<void> => {
  try {
    const configs = await menuSettingsService.listMenuConfigs();
    res.json({ configs });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/menu-settings/:project', async (req: Request, res: Response): Promise<void> => {
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

router.put('/menu-settings/:project', async (req: Request, res: Response): Promise<void> => {
  try {
    const { project } = req.params;
    const { enabledViews } = req.body as UpsertProjectMenuConfigRequest;

    if (!isMenuItemKeyArray(enabledViews)) {
      res.status(400).json({ error: 'enabledViews must be an array of valid menu item keys' });
      return;
    }

    const config = await menuSettingsService.upsertMenuConfig(project, enabledViews, getActingUserLabel(req));
    res.json(config);
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Feature Flags ─────────────────────────────────────────────────────────────

router.get('/feature-flags', async (_req: Request, res: Response): Promise<void> => {
  try {
    const flags = await featureFlagService.listFlags();
    res.json(flags);
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/feature-flags', async (req: Request, res: Response): Promise<void> => {
  try {
    const actor = { id: getUserId(req), email: getUserEmail(req) ?? '' };
    const flag = await featureFlagService.createFlag(req.body, actor);
    res.status(201).json(flag);
  } catch (err: any) {
    if (err?.message?.includes('Invalid flag key') || err?.message?.includes('already exists')) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/feature-flags/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const actor = { id: getUserId(req), email: getUserEmail(req) ?? '' };
    const flag = await featureFlagService.updateFlag(req.params.id, req.body, actor);
    res.json(flag);
  } catch (err: any) {
    if (err?.message?.includes('not found')) {
      res.status(404).json({ error: 'Flag not found' });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/feature-flags/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const actor = { id: getUserId(req), email: getUserEmail(req) ?? '' };
    await featureFlagService.deleteFlag(req.params.id, actor);
    res.status(204).send();
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/feature-flags/:id/rules', async (req: Request, res: Response): Promise<void> => {
  try {
    const actor = { id: getUserId(req), email: getUserEmail(req) ?? '' };
    const rule = await featureFlagService.addRule(req.params.id, req.body, actor);
    res.status(201).json(rule);
  } catch (err: any) {
    if (err?.message?.includes('not found')) {
      res.status(404).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/feature-flags/:id/rules/:ruleId', async (req: Request, res: Response): Promise<void> => {
  try {
    const actor = { id: getUserId(req), email: getUserEmail(req) ?? '' };
    await featureFlagService.removeRule(req.params.ruleId, actor);
    res.status(204).send();
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/feature-flags/:id/audit', async (req: Request, res: Response): Promise<void> => {
  try {
    const entries = await featureFlagService.getFlagAudit(req.params.id);
    res.json(entries);
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
