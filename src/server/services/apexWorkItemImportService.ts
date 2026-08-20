/**
 * Idempotent Azure DevOps → Apex Work Board importer.
 * Supports dry-run (no writes) and live import keyed by (project, ado_work_item_id).
 */

import { and, eq, isNotNull, max } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { apexReleases, apexWorkItems, apexWorkItemEvents } from '../db/schema';
import { AzureDevOpsService } from './azureDevOps';
import { emitBoardChange } from './apexWorkBoardBus';
import type {
  ApexWorkItemStatus,
  ApexWorkItemType,
} from '../../shared/types/apexWorkItem';

export interface AdoImportOptions {
  dryRun: boolean;
  areaPath?: string;
}

export interface AdoImportPreviewItem {
  adoId: number;
  title: string;
  type: ApexWorkItemType;
  status: ApexWorkItemStatus;
  adoState: string;
  releaseName: string | null;
  parentAdoId: number | null;
  action: 'create' | 'update' | 'skip';
}

export interface AdoImportResult {
  created: number;
  updated: number;
  skipped: number;
  releasesCreated: number;
  errors: string[];
  preview?: AdoImportPreviewItem[];
}

type AdoRawItem = {
  id: number;
  fields: Record<string, unknown>;
  relations?: Array<{ rel?: string; url?: string; attributes?: Record<string, unknown> }>;
};

const IMPORT_FIELDS = [
  'System.Id',
  'System.Title',
  'System.Description',
  'System.WorkItemType',
  'System.State',
  'System.Tags',
  'System.Parent',
  'Microsoft.VSTS.Scheduling.TargetDate',
  'Microsoft.VSTS.Scheduling.DueDate',
];

function mapAdoType(workItemType: string): ApexWorkItemType | null {
  const t = workItemType.trim().toLowerCase();
  if (t === 'epic') return 'Epic';
  if (t === 'feature') return 'Feature';
  if (t === 'product backlog item' || t === 'user story') return 'PBI';
  if (t === 'technical backlog item') return 'TBI';
  if (t === 'bug') return 'Bug';
  return null;
}

function mapAdoState(state: string): ApexWorkItemStatus {
  const s = state.trim().toLowerCase();
  if (['new', 'proposed', 'to do', 'todo', 'idea', 'draft'].includes(s)) return 'idea';
  if (['approved', 'ready', 'committed', 'groomed'].includes(s)) return 'ready';
  if (['active', 'in progress', 'doing', 'committed to sprint', 'development'].includes(s)) {
    return 'in-progress';
  }
  if (
    ['resolved', 'in review', 'in pull request', 'code review', 'peer review', 'qa', 'testing'].includes(s)
  ) {
    return 'review';
  }
  if (['done', 'closed', 'completed', 'removed', 'cut'].includes(s)) return 'done';
  return 'ready';
}

function parseTags(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw.split(';').map((t) => t.trim()).filter(Boolean);
}

/** Derive a release display name from tags / epic title patterns. */
function deriveReleaseName(title: string, tags: string[], type: ApexWorkItemType): string | null {
  for (const tag of tags) {
    const releaseMatch = /^Release:(.+)$/i.exec(tag);
    if (releaseMatch?.[1]?.trim()) return releaseMatch[1].trim();
  }
  if (tags.some((t) => t.toLowerCase() === 'releaseversion') && /release/i.test(title)) {
    return title.trim();
  }
  if (type === 'Epic' && /release/i.test(title)) {
    return title.trim();
  }
  return null;
}

function parentIdFromRelations(item: AdoRawItem): number | null {
  const parentField = item.fields['System.Parent'];
  if (typeof parentField === 'number' && Number.isFinite(parentField)) return parentField;
  if (typeof parentField === 'string' && /^\d+$/.test(parentField)) return Number(parentField);

  for (const rel of item.relations ?? []) {
    if (rel.rel !== 'System.LinkTypes.Hierarchy-Reverse' || !rel.url) continue;
    const m = /workItems\/(\d+)/i.exec(rel.url);
    if (m) return Number(m[1]);
  }
  return null;
}

function stripHtml(html: unknown): string {
  if (typeof html !== 'string') return '';
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeWiqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

async function nextItemNumber(
  project: string,
  tx: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0],
): Promise<number> {
  const [row] = await tx
    .select({ maxNum: max(apexWorkItems.itemNumber) })
    .from(apexWorkItems)
    .where(eq(apexWorkItems.project, project));
  return (row?.maxNum ?? 0) + 1;
}

