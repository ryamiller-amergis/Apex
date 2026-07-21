/**
 * Integration tests for the PRD approval workflow data layer.
 *
 * Verifies real insert/update/query behaviour for PRDs and review comments:
 * - PRD status transitions are persisted correctly.
 * - Open review comments are queryable via documentId + status.
 * - Resolving a comment updates its status.
 */
import './setup';
import { db } from './setup';
import { prds, reviewComments } from '../../src/server/db/schema';
import { eq, and, like } from 'drizzle-orm';

const BA_OID = 'dev-mock-oid-00000000-0000-0000-0000-000000000001';
const DEVELOPER_OID = 'dev-mock-oid-00000000-0000-0000-0000-000000000000';

async function deleteTestPrds() {
  const testPrds = await db
    .select({ id: prds.id })
    .from(prds)
    .where(like(prds.title, '[E2E-INT]%'));

  for (const p of testPrds) {
    await db.delete(reviewComments).where(eq(reviewComments.documentId, p.id));
  }
  await db.delete(prds).where(like(prds.title, '[E2E-INT]%'));
}

describe('PRD workflow integration', () => {
  afterEach(deleteTestPrds);

  it('inserts a PRD in pending_review status', async () => {
    const [prd] = await db
      .insert(prds)
      .values({
        authorId: BA_OID,
        project: 'MaxView',
        title: '[E2E-INT] Approval Workflow PRD',
        status: 'pending_review',
        content: '# Test PRD',
        reviewerId: DEVELOPER_OID,
      })
      .returning();

    expect(prd.id).toBeDefined();
    expect(prd.status).toBe('pending_review');
    expect(prd.reviewerId).toBe(DEVELOPER_OID);
  });

  it('transitions PRD status from pending_review to approved', async () => {
    const [prd] = await db
      .insert(prds)
      .values({
        authorId: BA_OID,
        project: 'MaxView',
        title: '[E2E-INT] Transition Test PRD',
        status: 'pending_review',
        content: '# Test',
      })
      .returning();

    await db
      .update(prds)
      .set({ status: 'approved', reviewedAt: new Date().toISOString() })
      .where(eq(prds.id, prd.id));

    const [updated] = await db.select().from(prds).where(eq(prds.id, prd.id));
    expect(updated.status).toBe('approved');
    expect(updated.reviewedAt).not.toBeNull();
  });

  it('inserts open review comment and queries by document + status', async () => {
    const [prd] = await db
      .insert(prds)
      .values({
        authorId: BA_OID,
        project: 'MaxView',
        title: '[E2E-INT] Comment Test PRD',
        status: 'pending_review',
        content: '# Test',
      })
      .returning();

    await db.insert(reviewComments).values({
      documentId: prd.id,
      documentType: 'prd',
      sectionKey: 'intro',
      authorUserId: DEVELOPER_OID,
      body: '[E2E-INT] This needs more detail',
      selectorExact: 'intro text',
      selectorPrefix: '',
      selectorSuffix: '',
      selectorStart: 0,
      selectorEnd: 10,
      status: 'open',
    });

    const openComments = await db
      .select()
      .from(reviewComments)
      .where(
        and(
          eq(reviewComments.documentId, prd.id),
          eq(reviewComments.status, 'open'),
        ),
      );

    expect(openComments).toHaveLength(1);
    expect(openComments[0].authorUserId).toBe(DEVELOPER_OID);
  });

  it('resolving a comment changes its status to resolved', async () => {
    const [prd] = await db
      .insert(prds)
      .values({
        authorId: BA_OID,
        project: 'MaxView',
        title: '[E2E-INT] Resolve Comment PRD',
        status: 'pending_review',
        content: '# Test',
      })
      .returning();

    const [comment] = await db
      .insert(reviewComments)
      .values({
        documentId: prd.id,
        documentType: 'prd',
        sectionKey: 'intro',
        authorUserId: DEVELOPER_OID,
        body: '[E2E-INT] To be resolved',
        selectorExact: 'text',
        selectorPrefix: '',
        selectorSuffix: '',
        selectorStart: 0,
        selectorEnd: 4,
        status: 'open',
      })
      .returning();

    await db
      .update(reviewComments)
      .set({ status: 'resolved' })
      .where(eq(reviewComments.id, comment.id));

    const [resolved] = await db
      .select()
      .from(reviewComments)
      .where(eq(reviewComments.id, comment.id));

    expect(resolved.status).toBe('resolved');
  });
});
