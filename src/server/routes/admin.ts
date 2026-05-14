import { Router, type Request, type Response } from 'express';
import { requirePermission } from '../middleware/rbac';
import * as rbacService from '../services/rbacService';
import type {
  CreateRoleRequest,
  UpdateRoleRequest,
  UpdateRolePermissionsRequest,
  AssignRoleRequest,
} from '../../shared/types/rbac';

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

export default router;