async function ensureRelease(
  actorId: string,
  project: string,
  name: string,
  cache: Map<string, string>,
  dryRun: boolean,
): Promise<{ id: string; created: boolean }> {
  const key = name.trim().toLowerCase();
  const cached = cache.get(key);
  if (cached) return { id: cached, created: false };

  if (!cache.has('__seeded__')) {
    const rows = await db
      .select({ id: apexReleases.id, name: apexReleases.name })
      .from(apexReleases)
      .where(eq(apexReleases.project, project));
    for (const r of rows) {
      cache.set(r.name.trim().toLowerCase(), r.id);
    }
    cache.set('__seeded__', '1');
  }
  const existingId = cache.get(key);
  if (existingId && existingId !== '1') {
    return { id: existingId, created: false };
  }

  if (dryRun) {
    const tempId = `preview-release-${key}`;
    cache.set(key, tempId);
    return { id: tempId, created: true };
  }

  const [row] = await db
    .insert(apexReleases)
    .values({
      project,
      name: name.trim(),
      status: 'planned',
      position: 9999,
      createdBy: actorId,
      updatedBy: actorId,
    })
    .returning();
  cache.set(key, row.id);
  return { id: row.id, created: true };
}

export async function importFromAdo(
  actorId: string,
  project: string,
  options: AdoImportOptions,
): Promise<AdoImportResult> {
  const p = project.trim();
  if (!p) {
    return { created: 0, updated: 0, skipped: 0, releasesCreated: 0, errors: ['project is required'] };
  }
  if (!actorId) {
    return { created: 0, updated: 0, skipped: 0, releasesCreated: 0, errors: ['actorId is required'] };
  }

  const dryRun = !!options.dryRun;
  const errors: string[] = [];
  const preview: AdoImportPreviewItem[] = [];

  let ado: AzureDevOpsService;
  try {
    ado = new AzureDevOpsService(p, options.areaPath);
  } catch (err) {
    return {
      created: 0,
      updated: 0,
      skipped: 0,
      releasesCreated: 0,
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }

  const areaClause = options.areaPath?.trim()
    ? ` AND [System.AreaPath] UNDER '${escapeWiqlLiteral(options.areaPath.trim())}'`
    : '';

  const wiql =
    `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${escapeWiqlLiteral(p)}'` +
    ` AND [System.WorkItemType] IN ('Epic', 'Feature', 'Product Backlog Item', 'Technical Backlog Item', 'Bug', 'User Story')` +
    areaClause +
    ` AND [System.State] <> 'Removed'` +
    ` ORDER BY [System.Id] ASC`;

  let rawItems: AdoRawItem[] = [];
  try {
    const result = await ado.queryWorkItemsByWiql({
      wiql,
      fields: IMPORT_FIELDS,
      maxResults: 500,
      includeRelations: true,
    });
    rawItems = result.items as AdoRawItem[];
    if (result.totalMatched > result.returned) {
      errors.push(
        `ADO returned ${result.returned} of ${result.totalMatched} matching items (import capped at 500). Re-run after importing or narrow areaPath.`,
      );
    }
  } catch (err) {
    return {
      created: 0,
      updated: 0,
      skipped: 0,
      releasesCreated: 0,
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }

  const existingRows = await db
    .select({
      id: apexWorkItems.id,
      adoWorkItemId: apexWorkItems.adoWorkItemId,
      title: apexWorkItems.title,
      status: apexWorkItems.status,
    })
    .from(apexWorkItems)
    .where(and(eq(apexWorkItems.project, p), isNotNull(apexWorkItems.adoWorkItemId)));

  const existingByAdoId = new Map(
    existingRows
      .filter((r): r is typeof r & { adoWorkItemId: number } => r.adoWorkItemId != null)
      .map((r) => [r.adoWorkItemId, r]),
  );

  // Process Epics → Features → leaf items so parents exist before children.
  const typeRank = (t: ApexWorkItemType): number => {
    if (t === 'Epic') return 0;
    if (t === 'Feature') return 1;
    return 2;
  };

  const mapped = rawItems
    .map((item) => {
      const adoType = String(item.fields['System.WorkItemType'] ?? '');
      const type = mapAdoType(adoType);
      if (!type) return null;
      const title = String(item.fields['System.Title'] ?? '').trim() || `ADO #${item.id}`;
      const adoState = String(item.fields['System.State'] ?? '');
      const status = mapAdoState(adoState);
      const tags = parseTags(item.fields['System.Tags']);
      const releaseName = deriveReleaseName(title, tags, type);
      const parentAdoId = parentIdFromRelations(item);
      const outcome = stripHtml(item.fields['System.Description']);
      const dueRaw =
        item.fields['Microsoft.VSTS.Scheduling.DueDate'] ??
        item.fields['Microsoft.VSTS.Scheduling.TargetDate'];
      const dueDate =
        typeof dueRaw === 'string' && dueRaw
          ? dueRaw.slice(0, 10)
          : null;
      return {
        adoId: item.id,
        title,
        type,
        status,
        adoState,
        tags,
        releaseName,
        parentAdoId,
        outcome,
        dueDate,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x != null)
    .sort((a, b) => typeRank(a.type) - typeRank(b.type) || a.adoId - b.adoId);

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let releasesCreated = 0;
  const releaseCache = new Map<string, string>();
  /** adoId → apex uuid (includes newly created in this run) */
  const adoToApexId = new Map<number, string>(
    [...existingByAdoId.entries()].map(([adoId, row]) => [adoId, row.id]),
  );

  const applyOne = async (item: (typeof mapped)[number]): Promise<void> => {
    let releaseId: string | null = null;
    if (item.releaseName) {
      const rel = await ensureRelease(actorId, p, item.releaseName, releaseCache, dryRun);
      if (rel.created) releasesCreated += 1;
      releaseId = rel.id.startsWith('preview-release-') ? null : rel.id;
    }

    const parentId =
      item.parentAdoId != null ? adoToApexId.get(item.parentAdoId) ?? null : null;

    const existing = existingByAdoId.get(item.adoId);
    if (existing) {
      const titleChanged = existing.title !== item.title;
      const statusChanged = existing.status !== item.status;
      if (!titleChanged && !statusChanged) {
        skipped += 1;
        if (preview.length < 25) {
          preview.push({
            adoId: item.adoId,
            title: item.title,
            type: item.type,
            status: item.status,
            adoState: item.adoState,
            releaseName: item.releaseName,
            parentAdoId: item.parentAdoId,
            action: 'skip',
          });
        }
        return;
      }

      if (!dryRun) {
        await db
          .update(apexWorkItems)
          .set({
            title: item.title,
            status: item.status,
            releaseId: releaseId ?? undefined,
            parentId: parentId ?? undefined,
            updatedBy: actorId,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(apexWorkItems.id, existing.id));
        await db.insert(apexWorkItemEvents).values({
          workItemId: existing.id,
          actorId,
          action: 'updated',
          details: { source: 'ado-import', adoWorkItemId: item.adoId },
        });
      }
      updated += 1;
      if (preview.length < 25) {
        preview.push({
          adoId: item.adoId,
          title: item.title,
          type: item.type,
          status: item.status,
          adoState: item.adoState,
          releaseName: item.releaseName,
          parentAdoId: item.parentAdoId,
          action: 'update',
        });
      }
      return;
    }

    // create
    if (dryRun) {
      created += 1;
      adoToApexId.set(item.adoId, `preview-${item.adoId}`);
      if (preview.length < 25) {
        preview.push({
          adoId: item.adoId,
          title: item.title,
          type: item.type,
          status: item.status,
          adoState: item.adoState,
          releaseName: item.releaseName,
          parentAdoId: item.parentAdoId,
          action: 'create',
        });
      }
      return;
    }

    const row = await db.transaction(async (tx) => {
      const itemNumber = await nextItemNumber(p, tx);
      const [inserted] = await tx
        .insert(apexWorkItems)
        .values({
          project: p,
          itemNumber,
          title: item.title,
          outcome: item.outcome || `Imported from Azure DevOps #${item.adoId}`,
          type: item.type,
          status: item.status,
          ownerOid: actorId,
          acceptanceCriteria: [],
          position: 9999,
          dueDate: item.dueDate,
          releaseId,
          parentId,
          sourceType: 'standalone',
          adoWorkItemId: item.adoId,
          createdBy: actorId,
          updatedBy: actorId,
        })
        .returning();
      await tx.insert(apexWorkItemEvents).values({
        workItemId: inserted.id,
        actorId,
        action: 'created',
        details: { source: 'ado-import', adoWorkItemId: item.adoId },
      });
      return inserted;
    });

    adoToApexId.set(item.adoId, row.id);
    created += 1;
    if (preview.length < 25) {
      preview.push({
        adoId: item.adoId,
        title: item.title,
        type: item.type,
        status: item.status,
        adoState: item.adoState,
        releaseName: item.releaseName,
        parentAdoId: item.parentAdoId,
        action: 'create',
      });
    }
  };

  for (const item of mapped) {
    try {
      await applyOne(item);
    } catch (err) {
      errors.push(
        `ADO #${item.adoId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (!dryRun && (created > 0 || updated > 0 || releasesCreated > 0)) {
    emitBoardChange(p, { action: 'ado_import' });
  }

  return {
    created,
    updated,
    skipped,
    releasesCreated,
    errors,
    preview,
  };
}
