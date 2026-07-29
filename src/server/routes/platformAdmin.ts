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
import * as walkthroughService from '../services/walkthroughService';
import {
  generateProposal,
  listWalkthroughAiPolicyPresets,
  redoProposalUnit,
  validateProposalUnit,
} from '../services/walkthroughAiDraftService';
import { listWalkthroughAnchors } from '../../shared/walkthroughAnchors';
import {
  WalkthroughDomainError,
  type PublishWalkthroughCommand,
  type UpdateWalkthroughCommand,
} from '../../shared/types/walkthrough';
import { WalkthroughAiError } from '../../shared/types/walkthroughAiDraft';

const router = Router();
const validMenuItemKeys = new Set<MenuItemKey>(CONFIGURABLE_MENU_ITEMS.map((item) => item.key));

function mapWalkthroughError(err: unknown, res: Response): boolean {
  if (!(err instanceof WalkthroughDomainError)) return false;
  switch (err.code) {
    case 'WALKTHROUGH_NOT_FOUND':
      res.status(404).json({ error: err.message, code: err.code });
      return true;
    case 'REVISION_CONFLICT':
      res.status(409).json({ error: err.message, code: err.code });
      return true;
    case 'INVALID_TRANSITION':
    case 'INVALID_TARGET':
    case 'INVALID_PROGRESS':
    case 'VALIDATION_ERROR':
    case 'INACCESSIBLE':
      res.status(400).json({ error: err.message, code: err.code });
      return true;
    default:
      res.status(400).json({ error: err.message, code: err.code });
      return true;
  }
}

function mapWalkthroughAiError(err: unknown, res: Response): boolean {
  if (!(err instanceof WalkthroughAiError)) return false;
  switch (err.code) {
    case 'INTENT_INVALID':
    case 'FEEDBACK_INVALID':
    case 'PROPOSAL_UNIT_INVALID':
    case 'AI_OUTPUT_INVALID':
    case 'REGISTRY_VALUE_STALE':
      res.status(400).json({ error: err.message, code: err.code });
      return true;
    case 'AI_GENERATION_FAILED':
    case 'AI_REDO_FAILED':
      res.status(502).json({ error: err.message, code: err.code });
      return true;
    default:
      res.status(400).json({ error: err.message, code: err.code });
      return true;
  }
}

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Passport user profile shape is not typed on Request
  return (req.user as any)?.profile?.oid ?? null;
}

function getActingUserLabel(req: Request): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Passport user profile shape is not typed on Request
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- featureFlagService throws plain Error with message checks
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- featureFlagService throws plain Error with message checks
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- featureFlagService throws plain Error with message checks
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

// ── Walkthroughs (FEAT-001) ───────────────────────────────────────────────────

router.get('/walkthroughs', async (req: Request, res: Response): Promise<void> => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    const project = typeof req.query.project === 'string' ? req.query.project : undefined;
    const lifecycle = typeof req.query.lifecycle === 'string'
      ? req.query.lifecycle
      : undefined;
    const page = await walkthroughService.listCatalog({
      cursor,
      limit,
      project,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- query string lifecycle may be single value or CSV; validated in service
      lifecycle: lifecycle as any,
    });
    res.json(page);
  } catch (err) {
    if (mapWalkthroughError(err, res)) return;
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/walkthroughs', async (req: Request, res: Response): Promise<void> => {
  try {
    const actor = { id: getUserId(req) };
    const created = await walkthroughService.createWalkthrough(req.body, actor);
    res.status(201).json(created);
  } catch (err) {
    if (mapWalkthroughError(err, res)) return;
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/walkthroughs/anchors', async (_req: Request, res: Response): Promise<void> => {
  res.json({ anchors: listWalkthroughAnchors() });
});

router.get('/walkthroughs/ai-drafts/policy-presets', async (_req: Request, res: Response): Promise<void> => {
  res.json({
    defaultPreset: 'A',
    presets: listWalkthroughAiPolicyPresets(),
  });
});

