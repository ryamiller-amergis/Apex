import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { pageScreenshots } from '../db/schema';
import { normaliseUrlToRoute } from '../../shared/utils/routeNormalization';

export interface PageScreenshot {
  id: string;
  route: string;
  displayUrl: string | null;
  imageBase64: string;
  mediaType: string;
  width: number | null;
  height: number | null;
  uploadedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PageScreenshotSummary {
  id: string;
  route: string;
  displayUrl: string | null;
  mediaType: string;
  uploadedBy: string;
  createdAt: string;
  updatedAt: string;
}

function toSummary(row: typeof pageScreenshots.$inferSelect): PageScreenshotSummary {
  return {
    id: row.id,
    route: row.route,
    displayUrl: row.displayUrl,
    mediaType: row.mediaType,
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getScreenshotByRoute(route: string): Promise<PageScreenshot | null> {
  const normalised = normaliseUrlToRoute(route);
  const row = await db.query.pageScreenshots.findFirst({
    where: eq(pageScreenshots.route, normalised),
  });
  if (!row) return null;
  return {
    id: row.id,
    route: row.route,
    displayUrl: row.displayUrl,
    imageBase64: row.imageBase64,
    mediaType: row.mediaType,
    width: row.width,
    height: row.height,
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function upsertScreenshot(
  url: string,
  imageBase64: string,
  mediaType: string,
  uploadedBy: string,
): Promise<PageScreenshot> {
  const route = normaliseUrlToRoute(url);
  const now = new Date().toISOString();

  const [row] = await db
    .insert(pageScreenshots)
    .values({
      route,
      displayUrl: url.trim(),
      imageBase64,
      mediaType,
      uploadedBy,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: pageScreenshots.route,
      set: {
        displayUrl: url.trim(),
        imageBase64,
        mediaType,
        uploadedBy,
        updatedAt: now,
      },
    })
    .returning();

  return {
    id: row.id,
    route: row.route,
    displayUrl: row.displayUrl,
    imageBase64: row.imageBase64,
    mediaType: row.mediaType,
    width: row.width,
    height: row.height,
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function deleteScreenshot(id: string): Promise<void> {
  await db.delete(pageScreenshots).where(eq(pageScreenshots.id, id));
}

export async function listScreenshots(): Promise<PageScreenshotSummary[]> {
  const rows = await db.select().from(pageScreenshots);
  return rows.map(toSummary);
}
