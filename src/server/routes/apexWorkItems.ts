import { Router } from 'express';
import {
  requirePermission,
  requireProjectAccess,
  resolveRequestProject,
} from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import {
  listApexWorkItems,
  getApexWorkItem,
  createApexWorkItem,
  updateApexWorkItem,
  moveApexWorkItem,
  bulkUpdateApexWorkItems,
  listEligibleOwners,
  listFilterFacets,
  listReleases,
  createRelease,
  updateRelease,
  deleteRelease,
  materializeFromPrdWithItems,
  previewMaterializeFromPrd,
  generateDraftsFromFeatureRequest,
  createFromDrafts,
  previewCreateFromDrafts,
  getMaterializedItemIds,
  listComments,
  addComment,
  listAttachments,
  addAttachmentMeta,
  removeAttachment,
  resolveAttachmentContent,
  getBoardEventStats,
  listAssignedToUser,
  notifyDueSoonWorkItems,
} from '../services/apexWorkItemService';
import {
  listDeployments,
  recordDeployment,
  seedDeploymentsFromJsonIfEmpty,
} from '../services/apexDeploymentService';
import { importFromAdo } from '../services/apexWorkItemImportService';
import { subscribe as subscribeBoardBus } from '../services/apexWorkBoardBus';
import { startSseHeartbeat, writeSseEvent } from '../utils/sseResponse';
import type {
  ApexWorkItemFilters,
  ApexWorkItemType,
  ApexWorkItemSourceType,
  BulkUpdateApexWorkItemsDTO,
  CreateApexReleaseDTO,
  CreateApexWorkItemDTO,
  UpdateApexReleaseDTO,
  UpdateApexWorkItemDTO,
  MoveApexWorkItemDTO,
  MaterializeFromPrdDTO,
  GenerateFromFeatureRequestDTO,
  CreateFromDraftsDTO,
  RecordApexDeploymentDTO,
} from '../../shared/types/apexWorkItem';

const router = Router();

