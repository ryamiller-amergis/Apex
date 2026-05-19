import { db } from '../db/drizzle';
import { appSettings } from '../db/schema';
import { eq } from 'drizzle-orm';

const CODE_DEFAULT_MODEL = 'composer-2';

export async function getAppSetting(key: string): Promise<string | null> {
  const rows = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, key))
    .limit(1);
  return rows[0]?.value ?? null;
}

export async function setAppSetting(key: string, value: string, updatedBy?: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insert(appSettings)
    .values({ key, value, updatedBy, updatedAt: now })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedBy, updatedAt: now },
    });
}

export async function getDefaultModel(): Promise<string> {
  const value = await getAppSetting('defaultModel');
  return value ?? CODE_DEFAULT_MODEL;
}
