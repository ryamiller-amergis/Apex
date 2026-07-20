/**
 * E2E test seed/reset endpoints.
 *
 * This router is mounted ONLY when E2E_MODE=true (see src/server/index.ts).
 * It is never available in NODE_ENV=production.
 *
 * All records created here use the "[E2E]" prefix so they can be found and
 * deleted by the /reset endpoint without touching real application data.
 */
import express from 'express';
import { like, and } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  notifications,
  reviewComments,
  prds,
  projectMenuSettings,
} from '../db/schema';
import type { MenuItemKey } from '../../shared/types/menuSettings';

const router = express.Router();

// DELETE all records created by E2E tests (idempotent, safe to call repeatedly).
router.post('/reset', async (_req, res) => {
  try {
    await db.delete(reviewComments).where(like(reviewComments.body, '[E2E]%'));
    await db.delete(notifications).where(like(notifications.title, '[E2E]%'));
    await db.delete(prds).where(like(prds.title, '[E2E]%'));
    res.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `E2E reset failed: ${message}` });
  }
});

// Create a PRD in the specified status for testing approval flows.
router.post('/seed/prd', async (req, res) => {
  try {
    const { authorId, project, title, status = 'pending_review', reviewerId } = req.body as {
      authorId: string;
      project: string;
      title: string;
      status?: string;
      reviewerId?: string;
    };

    const [prd] = await db
      .insert(prds)
      .values({
        authorId,
        project,
        title: `[E2E] ${title}`,
        status,
        reviewerId: reviewerId ?? null,
        content: '# E2E Test PRD\n\nThis document was created by Playwright tests.',
        backlogJson: null,
      })
      .returning();

    res.json(prd);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `E2E seed/prd failed: ${message}` });
  }
});

// Update a seeded PRD's status (e.g., after reviewer approves).
router.patch('/seed/prd/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reviewerId, reviewedAt, reviewComment } = req.body as {
      status?: string;
      reviewerId?: string;
      reviewedAt?: string;
      reviewComment?: string;
    };

    const { eq } = await import('drizzle-orm');
    const [updated] = await db
      .update(prds)
      .set({
        ...(status !== undefined && { status }),
        ...(reviewerId !== undefined && { reviewerId }),
        ...(reviewedAt !== undefined && { reviewedAt }),
        ...(reviewComment !== undefined && { reviewComment }),
      })
      .where(and(eq(prds.id, id), like(prds.title, '[E2E]%')))
      .returning();

    if (!updated) return res.status(404).json({ error: 'PRD not found or not an E2E record' });
    res.json(updated);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `E2E patch/prd failed: ${message}` });
  }
});

// Add a review comment to a seeded PRD.
router.post('/seed/prd-comment', async (req, res) => {
  try {
    const {
      prdId,
      authorUserId,
      body,
      status = 'open',
    } = req.body as {
      prdId: string;
      authorUserId: string;
      body: string;
      status?: 'open' | 'resolved';
    };

    const [comment] = await db
      .insert(reviewComments)
      .values({
        documentId: prdId,
        documentType: 'prd',
        sectionKey: 'e2e-section',
        authorUserId,
        body: `[E2E] ${body}`,
        selectorExact: 'E2E Test PRD',
        selectorPrefix: '',
        selectorSuffix: '',
        selectorStart: 0,
        selectorEnd: 14,
        status,
      })
      .returning();

    res.json(comment);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `E2E seed/prd-comment failed: ${message}` });
  }
});

// Create an in-app notification for a user.
router.post('/seed/notification', async (req, res) => {
  try {
    const {
      userId,
      type = 'system',
      title,
      body,
      link,
    } = req.body as {
      userId: string;
      type?: string;
      title: string;
      body?: string;
      link?: string;
    };

    const [notif] = await db
      .insert(notifications)
      .values({
        userId,
        type,
        title: `[E2E] ${title}`,
        body: body ?? null,
        link: link ?? null,
        read: false,
      })
      .returning();

    res.json(notif);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `E2E seed/notification failed: ${message}` });
  }
});

// Override project menu visibility for a test.
router.post('/seed/menu-settings', async (req, res) => {
  try {
    const { project, enabledViews } = req.body as {
      project: string;
      enabledViews: MenuItemKey[];
    };

    await db
      .insert(projectMenuSettings)
      .values({ project, enabledViews })
      .onConflictDoUpdate({
        target: projectMenuSettings.project,
        set: { enabledViews },
      });

    res.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `E2E seed/menu-settings failed: ${message}` });
  }
});

export default router;
