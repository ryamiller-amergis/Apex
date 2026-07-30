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
import { getUserId, getUserEmail, getDisplayName } from '../utils/requestUser';
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
  listWalkthroughAiPolicyPresets,
  redoProposalUnit,
  validateProposalUnit,
} from '../services/walkthroughAiDraftService';
import {
  WalkthroughDomainError,
  type PublishWalkthroughCommand,
  type UpdateWalkthroughCommand,
} from '../../shared/types/walkthrough';
import { WalkthroughAiError } from '../../shared/types/walkthroughAiDraft';
import {
  WalkthroughAnchorRegistryError,
  type BulkWalkthroughAnchorCommand,
  type CreateManualWalkthroughAnchorCommand,
  type UpdateWalkthroughAnchorCommand,
  type UpdateWalkthroughAnchorMissingStateCommand,
  type WalkthroughAnchorSyncCommand,
} from '../../shared/types/walkthroughAnchorRegistry';

import {
  startGeneration as startWalkthroughGeneration,
  getGenerationResult as getWalkthroughGenerationResult,
  cancelGeneration as cancelWalkthroughGeneration,
} from '../services/walkthroughGenerationService';
import {
  startSmartTagging,
  getSmartTaggingResult,
  cancelSmartTagging,
  WalkthroughAnchorSmartTaggingOrchestrationError,
} from '../services/walkthroughAnchorSmartTaggingService';
import * as walkthroughAnchorRegistryService from '../services/walkthroughAnchorRegistryService';
import * as walkthroughAiOptionsService from '../services/walkthroughAiOptionsService';
import { WalkthroughAiOptionsError } from '../../shared/types/walkthroughAiOptions';

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

function mapWalkthroughAnchorRegistryError(err: unknown, res: Response): boolean {
  if (!(err instanceof WalkthroughAnchorRegistryError)) return false;
  switch (err.code) {
    case 'NOT_FOUND':
      res.status(404).json({ error: err.message, code: err.code, details: err.details });
      return true;
    case 'DUPLICATE':
      res.status(409).json({ error: err.message, code: err.code, details: err.details });
      return true;
    case 'ACTIVE_REQUIRES_APPROVED':
    case 'VALIDATION_ERROR':
      res.status(400).json({ error: err.message, code: err.code, details: err.details });
      return true;
    default:
      res.status(400).json({ error: err.message, code: err.code, details: err.details });
      return true;
  }
}