router.get('/walkthroughs/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const walkthrough = await walkthroughService.getWalkthroughAdmin(req.params.id);
    res.json(walkthrough);
  } catch (err) {
    if (mapWalkthroughError(err, res)) return;
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/walkthroughs/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const actor = { id: getUserId(req) };
    const updated = await walkthroughService.updateWalkthrough(
      req.params.id,
      req.body as UpdateWalkthroughCommand,
      actor,
    );
    res.json(updated);
  } catch (err) {
    if (mapWalkthroughError(err, res)) return;
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/walkthroughs/:id/publish', async (req: Request, res: Response): Promise<void> => {
  try {
    const actor = { id: getUserId(req) };
    const command = req.body as PublishWalkthroughCommand;
    const published = await walkthroughService.publishWalkthrough(
      req.params.id,
      command,
      actor,
    );

    let notificationFanout = {
      queued: 0,
      targeted: 0,
      created: 0,
      skippedDuplicate: 0,
      failed: 0,
    };

    // FEAT-007: fan-out after lifecycle commit; failures must not roll back publication.
    if (command.mode === 'fresh' || command.mode === 'reshow') {
      try {
        const { notifyPublishedAudience } = await import('../services/walkthroughNotificationService');
        const fanout = await notifyPublishedAudience({
          walkthroughId: published.id,
          revision: published.revision,
          mode: command.mode,
        });
        notificationFanout = {
          queued: fanout.targeted,
          targeted: fanout.targeted,
          created: fanout.created,
          skippedDuplicate: fanout.skippedDuplicate,
          failed: fanout.failed,
        };
      } catch {
        notificationFanout = {
          queued: 0,
          targeted: 0,
          created: 0,
          skippedDuplicate: 0,
          failed: 1,
        };
      }
    }

    res.json({ walkthrough: published, notificationFanout });
  } catch (err) {
    if (mapWalkthroughError(err, res)) return;
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/walkthroughs/:id/unpublish', async (req: Request, res: Response): Promise<void> => {
  try {
    const actor = { id: getUserId(req) };
    const result = await walkthroughService.unpublishWalkthrough(req.params.id, actor, {
      expectedUpdatedAt:
        typeof req.body?.expectedUpdatedAt === 'string' ? req.body.expectedUpdatedAt : undefined,
    });
    res.json(result);
  } catch (err) {
    if (mapWalkthroughError(err, res)) return;
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/walkthroughs/:id/archive', async (req: Request, res: Response): Promise<void> => {
  try {
    const actor = { id: getUserId(req) };
    const result = await walkthroughService.archiveWalkthrough(req.params.id, actor, {
      expectedUpdatedAt:
        typeof req.body?.expectedUpdatedAt === 'string' ? req.body.expectedUpdatedAt : undefined,
    });
    res.json(result);
  } catch (err) {
    if (mapWalkthroughError(err, res)) return;
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/walkthroughs/ai-drafts/validate', async (req: Request, res: Response): Promise<void> => {
  try {
    const validated = walkthroughService.validateAiDraft(req.body);
    res.json(validated);
  } catch (err) {
    if (mapWalkthroughError(err, res)) return;
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/walkthroughs/ai-drafts/generate', async (req: Request, res: Response): Promise<void> => {
  try {
    // Never trust client-supplied allow-lists — strip if present.
    const { anchors: _a, assets: _assets, assetAllowList: _al, ...body } = req.body ?? {};
    const proposal = await generateProposal({
      projectId: body.projectId,
      intent: body.intent,
      policyPreset: body.policyPreset,
      existingDraft: body.existingDraft,
    });
    res.json({ proposal });
  } catch (err) {
    if (mapWalkthroughAiError(err, res)) return;
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/walkthroughs/ai-drafts/redo', async (req: Request, res: Response): Promise<void> => {
  try {
    const { anchors: _a, assets: _assets, assetAllowList: _al, ...body } = req.body ?? {};
    const unit = await redoProposalUnit({
      projectId: body.projectId,
      proposalId: body.proposalId,
      generationContextVersion: body.generationContextVersion,
      unit: body.unit,
      feedback: body.feedback,
      policyPreset: body.policyPreset,
    });
    res.json({ unit });
  } catch (err) {
    if (mapWalkthroughAiError(err, res)) return;
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/walkthroughs/ai-drafts/validate-unit', async (req: Request, res: Response): Promise<void> => {
  try {
    const { anchors: _a, assets: _assets, assetAllowList: _al, ...body } = req.body ?? {};
    const result = validateProposalUnit({
      projectId: body.projectId,
      unit: body.unit,
      imageConfirmed: Boolean(body.imageConfirmed),
    });
    res.json(result);
  } catch (err) {
    if (mapWalkthroughAiError(err, res)) return;
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/walkthroughs/:id/reports/acknowledgement', async (req: Request, res: Response): Promise<void> => {
  try {
    const report = await walkthroughService.getAcknowledgementReport(req.params.id);
    res.json(report);
  } catch (err) {
    if (mapWalkthroughError(err, res)) return;
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
