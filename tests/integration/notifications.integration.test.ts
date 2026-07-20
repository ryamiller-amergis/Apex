/**
 * Integration tests for the notifications data layer.
 *
 * Verifies real insert/query behaviour against the notifications table.
 * Uses the dev-mock developer OID (seeded by migration).
 */
import './setup';
import { db } from './setup';
import { notifications } from '../../src/server/db/schema';
import { eq, like, and } from 'drizzle-orm';

const DEVELOPER_OID = 'dev-mock-oid-00000000-0000-0000-0000-000000000000';

async function deleteTestNotifications() {
  await db.delete(notifications).where(
    and(
      eq(notifications.userId, DEVELOPER_OID),
      like(notifications.title, '[E2E-INT]%'),
    ),
  );
}

describe('Notifications integration', () => {
  afterEach(deleteTestNotifications);

  it('inserts and retrieves an unread notification', async () => {
    const [inserted] = await db
      .insert(notifications)
      .values({
        userId: DEVELOPER_OID,
        type: 'system',
        title: '[E2E-INT] Test Notification',
        body: 'Integration test body',
        link: null,
        read: false,
      })
      .returning();

    expect(inserted.id).toBeDefined();
    expect(inserted.read).toBe(false);
    expect(inserted.title).toBe('[E2E-INT] Test Notification');

    // Verify it's queryable.
    const [fetched] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.id, inserted.id));

    expect(fetched.userId).toBe(DEVELOPER_OID);
    expect(fetched.type).toBe('system');
  });

  it('marks a notification as read', async () => {
    const [notif] = await db
      .insert(notifications)
      .values({
        userId: DEVELOPER_OID,
        type: 'system',
        title: '[E2E-INT] Mark Read Test',
        read: false,
      })
      .returning();

    await db
      .update(notifications)
      .set({ read: true })
      .where(eq(notifications.id, notif.id));

    const [updated] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.id, notif.id));

    expect(updated.read).toBe(true);
  });
});
