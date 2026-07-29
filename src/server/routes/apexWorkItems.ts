import { Router } from 'express';
import { requireSuperAdmin } from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import {
  listApexWorkItems,
  getApexWorkItem,
  createApexWorkItem,
  updateApexWorkItem,
  moveApexWorkItem,
  listEligibleOwners,
  listFilterFacets,
  materializeFromPrdWithItems,
  generateDraftsFromFeatureRequest,
  createFromDrafts,
  getMaterializedItemIds,
} from '../services/apexWorkItemService';
import type {
  ApexWorkItemFilters,
  ApexWorkItemType,
  ApexWorkItemSourceType,
  CreateApexWorkItemDTO,
  UpdateApexWorkItemDTO,
  MoveApexWorkItemDTO,
  MaterializeFromPrdDTO,
  GenerateFromFeatureRequestDTO,
  CreateFromDraftsDTO,
} from '../../shared/types/apexWorkItem';

const router = Router();

// All routes require super-admin
router.use(requireSuperAdmin);

// ── Filters / owners ──────────────────────────────────────────────────────────

router.get('/owners', async (_req, res, next) => {
  try {
    const owners = await listEligibleOwners();
    res.json(owners);
  } catch (err) {
    next(err);
  }
});

router.get('/facets', async (_req, res, next) => {
  try {
    const facets = await listFilterFacets();
    res.json(facets);
  } catch (err) {
    next(err);
  }
});

// ── List ──────────────────────────────────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const { ownerId, types, epicTitle, featureTitle, sourceType, search } = req.query as Record<string, string | undefined>;
    const filters: ApexWorkItemFilters = {
      ownerId: ownerId || undefined,
      types: types ? (types.split(',') as ApexWorkItemType[]) : undefined,
      epicTitle: epicTitle || undefined,
      featureTitle: featureTitle || undefined,
      sourceType: sourceType as ApexWorkItemSourceType | 'all' | undefined,
      search: search || undefined,
    };
    const items = await listApexWorkItems(filters);
    res.json(items);
  } catch (err) {
    next(err);
  }
});

// ── Get by id ─────────────────────────────────────────────────────────────────

router.get('/:id', async (req, res, next) => {
  try {
    const item = await getApexWorkItem(req.params.id);
    res.json(item);
  } catch (err) {
    next(err);
  }
});

// ── Create (standalone) ───────────────────────────────────────────────────────

router.post('/', async (req, res, next) => {
  try {
    const actorId = getUserId(req);
    const dto = req.body as CreateApexWorkItemDTO;
    if (!dto.title?.trim()) { res.status(400).json({ error: 'title is required' }); return; }
    if (!dto.outcome?.trim()) { res.status(400).json({ error: 'outcome is required' }); return; }
    if (!dto.ownerId) { res.status(400).json({ error: 'ownerId is required' }); return; }
    if (!dto.type || !['PBI', 'TBI', 'Bug'].includes(dto.type)) {
      res.status(400).json({ error: 'type must be PBI, TBI, or Bug' }); return;
    }
    const item = await createApexWorkItem(actorId, dto);
    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
});

// ── Update ────────────────────────────────────────────────────────────────────

router.patch('/:id', async (req, res, next) => {
  try {
    const actorId = getUserId(req);
    const dto = req.body as UpdateApexWorkItemDTO;
    const item = await updateApexWorkItem(req.params.id, actorId, dto);
    res.json(item);
  } catch (err) {
    next(err);
  }
});

// ── Move ──────────────────────────────────────────────────────────────────────

router.post('/:id/move', async (req, res, next) => {
  try {
    const actorId = getUserId(req);
    const dto = req.body as MoveApexWorkItemDTO;
    if (!dto.targetStatus) { res.status(400).json({ error: 'targetStatus is required' }); return; }
    const item = await moveApexWorkItem(req.params.id, actorId, dto);
    res.json(item);
  } catch (err) {
    next(err);
  }
});

// ── Process 1 — Materialize from PRD ─────────────────────────────────────────

router.post('/materialize-from-prd', async (req, res, next) => {
  try {
    const actorId = getUserId(req);
    const dto = req.body as MaterializeFromPrdDTO & { items: unknown[] };
    if (!dto.prdId) { res.status(400).json({ error: 'prdId is required' }); return; }
    if (!dto.ownerId) { res.status(400).json({ error: 'ownerId is required' }); return; }
    if (!Array.isArray(dto.items) || dto.items.length === 0) {
      res.status(400).json({ error: 'items must be a non-empty array' }); return;
    }
    const items = await materializeFromPrdWithItems(actorId, dto as Parameters<typeof materializeFromPrdWithItems>[1]);
    res.status(201).json(items);
  } catch (err) {
    next(err);
  }
});

router.get('/materialized-ids/:prdId', async (req, res, next) => {
  try {
    const ids = await getMaterializedItemIds(req.params.prdId);
    res.json({ backlogItemIds: ids });
  } catch (err) {
    next(err);
  }
});

// ── Process 2 — Generate drafts from Feature Request ─────────────────────────

router.post('/generate-drafts', async (req, res, next) => {
  try {
    const dto = req.body as GenerateFromFeatureRequestDTO;
    if (!dto.featureRequestId) { res.status(400).json({ error: 'featureRequestId is required' }); return; }
    if (!dto.ownerId) { res.status(400).json({ error: 'ownerId is required' }); return; }
    const drafts = await generateDraftsFromFeatureRequest(dto);
    res.json({ drafts });
  } catch (err) {
    next(err);
  }
});

router.post('/create-from-drafts', async (req, res, next) => {
  try {
    const actorId = getUserId(req);
    const dto = req.body as CreateFromDraftsDTO;
    if (!dto.featureRequestId) { res.status(400).json({ error: 'featureRequestId is required' }); return; }
    if (!dto.ownerId) { res.status(400).json({ error: 'ownerId is required' }); return; }
    if (!Array.isArray(dto.drafts) || dto.drafts.length === 0) {
      res.status(400).json({ error: 'drafts must be a non-empty array' }); return;
    }
    const items = await createFromDrafts(actorId, dto);
    res.status(201).json(items);
  } catch (err) {
    next(err);
  }
});

export default router;
