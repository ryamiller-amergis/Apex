import { db } from '../db/drizzle';
import { uiLabDesigns, uiLabComments } from '../db/schema';
import { eq, desc } from 'drizzle-orm';
import { sanitizeMockHtml } from '../utils/htmlSanitizer';
import { generateUiLabDesign, editUiLabDesign, extractHtml } from './uiLabBedrockService';
import { getSkillConfig } from './projectSettingsService';
import type {
  UiLabDesign,
  UiLabDesignSummary,
  UiLabComment,
  CreateUiLabDesignRequest,
  RegenerateUiLabDesignRequest,
  AddUiLabCommentRequest,
  UiLabHistoryEntry,
} from '../../shared/types/uiLab';

function toDesign(row: Record<string, unknown>): UiLabDesign {
  return row as unknown as UiLabDesign;
}

function toComment(row: Record<string, unknown>): UiLabComment {
  return row as unknown as UiLabComment;
}

export async function listDesigns(project: string): Promise<UiLabDesignSummary[]> {
  const rows = await db
    .select({
      id: uiLabDesigns.id,
      project: uiLabDesigns.project,
      authorId: uiLabDesigns.authorId,
      title: uiLabDesigns.title,
      prompt: uiLabDesigns.prompt,
      targetRoute: uiLabDesigns.targetRoute,
      status: uiLabDesigns.status,
      version: uiLabDesigns.version,
      generationError: uiLabDesigns.generationError,
      createdAt: uiLabDesigns.createdAt,
      updatedAt: uiLabDesigns.updatedAt,
    })
    .from(uiLabDesigns)
    .where(eq(uiLabDesigns.project, project))
    .orderBy(desc(uiLabDesigns.createdAt));

  return rows as unknown as UiLabDesignSummary[];
}

export async function getDesign(id: string): Promise<UiLabDesign | null> {
  const rows = await db.select().from(uiLabDesigns).where(eq(uiLabDesigns.id, id)).limit(1);
  return rows[0] ? toDesign(rows[0] as Record<string, unknown>) : null;
}

/** Resolve the owning project for a design id, or null when it doesn't exist. */
export async function getDesignProject(id: string): Promise<string | null> {
  const rows = await db
    .select({ project: uiLabDesigns.project })
    .from(uiLabDesigns)
    .where(eq(uiLabDesigns.id, id))
    .limit(1);
  return rows[0]?.project ?? null;
}

/** Resolve the owning project for a comment id (via its design), or null when it doesn't exist. */
export async function getCommentProject(commentId: string): Promise<string | null> {
  const rows = await db
    .select({ project: uiLabDesigns.project })
    .from(uiLabComments)
    .innerJoin(uiLabDesigns, eq(uiLabComments.designId, uiLabDesigns.id))
    .where(eq(uiLabComments.id, commentId))
    .limit(1);
  return rows[0]?.project ?? null;
}

