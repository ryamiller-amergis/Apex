import { and, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { designDocs, designPrototypes, prds } from '../db/schema';
import { resolveFeatureIndex } from './devContextService';
import { sanitizeMockHtml } from '../utils/htmlSanitizer';
import type {
  ApexFeatureContextBacklogItem,
  ApexFeatureContextDocument,
  ApexFeatureContextPrototype,
  ApexFeatureContextResponse,
} from '../../shared/types/devWorkbench';
import type { DesignPrototypeHistoryEntry } from '../../shared/types/designPrototype';

interface RawBacklogItem {
  id?: string;
  type?: string;
  title?: string;
  status?: string;
  priority?: string;
  description?: string;
  userStory?: string;
  acceptanceCriteria?: unknown;
  definitionOfDone?: unknown;
  dependsOn?: unknown;
}

interface RawFeature {
  id?: string;
  title?: string;
  priority?: string;
  items?: RawBacklogItem[];
}

interface RawEpic {
  title?: string;
  features?: RawFeature[];
}

function formatAcceptanceCriterion(entry: unknown): string | null {
  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    return trimmed || null;
  }
  if (entry && typeof entry === 'object') {
    const obj = entry as { given?: string; when?: string; then?: string };
    const parts: string[] = [];
    if (obj.given) parts.push(`Given ${obj.given}`);
    if (obj.when) parts.push(`When ${obj.when}`);
    if (obj.then) parts.push(`Then ${obj.then}`);
    if (parts.length === 0) return null;
    return parts.join(', ');
  }
  return null;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((v) => (typeof v === 'string' ? v.trim() : null))
    .filter((v): v is string => !!v);
  return items.length > 0 ? items : undefined;
}

function normalizeAcceptanceCriteria(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map(formatAcceptanceCriterion)
    .filter((v): v is string => !!v);
  return items.length > 0 ? items : undefined;
}

function normalizeBacklogItem(raw: RawBacklogItem): ApexFeatureContextBacklogItem | null {
  if (!raw.id || !raw.title) return null;
  const type = raw.type ?? 'PBI';
  const description =
    (typeof raw.description === 'string' && raw.description) ||
    (typeof raw.userStory === 'string' && raw.userStory) ||
    undefined;

  const item: ApexFeatureContextBacklogItem = {
    id: raw.id,
    type,
    title: raw.title,
  };
  if (raw.status) item.status = raw.status;
  if (raw.priority) item.priority = raw.priority;
  if (description) item.description = description;

  const acceptanceCriteria = normalizeAcceptanceCriteria(raw.acceptanceCriteria);
  if (acceptanceCriteria) item.acceptanceCriteria = acceptanceCriteria;

  const definitionOfDone = normalizeStringArray(raw.definitionOfDone);
  if (definitionOfDone) item.definitionOfDone = definitionOfDone;

  const dependencies = normalizeStringArray(raw.dependsOn);
  if (dependencies) item.dependencies = dependencies;

  return item;
}

function findFeatureInBacklog(
  backlogJson: unknown,
  featureId: string,
): { epicTitle: string; feature: RawFeature; featureIndex: number } | null {
  if (!backlogJson || typeof backlogJson !== 'object') return null;
  const backlog = backlogJson as { epics?: RawEpic[] };
  let globalIdx = 0;
  for (const epic of backlog.epics ?? []) {
    for (const feat of epic.features ?? []) {
      if (feat.id === featureId) {
        return {
          epicTitle: epic.title ?? 'Untitled Epic',
          feature: feat,
          featureIndex: globalIdx,
        };
      }
      globalIdx++;
    }
  }
  return null;
}

function mapPrototype(row: {
  id: string;
  featureName: string;
  status: string;
  mockHtml: string | null;
  mockVersion: number;
  history: DesignPrototypeHistoryEntry[] | null;
}): ApexFeatureContextPrototype {
  const history = (row.history ?? []).map((entry) => ({
    version: entry.version,
    html: sanitizeMockHtml(entry.html ?? ''),
    ...(entry.feedback ? { feedback: entry.feedback } : {}),
    createdAt: entry.createdAt,
  }));

  return {
    id: row.id,
    featureName: row.featureName,
    status: row.status,
    mockHtml: sanitizeMockHtml(row.mockHtml ?? ''),
    mockVersion: row.mockVersion,
    history,
  };
}

/**
 * Loads read-only reference context for one approved Apex PRD feature.
 * Returns null when the project is not Apex, or the PRD/feature is absent.
 */
export async function getApexFeatureContext(
  project: string,
  prdId: string,
  featureId: string,
): Promise<ApexFeatureContextResponse | null> {
  if (project !== 'Apex') return null;

  const prdRow = await db.query.prds.findFirst({
    where: and(eq(prds.id, prdId), eq(prds.project, project), eq(prds.status, 'approved')),
  });
  if (!prdRow) return null;

  const featureIndex = resolveFeatureIndex(prdRow.backlogJson, featureId);
  if (featureIndex === null) return null;

  const located = findFeatureInBacklog(prdRow.backlogJson, featureId);
  if (!located) return null;

  const backlogItems = (located.feature.items ?? [])
    .map(normalizeBacklogItem)
    .filter((item): item is ApexFeatureContextBacklogItem => item !== null);

  const docRow = await db.query.designDocs.findFirst({
    where: and(eq(designDocs.prdId, prdId), eq(designDocs.featureIndex, featureIndex)),
  });

  let designDocument: ApexFeatureContextDocument | null = null;
  if (docRow) {
    designDocument = {
      id: docRow.id,
      title: docRow.title,
      status: docRow.status,
      designContent: docRow.designContent ?? '',
      techSpecContent: docRow.techSpecContent ?? '',
      assumptionsContent: docRow.assumptionsContent ?? '',
    };
  }

  let prototype: ApexFeatureContextPrototype | null = null;

  if (docRow?.designPrototypeId) {
    const linked = await db.query.designPrototypes.findFirst({
      where: eq(designPrototypes.id, docRow.designPrototypeId),
    });
    if (linked) {
      prototype = mapPrototype(linked);
    }
  }

  if (!prototype) {
    const byIndex = await db.query.designPrototypes.findFirst({
      where: and(
        eq(designPrototypes.prdId, prdId),
        eq(designPrototypes.featureIndex, featureIndex),
      ),
    });
    if (byIndex) {
      prototype = mapPrototype(byIndex);
    }
  }

  return {
    prdId: prdRow.id,
    prdTitle: prdRow.title,
    prdContent: prdRow.content ?? '',
    epicTitle: located.epicTitle,
    featureId,
    featureTitle: located.feature.title ?? 'Untitled Feature',
    featurePriority: located.feature.priority ?? 'Should',
    backlogItems,
    designDocument,
    prototype,
  };
}