function mapSmartTaggingOrchestrationError(err: unknown, res: Response): boolean {
  if (!(err instanceof WalkthroughAnchorSmartTaggingOrchestrationError)) return false;
  switch (err.code) {
    case 'NOT_FOUND':
      res.status(404).json({ error: err.message, code: err.code });
      return true;
    case 'INVALID_REQUEST':
      res.status(400).json({ error: err.message, code: err.code });
      return true;
    case 'AI_FAILED':
      res.status(502).json({ error: err.message, code: err.code });
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
  try {
    const anchors = await walkthroughAnchorRegistryService.listAuthoringAnchorEntries();
    res.json({ anchors });
  } catch (err) {
    console.error('[platform-admin] list authoring anchors failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Smart Anchor Management catalog (Phase 2) ─────────────────────────────────
// Static paths must stay above /walkthroughs/:id.

router.get('/walkthroughs/ai-options', async (_req: Request, res: Response): Promise<void> => {
  try {
    const options = await walkthroughAiOptionsService.getWalkthroughAiOptions();
    res.json(options);
  } catch (err) {
    console.error('[platform-admin] get walkthrough AI options failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/walkthroughs/ai-options', async (req: Request, res: Response): Promise<void> => {
  try {
    const saved = await walkthroughAiOptionsService.saveWalkthroughAiOptions(req.body, {
      id: getUserId(req),
      displayName: getDisplayName(req),
    });
    res.json(saved);
  } catch (err) {
    if (err instanceof WalkthroughAiOptionsError) {
      res.status(err.code === 'NOT_FOUND' ? 404 : 400).json({
        error: err.message,
        code: err.code,
      });
      return;
    }
    console.error('[platform-admin] save walkthrough AI options failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/walkthroughs/anchor-registry', async (req: Request, res: Response): Promise<void> => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const approvedRoute =
      typeof req.query.approvedRoute === 'string' ? req.query.approvedRoute : undefined;
    const reviewStatus = walkthroughAnchorRegistryService.parseReviewStatusFilter(
      req.query.reviewStatus,
    );
    const sourceKind = walkthroughAnchorRegistryService.parseSourceKindFilter(req.query.sourceKind);
    const isActive =
      req.query.isActive === 'true' ? true : req.query.isActive === 'false' ? false : undefined;
    const missingOnly =
      req.query.missingOnly === 'true'
        ? true
        : req.query.missingOnly === 'false'
          ? false
          : undefined;
    const includeDeleted = req.query.includeDeleted === 'true';
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    const smartTagsRaw = typeof req.query.smartTags === 'string' ? req.query.smartTags : undefined;
    const smartTags = smartTagsRaw
      ? smartTagsRaw.split(',').map((t) => t.trim()).filter(Boolean)
      : undefined;

    if (req.query.reviewStatus != null && req.query.reviewStatus !== '' && reviewStatus == null) {
      res.status(400).json({ error: 'Invalid reviewStatus filter', code: 'VALIDATION_ERROR' });
      return;
    }
    if (req.query.sourceKind != null && req.query.sourceKind !== '' && sourceKind == null) {
      res.status(400).json({ error: 'Invalid sourceKind filter', code: 'VALIDATION_ERROR' });
      return;
    }

    const page = await walkthroughAnchorRegistryService.listAnchors({
      search,
      approvedRoute,
      reviewStatus,
      sourceKind,
      isActive,
      missingOnly,
      includeDeleted,
      smartTags,
      limit: Number.isFinite(limit) ? limit : undefined,
      cursor,
    });
    res.json(page);
  } catch (err) {
    if (mapWalkthroughAnchorRegistryError(err, res)) return;
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get(
  '/walkthroughs/anchor-registry/module-coverage',
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const coverage = await walkthroughAnchorRegistryService.getModuleCoverage();
      res.json(coverage);
    } catch (err) {
      if (mapWalkthroughAnchorRegistryError(err, res)) return;
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.get(
  '/walkthroughs/anchor-registry/by-key/:anchorKey',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const record = await walkthroughAnchorRegistryService.getAnchorByKey(req.params.anchorKey);
      if (!record) {
        res.status(404).json({ error: 'Anchor not found', code: 'NOT_FOUND' });
        return;
      }
      res.json(record);
    } catch (err) {
      if (mapWalkthroughAnchorRegistryError(err, res)) return;
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.get(
  '/walkthroughs/anchor-registry/by-test-id/:testId',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const record = await walkthroughAnchorRegistryService.getAnchorByTestId(req.params.testId);
      if (!record) {
        res.status(404).json({ error: 'Anchor not found', code: 'NOT_FOUND' });
        return;
      }
      res.json(record);
    } catch (err) {
      if (mapWalkthroughAnchorRegistryError(err, res)) return;
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.post('/walkthroughs/anchor-registry/bulk', async (req: Request, res: Response): Promise<void> => {
  try {
    const actor = { id: getUserId(req) };
    const body = req.body as BulkWalkthroughAnchorCommand;
    const items = await walkthroughAnchorRegistryService.bulkUpdateAnchors(body, actor);
    res.json({ items });
  } catch (err) {
    if (mapWalkthroughAnchorRegistryError(err, res)) return;
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post(
  '/walkthroughs/anchor-registry/missing',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const actor = { id: getUserId(req) };
      const body = req.body as UpdateWalkthroughAnchorMissingStateCommand;
      const items = await walkthroughAnchorRegistryService.updateMissingState(body, actor);
      res.json({ items });
    } catch (err) {
      if (mapWalkthroughAnchorRegistryError(err, res)) return;
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

/**
 * Wave 2 Track A — Super Admin scanner sync (extract + persist).
 * Returns full sync result for the Sync review modal (Track C).
 * AI smart-tagging (Track B) consumes persistence.newCandidateIdsForSmartTagging only.
 *
 * Provider omitted → production uses Apex skill repo (repo cache); local uses cwd.
 */
router.post(
  '/walkthroughs/anchor-registry/sync',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const actor = { id: getUserId(req) };
      const body = (req.body ?? {}) as WalkthroughAnchorSyncCommand;
      if (
        body.provider != null &&
        body.provider !== 'local' &&
        body.provider !== 'github' &&
        body.provider !== 'ado'
      ) {
        res.status(400).json({ error: 'Invalid sync provider', code: 'VALIDATION_ERROR' });
        return;
      }
      const result = await walkthroughAnchorRegistryService.syncExtractAndPersistAnchors(
        {
          provider: body.provider,
          repositoryRoot: body.repositoryRoot,
          clientRelativeRoot: body.clientRelativeRoot,
          files: body.files,
        },
        actor,
      );
      res.json(result);
    } catch (err) {
      if (mapWalkthroughAnchorRegistryError(err, res)) return;
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.post('/walkthroughs/anchor-registry', async (req: Request, res: Response): Promise<void> => {
  try {
    const actor = { id: getUserId(req) };
    const created = await walkthroughAnchorRegistryService.createManualAnchor(
      req.body as CreateManualWalkthroughAnchorCommand,
      actor,
    );
    res.status(201).json(created);
  } catch (err) {
    if (mapWalkthroughAnchorRegistryError(err, res)) return;
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get(
  '/walkthroughs/anchor-registry/:id',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const record = await walkthroughAnchorRegistryService.getAnchorById(req.params.id);
      if (!record) {
        res.status(404).json({ error: 'Anchor not found', code: 'NOT_FOUND' });
        return;
      }
      res.json(record);
    } catch (err) {
      if (mapWalkthroughAnchorRegistryError(err, res)) return;
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.patch(
  '/walkthroughs/anchor-registry/:id',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const actor = { id: getUserId(req) };
      const updated = await walkthroughAnchorRegistryService.updateAnchor(
        req.params.id,
        req.body as UpdateWalkthroughAnchorCommand,
        actor,
      );
      res.json(updated);
    } catch (err) {
      if (mapWalkthroughAnchorRegistryError(err, res)) return;
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.delete(
  '/walkthroughs/anchor-registry/:id',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const actor = { id: getUserId(req) };
      const deleted = await walkthroughAnchorRegistryService.softDeleteAnchor(req.params.id, actor);
      res.json(deleted);
    } catch (err) {
      if (mapWalkthroughAnchorRegistryError(err, res)) return;
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ── Async Cursor SDK Smart Tagging (newly discovered anchors) ────────────────

router.post(
  '/walkthroughs/anchor-registry/smart-tagging/start',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = getUserId(req);
      const body = req.body ?? {};
      const result = await startSmartTagging(
        {
          candidates: body.candidates,
          model: body.cursorModel ?? body.model,
          skillPath: body.skillPath,
        },
        userId,
      );
      res.json(result);
    } catch (err) {
      if (mapSmartTaggingOrchestrationError(err, res)) return;
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.get(
  '/walkthroughs/anchor-registry/smart-tagging/status/:threadId',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = getUserId(req);
      const result = await getSmartTaggingResult(req.params.threadId, userId);
      res.json(result);
    } catch (err) {
      if (mapSmartTaggingOrchestrationError(err, res)) return;
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.post(
  '/walkthroughs/anchor-registry/smart-tagging/cancel',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = getUserId(req);
      const { threadId } = req.body ?? {};
      if (!threadId || typeof threadId !== 'string') {
        res.status(400).json({ error: 'threadId is required' });
        return;
      }
      await cancelSmartTagging(threadId, userId);
      res.json({ status: 'cancelled' });
    } catch (err) {
      if (mapSmartTaggingOrchestrationError(err, res)) return;
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

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
    const result = await validateProposalUnit({
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

// ── Async Cursor SDK Walkthrough Generation ────────────────────────────────────

router.post('/walkthroughs/ai-drafts/generate/start', async (req: Request, res: Response): Promise<void> => {
  try {
    const { anchors: _a, assets: _assets, assetAllowList: _al, ...body } = req.body ?? {};
    const userId = getUserId(req);
    const result = await startWalkthroughGeneration(
      {
        projectId: body.projectId,
        intent: body.intent,
        policyPreset: body.policyPreset,
        model: body.cursorModel ?? body.model,
        skillPath: body.skillPath,
        existingDraft: body.existingDraft,
      },
      userId,
    );
    res.json(result);
  } catch (err) {
    if (mapWalkthroughAiError(err, res)) return;
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/walkthroughs/ai-drafts/generate/status/:threadId', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = getUserId(req);
    const result = await getWalkthroughGenerationResult(req.params.threadId, userId);
    res.json(result);
  } catch (err) {
    if (mapWalkthroughAiError(err, res)) return;
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/walkthroughs/ai-drafts/generate/cancel', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = getUserId(req);
    const { threadId } = req.body ?? {};
    if (!threadId || typeof threadId !== 'string') {
      res.status(400).json({ error: 'threadId is required' });
      return;
    }
    const result = await cancelWalkthroughGeneration(threadId, userId);
    res.json(result);
  } catch (err) {
    if (mapWalkthroughAiError(err, res)) return;
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/walkthroughs/:id/reports/acknowledgement', async (req: Request, res: Response): Promise<void> => {
  try {
    const statusRaw = typeof req.query.status === 'string' ? req.query.status : 'all';
    if (statusRaw !== 'all' && statusRaw !== 'completed' && statusRaw !== 'dismissed') {
      res.status(400).json({ error: 'status must be all, completed, or dismissed' });
      return;
    }
    const report = await walkthroughService.getAcknowledgementReport(req.params.id, statusRaw);
    res.json(report);
  } catch (err) {
    if (mapWalkthroughError(err, res)) return;
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/walkthroughs/:id/reports/anchor-misses', async (req: Request, res: Response): Promise<void> => {
  try {
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    const limit =
      typeof req.query.limit === 'string' && req.query.limit.trim()
        ? Number(req.query.limit)
        : undefined;
    const page = await walkthroughService.listAnchorMisses(req.params.id, { cursor, limit });
    res.json(page);
  } catch (err) {
    if (mapWalkthroughError(err, res)) return;
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
