import { and, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { devSessions } from '../db/schema';

export async function touchDevSessionSetup(sessionId: string): Promise<boolean> {
  const [updated] = await db
    .update(devSessions)
    .set({ updatedAt: new Date().toISOString() })
    .where(and(
      eq(devSessions.id, sessionId),
      eq(devSessions.status, 'setting_up'),
    ))
    .returning({ id: devSessions.id });
  return Boolean(updated);
}

export async function activateDevSession(
  sessionId: string,
  values: { chatThreadId: string; branchName: string },
): Promise<boolean> {
  const [updated] = await db
    .update(devSessions)
    .set({
      chatThreadId: values.chatThreadId,
      branchName: values.branchName,
      status: 'in_progress',
      updatedAt: new Date().toISOString(),
    })
    .where(and(
      eq(devSessions.id, sessionId),
      eq(devSessions.status, 'setting_up'),
    ))
    .returning({ id: devSessions.id });
  return Boolean(updated);
}