export async function createDesign(
  project: string,
  authorId: string,
  req: CreateUiLabDesignRequest,
): Promise<UiLabDesign> {
  const now = new Date().toISOString();
  const rows = await db
    .insert(uiLabDesigns)
    .values({
      project,
      authorId,
      title: req.title,
      prompt: req.prompt,
      targetRoute: req.targetRoute ?? null,
      status: 'generating',
      version: 1,
      history: [],
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return toDesign(rows[0] as Record<string, unknown>);
}

export async function deleteDesign(id: string): Promise<void> {
  await db.delete(uiLabDesigns).where(eq(uiLabDesigns.id, id));
}

export async function saveHtml(id: string, html: string): Promise<void> {
  await db
    .update(uiLabDesigns)
    .set({ html, updatedAt: new Date().toISOString() })
    .where(eq(uiLabDesigns.id, id));
}

/** Called by the SSE route. Streams tokens via onToken, then persists the final result. */
export async function runGeneration(
  designId: string,
  onToken: (chunk: string) => void,
  userId?: string,
): Promise<void> {
  const design = await getDesign(designId);
  if (!design) throw new Error(`UI Lab design ${designId} not found`);

  let skillConfig = null;
  try {
    skillConfig = await getSkillConfig(design.project);
  } catch {
    // non-fatal — use defaults
  }

  const modelId = skillConfig?.uiLabBedrockModelId ?? undefined;
  const maxTokens = skillConfig?.uiLabBedrockMaxTokens ?? undefined;
  const timeoutMs = skillConfig?.uiLabBedrockTimeoutMs ?? undefined;
  const temperature = skillConfig?.uiLabBedrockTemperature ?? undefined;

  await db
    .update(uiLabDesigns)
    .set({ status: 'streaming', model: modelId ?? null, updatedAt: new Date().toISOString() })
    .where(eq(uiLabDesigns.id, designId));

  try {
    const rawHtml = await generateUiLabDesign({
      prompt: design.prompt,
      targetRoute: design.targetRoute,
      modelId,
      maxTokens: maxTokens ?? undefined,
      timeoutMs: timeoutMs ?? undefined,
      temperature: temperature ?? undefined,
      onToken,
      project: design.project,
      userId,
    });

    const html = sanitizeMockHtml(extractHtml(rawHtml));
    const now = new Date().toISOString();
    const historyEntry: UiLabHistoryEntry = {
      version: 1,
      html,
      prompt: design.prompt,
      createdAt: now,
    };

    await db
      .update(uiLabDesigns)
      .set({
        status: 'ready',
        html,
        version: 1,
        history: [historyEntry],
        generationError: null,
        updatedAt: now,
      })
      .where(eq(uiLabDesigns.id, designId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(uiLabDesigns)
      .set({
        status: 'generation_failed',
        generationError: msg,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(uiLabDesigns.id, designId));
    throw err;
  }
}

/** Called by the SSE route for regeneration. */
export async function runRegeneration(
  designId: string,
  req: RegenerateUiLabDesignRequest,
  onToken: (chunk: string) => void,
  userId?: string,
): Promise<void> {
  const design = await getDesign(designId);
  if (!design) throw new Error(`UI Lab design ${designId} not found`);
  if (!design.html) throw new Error('Design has no HTML to regenerate from');

  let skillConfig = null;
  try {
    skillConfig = await getSkillConfig(design.project);
  } catch {
    // non-fatal
  }

  const modelId = skillConfig?.uiLabRegenBedrockModelId ?? skillConfig?.uiLabBedrockModelId ?? undefined;
  const maxTokens = skillConfig?.uiLabRegenBedrockMaxTokens ?? skillConfig?.uiLabBedrockMaxTokens ?? undefined;
  const timeoutMs = skillConfig?.uiLabBedrockTimeoutMs ?? undefined;
  const temperature = skillConfig?.uiLabBedrockTemperature ?? undefined;

  await db
    .update(uiLabDesigns)
    .set({ status: 'streaming', updatedAt: new Date().toISOString() })
    .where(eq(uiLabDesigns.id, designId));

  try {
    const rawHtml = await editUiLabDesign({
      currentHtml: design.html,
      instruction: req.feedback,
      selectedSelector: req.selectedSelector,
      selectedHtml: req.selectedHtml,
      targetRoute: design.targetRoute,
      featureText: design.prompt,
      modelId,
      maxTokens: maxTokens ?? undefined,
      timeoutMs: timeoutMs ?? undefined,
      temperature: temperature ?? undefined,
      onToken,
      project: design.project,
      userId,
    });

    const html = sanitizeMockHtml(extractHtml(rawHtml));
    const newVersion = design.version + 1;
    const now = new Date().toISOString();
    const historyEntry: UiLabHistoryEntry = {
      version: newVersion,
      html,
      feedback: req.feedback,
      selectedSelector: req.selectedSelector ?? undefined,
      createdAt: now,
    };

    const existingHistory: UiLabHistoryEntry[] = Array.isArray(design.history) ? design.history : [];

    await db
      .update(uiLabDesigns)
      .set({
        status: 'ready',
        html,
        version: newVersion,
        history: [...existingHistory, historyEntry],
        generationError: null,
        updatedAt: now,
      })
      .where(eq(uiLabDesigns.id, designId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(uiLabDesigns)
      .set({
        status: 'generation_failed',
        generationError: msg,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(uiLabDesigns.id, designId));
    throw err;
  }
}

export async function listComments(designId: string): Promise<UiLabComment[]> {
  const rows = await db
    .select()
    .from(uiLabComments)
    .where(eq(uiLabComments.designId, designId))
    .orderBy(uiLabComments.createdAt);
  return rows.map((r) => toComment(r as Record<string, unknown>));
}

export async function addComment(
  designId: string,
  authorId: string,
  req: AddUiLabCommentRequest,
): Promise<UiLabComment> {
  const now = new Date().toISOString();
  const rows = await db
    .insert(uiLabComments)
    .values({
      designId,
      authorId,
      text: req.text,
      pinX: req.pinX ?? null,
      pinY: req.pinY ?? null,
      version: req.version,
      resolved: false,
      createdAt: now,
    })
    .returning();
  return toComment(rows[0] as Record<string, unknown>);
}

export async function resolveComment(commentId: string, resolvedBy: string): Promise<void> {
  await db
    .update(uiLabComments)
    .set({ resolved: true, resolvedBy })
    .where(eq(uiLabComments.id, commentId));
}

export async function reopenComment(commentId: string): Promise<void> {
  await db
    .update(uiLabComments)
    .set({ resolved: false, resolvedBy: null })
    .where(eq(uiLabComments.id, commentId));
}
