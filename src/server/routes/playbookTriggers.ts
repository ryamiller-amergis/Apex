/**
 * Playbook trigger subscriptions. Reads need playbooks:view. Changes need
 * playbooks:triggers:manage. The catalog flag is separate from this flag.
 */
import express, { Request, Response } from 'express';
import { requirePermission, resolveRequestProject } from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import {
  PlaybookTriggerValidationError,
  createPlaybookTrigger,
  deletePlaybookTrigger,
  listPlaybookTriggerReceipts,
  listPlaybookTriggers,
  setPlaybookTriggerEnabled,
  updatePlaybookTrigger,
} from '../services/playbookTriggerSubscriptionService';
import {
  dispatchPlaybookTrigger,
  recordPlaybookTriggerEvent,
  storedPlaybookTriggerDispatch,
  testPlaybookTrigger,
} from '../services/playbookTriggerDispatchService';
import { db } from '../db/drizzle';
import { playbookTriggerReceipts, playbookTriggerSubscriptions } from '../db/schema';
import { and, eq } from 'drizzle-orm';

const router = express.Router();

router.get(
  '/',
  requirePermission('playbooks:view'),
  async (req: Request, res: Response): Promise<void> => {
    const project = resolveRequestProject(req)!;
    const definitionId = req.query.definitionId;
    if (typeof definitionId !== 'string' || !definitionId) {
      res.status(400).json({ error: 'definitionId is required' });
      return;
    }
    res.json({ triggers: await listPlaybookTriggers(project, definitionId) });
  },
);

router.post(
  '/',
  requirePermission('playbooks:triggers:manage'),
  async (req: Request, res: Response): Promise<void> => {
    const project = resolveRequestProject(req)!;
    const actorUserId = getUserId(req);
    const definitionId = (req.body as { definitionId?: unknown })?.definitionId;
    if (!actorUserId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (typeof definitionId !== 'string' || !definitionId) {
      res.status(400).json({ error: 'definitionId is required' });
      return;
    }
    try {
      res.status(201).json(await createPlaybookTrigger({
        project,
        definitionId,
        actorUserId,
        body: req.body,
      }));
    } catch (error) {
      if (error instanceof PlaybookTriggerValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
  },
);

router.put(
  '/:triggerId',
  requirePermission('playbooks:triggers:manage'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(await updatePlaybookTrigger({
        project: resolveRequestProject(req)!,
        triggerId: req.params.triggerId,
        body: req.body,
      }));
    } catch (error) {
      if (error instanceof PlaybookTriggerValidationError) {
        res.status(error.message === 'Trigger not found.' ? 404 : 400).json({ error: error.message });
        return;
      }
      throw error;
    }
  },
);

router.post(
  '/:triggerId/pause',
  requirePermission('playbooks:triggers:manage'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(await setPlaybookTriggerEnabled({
        project: resolveRequestProject(req)!,
        triggerId: req.params.triggerId,
        enabled: false,
      }));
    } catch (error) {
      if (error instanceof PlaybookTriggerValidationError) {
        res.status(404).json({ error: error.message });
        return;
      }
      throw error;
    }
  },
);

router.delete(
  '/:triggerId',
  requirePermission('playbooks:triggers:manage'),
  async (req: Request, res: Response): Promise<void> => {
    await deletePlaybookTrigger(resolveRequestProject(req)!, req.params.triggerId);
    res.status(204).end();
  },
);

router.post(
  '/:triggerId/test',
  requirePermission('playbooks:triggers:manage'),
  async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as { entityId?: unknown; actorUserId?: unknown; data?: unknown };
    const result = await testPlaybookTrigger({
      project: resolveRequestProject(req)!,
      subscriptionId: req.params.triggerId,
      event: {
        entityId: typeof body.entityId === 'string' ? body.entityId : 'test',
        actorUserId: typeof body.actorUserId === 'string' ? body.actorUserId : null,
        data: body.data && typeof body.data === 'object' ? body.data as Record<string, unknown> : {},
      },
    });
    if (!result.ok && result.error === 'Trigger not found.') {
      res.status(404).json({ error: result.error });
      return;
    }
    res.json(result);
  },
);

router.post(
  '/:triggerId/run-now',
  requirePermission('playbooks:triggers:manage'),
  async (req: Request, res: Response): Promise<void> => {
    const [subscription] = await db.select().from(playbookTriggerSubscriptions).where(and(
      eq(playbookTriggerSubscriptions.id, req.params.triggerId),
      eq(playbookTriggerSubscriptions.project, resolveRequestProject(req)!),
    ));
    if (!subscription) {
      res.status(404).json({ error: 'Trigger not found.' });
      return;
    }
    const result = await dispatchPlaybookTrigger({
      subscriptionId: subscription.id,
      source: 'manual',
      idempotencyKey: `manual:${new Date().toISOString()}`,
      event: {
        entityId: subscription.definitionId,
        actorUserId: subscription.initiatorUserId,
        data: {},
      },
    });
    res.status(result.runId ? 201 : 200).json(result);
  },
);

router.get(
  '/:triggerId/receipts',
  requirePermission('playbooks:view'),
  async (req: Request, res: Response): Promise<void> => {
    const receipts = await listPlaybookTriggerReceipts(resolveRequestProject(req)!, req.params.triggerId);
    if (!receipts) {
      res.status(404).json({ error: 'Trigger not found.' });
      return;
    }
    res.json({ receipts });
  },
);

router.post(
  '/:triggerId/receipts/:receiptId/replay',
  requirePermission('playbooks:triggers:manage'),
  async (req: Request, res: Response): Promise<void> => {
    const [subscription] = await db.select({ id: playbookTriggerSubscriptions.id }).from(playbookTriggerSubscriptions).where(and(
      eq(playbookTriggerSubscriptions.id, req.params.triggerId),
      eq(playbookTriggerSubscriptions.project, resolveRequestProject(req)!),
    ));
    if (!subscription) {
      res.status(404).json({ error: 'Trigger not found.' });
      return;
    }
    const [receipt] = await db.select().from(playbookTriggerReceipts).where(and(
      eq(playbookTriggerReceipts.id, req.params.receiptId),
      eq(playbookTriggerReceipts.subscriptionId, req.params.triggerId),
    ));
    if (!receipt || receipt.status !== 'dead_letter') {
      res.status(404).json({ error: 'Dead letter not found.' });
      return;
    }
    await db.update(playbookTriggerReceipts).set({
      status: 'retryable',
      nextRetryAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).where(eq(playbookTriggerReceipts.id, receipt.id));
    recordPlaybookTriggerEvent('replay', { receiptId: receipt.id, subscriptionId: receipt.subscriptionId });
    const payload = (receipt.payload ?? {}) as Record<string, unknown>;
    const stored = storedPlaybookTriggerDispatch(payload, receipt.source);
    res.json(await dispatchPlaybookTrigger({
      subscriptionId: receipt.subscriptionId,
      source: stored.source,
      idempotencyKey: receipt.idempotencyKey,
      event: stored.event,
    }));
  },
);

export default router;