function projectFromReq(req: Parameters<typeof resolveRequestProject>[0]): string {
  const project = resolveRequestProject(req);
  if (!project) {
    const err = new Error('project query/body/header is required') as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  return project;
}

// View routes
router.use(requirePermission('work-board:view'));
router.use(requireProjectAccess(resolveRequestProject));

// ── Filters / owners / releases ───────────────────────────────────────────────

router.get('/owners', async (req, res, next) => {
  try {
    const owners = await listEligibleOwners(projectFromReq(req));
    res.json(owners);
  } catch (err) {
    next(err);
  }
});

router.get('/facets', async (req, res, next) => {
  try {
    const facets = await listFilterFacets(projectFromReq(req));
    res.json(facets);
  } catch (err) {
    next(err);
  }
});

router.get('/releases', async (req, res, next) => {
  try {
    const releases = await listReleases(projectFromReq(req));
    res.json(releases);
  } catch (err) {
    next(err);
  }
});

router.post('/releases', requirePermission('work-board:manage'), async (req, res, next) => {
  try {
    const actorId = getUserId(req);
    const project = projectFromReq(req);
    const dto = req.body as CreateApexReleaseDTO;
    const release = await createRelease(actorId, project, dto);
    res.status(201).json(release);
  } catch (err) {
    next(err);
  }
});

router.patch('/releases/:id', requirePermission('work-board:manage'), async (req, res, next) => {
  try {
    const actorId = getUserId(req);
    const project = projectFromReq(req);
    const dto = req.body as UpdateApexReleaseDTO;
    const release = await updateRelease(req.params.id, actorId, project, dto);
    res.json(release);
  } catch (err) {
    next(err);
  }
});

router.delete('/releases/:id', requirePermission('work-board:admin'), async (req, res, next) => {
  try {
    await deleteRelease(req.params.id, projectFromReq(req));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ── Deployments ───────────────────────────────────────────────────────────────

router.get('/deployments', async (req, res, next) => {
  try {
    const project = projectFromReq(req);
    // Lazily seed Apex from legacy JSON when PG is empty (no-op otherwise).
    if (project.toLowerCase() === 'apex') {
      await seedDeploymentsFromJsonIfEmpty('Apex').catch((err) => {
        console.warn('[apex-work-items] deployment seed skipped:', (err as Error).message);
      });
    }
    const env = typeof req.query.env === 'string' ? req.query.env : undefined;
    const deployments = await listDeployments(project, env);
    res.json(deployments);
  } catch (err) {
    next(err);
  }
});

router.post('/deployments', requirePermission('work-board:manage'), async (req, res, next) => {
  try {
    const actorId = getUserId(req);
    const project = projectFromReq(req);
    const dto = req.body as RecordApexDeploymentDTO;
    if (!dto.environment) { res.status(400).json({ error: 'environment is required' }); return; }
    if (!dto.version?.trim()) { res.status(400).json({ error: 'version is required' }); return; }
    const deployment = await recordDeployment(actorId, project, dto);
    res.status(201).json(deployment);
  } catch (err) {
    next(err);
  }
});

// ── Analytics / assigned ──────────────────────────────────────────────────────

router.get('/stats/events', async (req, res, next) => {
  try {
    const project = projectFromReq(req);
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    const stats = await getBoardEventStats(project, from, to);
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

router.get('/assigned-to-me', async (req, res, next) => {
  try {
    const project = projectFromReq(req);
    const userId = getUserId(req);
    const items = await listAssignedToUser(project, userId);
    res.json(items);
  } catch (err) {
    next(err);
  }
});

// ── Jobs (admin) ──────────────────────────────────────────────────────────────

router.post('/jobs/due-soon', requirePermission('work-board:admin'), async (_req, res, next) => {
  try {
    const created = await notifyDueSoonWorkItems();
    res.json({ created });
  } catch (err) {
    next(err);
  }
});

// ── ADO import (admin) ────────────────────────────────────────────────────────

router.post('/import/ado', requirePermission('work-board:admin'), async (req, res, next) => {
  try {
    const actorId = getUserId(req);
    const project = projectFromReq(req);
    const body = (req.body ?? {}) as { dryRun?: boolean; areaPath?: string };
    // Default dryRun=true when omitted so accidental clicks do not write.
    const dryRun = body.dryRun !== false;
    const result = await importFromAdo(actorId, project, {
      dryRun,
      areaPath: typeof body.areaPath === 'string' ? body.areaPath : undefined,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── SSE board stream ──────────────────────────────────────────────────────────

router.get('/stream', (req, res, next) => {
  try {
    const project = projectFromReq(req);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    writeSseEvent(res, { type: 'connected', project });

    const stopHeartbeat = startSseHeartbeat(res, 25_000);
    const unsubscribe = subscribeBoardBus((event) => {
      if (event.project !== project) return;
      if (!writeSseEvent(res, { type: 'board-change', ...event })) {
        unsubscribe();
        stopHeartbeat();
      }
    });

    req.on('close', () => {
      unsubscribe();
      stopHeartbeat();
    });
  } catch (err) {
    next(err);
  }
});

// ── List / create / bulk / materialize (static paths before /:id) ─────────────

router.get('/', async (req, res, next) => {
  try {
    const project = projectFromReq(req);
    const { ownerId, types, epicTitle, featureTitle, sourceType, releaseId, parentId, search } =
      req.query as Record<string, string | undefined>;
    const filters: ApexWorkItemFilters = {
      project,
      ownerId: ownerId || undefined,
      types: types ? (types.split(',') as ApexWorkItemType[]) : undefined,
      epicTitle: epicTitle || undefined,
      featureTitle: featureTitle || undefined,
      sourceType: sourceType as ApexWorkItemSourceType | 'all' | undefined,
      releaseId: releaseId || undefined,
      parentId: parentId || undefined,
      search: search || undefined,
    };
    const items = await listApexWorkItems(filters);
    res.json(items);
  } catch (err) {
    next(err);
  }
});

router.post('/', requirePermission('work-board:manage'), async (req, res, next) => {
  try {
    const actorId = getUserId(req);
    const project = projectFromReq(req);
    const dto = { ...(req.body as CreateApexWorkItemDTO), project };
    if (!dto.title?.trim()) { res.status(400).json({ error: 'title is required' }); return; }
    if (!dto.outcome?.trim()) { res.status(400).json({ error: 'outcome is required' }); return; }
    if (!dto.ownerId) { res.status(400).json({ error: 'ownerId is required' }); return; }
    if (!dto.type || !['Epic', 'Feature', 'PBI', 'TBI', 'Bug'].includes(dto.type)) {
      res.status(400).json({ error: 'type must be Epic, Feature, PBI, TBI, or Bug' }); return;
    }
    const item = await createApexWorkItem(actorId, dto);
    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
});

router.post('/bulk', requirePermission('work-board:manage'), async (req, res, next) => {
  try {
    const actorId = getUserId(req);
    const project = projectFromReq(req);
    const dto = req.body as BulkUpdateApexWorkItemsDTO;
    const items = await bulkUpdateApexWorkItems(actorId, project, dto);
    res.json(items);
  } catch (err) {
    next(err);
  }
});

router.post('/materialize-from-prd/preview', requirePermission('work-board:manage'), async (req, res, next) => {
  try {
    const project = projectFromReq(req);
    const dto = { ...(req.body as MaterializeFromPrdDTO & { items: unknown[] }), project };
    if (!dto.prdId) { res.status(400).json({ error: 'prdId is required' }); return; }
    if (!Array.isArray(dto.items) || dto.items.length === 0) {
      res.status(400).json({ error: 'items must be a non-empty array' }); return;
    }
    const preview = await previewMaterializeFromPrd(dto as Parameters<typeof previewMaterializeFromPrd>[0]);
    res.json(preview);
  } catch (err) {
    next(err);
  }
});

router.post('/materialize-from-prd', requirePermission('work-board:manage'), async (req, res, next) => {
  try {
    const actorId = getUserId(req);
    const project = projectFromReq(req);
    const dto = { ...(req.body as MaterializeFromPrdDTO & { items: unknown[] }), project };
    if (!dto.prdId) { res.status(400).json({ error: 'prdId is required' }); return; }
    if (!dto.ownerId) { res.status(400).json({ error: 'ownerId is required' }); return; }
    if (!Array.isArray(dto.items) || dto.items.length === 0) {
      res.status(400).json({ error: 'items must be a non-empty array' }); return;
    }
    const result = await materializeFromPrdWithItems(actorId, dto as Parameters<typeof materializeFromPrdWithItems>[1]);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/materialized-ids/:prdId', async (req, res, next) => {
  try {
    const ids = await getMaterializedItemIds(req.params.prdId, projectFromReq(req));
    res.json({ backlogItemIds: ids });
  } catch (err) {
    next(err);
  }
});

router.post('/generate-drafts', requirePermission('work-board:manage'), async (req, res, next) => {
  try {
    const project = projectFromReq(req);
    const dto = { ...(req.body as GenerateFromFeatureRequestDTO), project };
    if (!dto.featureRequestId) { res.status(400).json({ error: 'featureRequestId is required' }); return; }
    if (!dto.ownerId) { res.status(400).json({ error: 'ownerId is required' }); return; }
    const drafts = await generateDraftsFromFeatureRequest(dto);
    res.json({ drafts });
  } catch (err) {
    next(err);
  }
});

router.post('/create-from-drafts/preview', requirePermission('work-board:manage'), async (req, res, next) => {
  try {
    const project = projectFromReq(req);
    const dto = { ...(req.body as CreateFromDraftsDTO), project };
    if (!dto.featureRequestId) { res.status(400).json({ error: 'featureRequestId is required' }); return; }
    if (!Array.isArray(dto.drafts) || dto.drafts.length === 0) {
      res.status(400).json({ error: 'drafts must be a non-empty array' }); return;
    }
    const preview = await previewCreateFromDrafts(dto);
    res.json(preview);
  } catch (err) {
    next(err);
  }
});

router.post('/create-from-drafts', requirePermission('work-board:manage'), async (req, res, next) => {
  try {
    const actorId = getUserId(req);
    const project = projectFromReq(req);
    const dto = { ...(req.body as CreateFromDraftsDTO), project };
    if (!dto.featureRequestId) { res.status(400).json({ error: 'featureRequestId is required' }); return; }
    if (!dto.ownerId) { res.status(400).json({ error: 'ownerId is required' }); return; }
    if (!Array.isArray(dto.drafts) || dto.drafts.length === 0) {
      res.status(400).json({ error: 'drafts must be a non-empty array' }); return;
    }
    const result = await createFromDrafts(actorId, dto);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// ── Get by id ─────────────────────────────────────────────────────────────────

router.get('/:id', async (req, res, next) => {
  try {
    const item = await getApexWorkItem(req.params.id, projectFromReq(req));
    res.json(item);
  } catch (err) {
    next(err);
  }
});

// ── Update ────────────────────────────────────────────────────────────────────

router.patch('/:id', requirePermission('work-board:manage'), async (req, res, next) => {
  try {
    const actorId = getUserId(req);
    const dto = req.body as UpdateApexWorkItemDTO;
    const item = await updateApexWorkItem(req.params.id, actorId, dto, projectFromReq(req));
    res.json(item);
  } catch (err) {
    next(err);
  }
});

// ── Move ──────────────────────────────────────────────────────────────────────

router.post('/:id/move', requirePermission('work-board:manage'), async (req, res, next) => {
  try {
    const actorId = getUserId(req);
    const dto = req.body as MoveApexWorkItemDTO;
    if (!dto.targetStatus) { res.status(400).json({ error: 'targetStatus is required' }); return; }
    const item = await moveApexWorkItem(req.params.id, actorId, dto, projectFromReq(req));
    res.json(item);
  } catch (err) {
    next(err);
  }
});

// ── Comments ──────────────────────────────────────────────────────────────────

router.get('/:id/comments', async (req, res, next) => {
  try {
    const comments = await listComments(req.params.id, projectFromReq(req));
    res.json(comments);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/comments', requirePermission('work-board:manage'), async (req, res, next) => {
  try {
    const actorId = getUserId(req);
    const body = (req.body as { body?: string }).body ?? '';
    const comment = await addComment(req.params.id, actorId, projectFromReq(req), body);
    res.status(201).json(comment);
  } catch (err) {
    next(err);
  }
});

// ── Attachments ───────────────────────────────────────────────────────────────

router.get('/:id/attachments', async (req, res, next) => {
  try {
    const attachments = await listAttachments(req.params.id, projectFromReq(req));
    res.json(attachments);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/attachments/:attachmentId/content', async (req, res, next) => {
  try {
    const resolved = await resolveAttachmentContent(
      req.params.id,
      req.params.attachmentId,
      projectFromReq(req),
    );
    if (resolved.kind === 'redirect') {
      res.redirect(302, resolved.url);
      return;
    }
    res.setHeader('Content-Type', resolved.contentType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${resolved.fileName.replace(/"/g, '')}"`,
    );
    res.sendFile(resolved.absPath, (err) => {
      if (err) next(err);
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/attachments', requirePermission('work-board:manage'), async (req, res, next) => {
  try {
    const actorId = getUserId(req);
    const meta = req.body as {
      fileName: string;
      contentType?: string;
      byteSize?: number;
      storagePath?: string;
      contentBase64?: string;
    };
    if (!meta.fileName || (!meta.storagePath && !meta.contentBase64)) {
      res.status(400).json({ error: 'fileName and storagePath or contentBase64 are required' });
      return;
    }
    const attachment = await addAttachmentMeta(req.params.id, actorId, projectFromReq(req), {
      fileName: meta.fileName,
      contentType: meta.contentType ?? 'application/octet-stream',
      byteSize: meta.byteSize ?? 0,
      storagePath: meta.storagePath,
      contentBase64: meta.contentBase64,
    });
    res.status(201).json(attachment);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/attachments/:attachmentId', requirePermission('work-board:manage'), async (req, res, next) => {
  try {
    await removeAttachment(
      req.params.id,
      req.params.attachmentId,
      getUserId(req),
      projectFromReq(req),
    );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
