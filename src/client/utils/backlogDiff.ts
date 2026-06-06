// ── Structural backlog diff utility ──────────────────────────────────────────
//
// Compares two PRD backlog JSON objects and produces a flat, human-readable
// list of change descriptors instead of a raw JSON text diff.
//
// Key design choice: parents (epics/features) that have no field-level changes
// of their own are NOT emitted as change cards. Instead, their title is pushed
// into the `parentPath` breadcrumb on each child change so the BA sees context
// without noise.

/* ── Backlog shapes (mirrors BacklogViewer local types) ──────────────────── */

interface AcceptanceCriterion {
  given?: string;
  when?: string;
  then?: string;
}

interface UserStory {
  persona?: string;
  iWant?: string;
  soThat?: string;
}

interface BacklogItem {
  type?: string;
  id?: string;
  title: string;
  priority?: string;
  description?: string;
  acceptanceCriteria?: AcceptanceCriterion[];
  definitionOfDone?: string[];
  userStory?: UserStory;
  businessRules?: string[];
  outOfScope?: string[];
  dependsOn?: string[];
  technicalDependencies?: string[];
  [key: string]: unknown;
}

interface Feature {
  title: string;
  priority?: string;
  description?: string;
  affectedPersonas?: string[];
  outOfScope?: string[];
  dependencies?: string[];
  items?: BacklogItem[];
  [key: string]: unknown;
}

interface Epic {
  title: string;
  priority?: string;
  description?: string;
  successMetrics?: string[];
  outOfScope?: string[];
  assumptions?: string[];
  dependencies?: string[];
  features?: Feature[];
  [key: string]: unknown;
}

interface BacklogData {
  epics?: Epic[];
  [key: string]: unknown;
}

/* ── Public types ────────────────────────────────────────────────────────── */

export interface ItemDetail {
  label: string;
  value: string;
  items?: string[];
}

export interface FieldChange {
  field: string;
  oldValue: string;
  newValue: string;
  addedItems?: string[];
  removedItems?: string[];
}

export type ChangeKind = 'added' | 'removed' | 'modified';

export interface ItemChange {
  kind: ChangeKind;
  itemType: 'Epic' | 'Feature' | 'PBI' | 'Item';
  title: string;
  /** Breadcrumb path from ancestor items, e.g. "Epic Name > Feature Name". */
  parentPath?: string;
  /** For modified items, the field-level deltas. */
  fields: FieldChange[];
  /** For added/removed items, readable property details. */
  details: ItemDetail[];
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function isBacklogData(val: unknown): val is BacklogData {
  return typeof val === 'object' && val !== null;
}

function matchByTitle<T extends { title: string }>(
  oldList: T[],
  newList: T[],
): { matched: [T, T][]; added: T[]; removed: T[] } {
  const oldMap = new Map<string, T>();
  for (const item of oldList) oldMap.set(item.title, item);

  const newMap = new Map<string, T>();
  for (const item of newList) newMap.set(item.title, item);

  const matched: [T, T][] = [];
  const added: T[] = [];
  const removed: T[] = [];

  for (const item of newList) {
    const old = oldMap.get(item.title);
    if (old) {
      matched.push([old, item]);
    } else {
      added.push(item);
    }
  }
  for (const item of oldList) {
    if (!newMap.has(item.title)) {
      removed.push(item);
    }
  }
  return { matched, added, removed };
}

function formatAc(ac: AcceptanceCriterion): string {
  const parts: string[] = [];
  if (ac.given) parts.push(`Given ${ac.given}`);
  if (ac.when) parts.push(`When ${ac.when}`);
  if (ac.then) parts.push(`Then ${ac.then}`);
  return parts.join(', ') || '(empty criterion)';
}

function formatUserStory(us: UserStory): string {
  const parts: string[] = [];
  if (us.persona) parts.push(`As a ${us.persona}`);
  if (us.iWant) parts.push(`I want ${us.iWant}`);
  if (us.soThat) parts.push(`So that ${us.soThat}`);
  return parts.join(', ');
}

function stringifyArrayItem(val: unknown): string {
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && val !== null) {
    const obj = val as Record<string, unknown>;
    if ('given' in obj || 'when' in obj || 'then' in obj) return formatAc(obj as AcceptanceCriterion);
    if ('rule' in obj) return String(obj.rule);
    if ('title' in obj) return String(obj.title);
  }
  return JSON.stringify(val);
}

function joinPath(parent: string | undefined, segment: string): string {
  return parent ? `${parent} > ${segment}` : segment;
}

/* ── Field configuration ─────────────────────────────────────────────────── */

const SKIP_FIELDS = new Set([
  'features', 'items', 'adoWorkItemId', 'adoWorkItemUrl',
  'featureFlag', 'uiMock', 'uiSurfacePlan',
  'businessClarifications', 'uiUxClarifications',
  'clarificationNeeded', 'nonFunctionalRequirements',
  'parallelGroup',
]);

const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  description: 'Description',
  priority: 'Priority',
  tags: 'Tags',
  confidence: 'Confidence',
  sourceEvidence: 'Source Evidence',
  acceptanceCriteria: 'Acceptance Criteria',
  definitionOfDone: 'Definition of Done',
  outOfScope: 'Out of Scope',
  dependencies: 'Dependencies',
  dependsOn: 'Depends On',
  technicalDependencies: 'Technical Dependencies',
  successMetrics: 'Success Metrics',
  assumptions: 'Assumptions',
  affectedPersonas: 'Affected Personas',
  businessRules: 'Business Rules',
  status: 'Status',
  type: 'Type',
  id: 'ID',
  userStory: 'User Story',
};

/* ── Extract readable details for added/removed items ────────────────────── */

function extractDetails(obj: Record<string, unknown>): ItemDetail[] {
  const details: ItemDetail[] = [];
  const fieldOrder = [
    'description', 'priority', 'userStory',
    'acceptanceCriteria', 'definitionOfDone',
    'tags', 'dependencies', 'dependsOn', 'technicalDependencies',
    'outOfScope', 'successMetrics', 'assumptions',
    'affectedPersonas', 'businessRules', 'sourceEvidence', 'confidence',
  ];

  for (const key of fieldOrder) {
    const val = obj[key];
    if (val == null) continue;

    const label = FIELD_LABELS[key] ?? key;

    if (key === 'userStory' && typeof val === 'object') {
      const text = formatUserStory(val as UserStory);
      if (text) details.push({ label, value: text });
      continue;
    }

    if (Array.isArray(val) && val.length > 0) {
      const items = val.map(stringifyArrayItem);
      details.push({ label, value: `${items.length} item${items.length !== 1 ? 's' : ''}`, items });
      continue;
    }

    if (typeof val === 'string' && val.trim()) {
      details.push({ label, value: val });
      continue;
    }
  }
  return details;
}

/* ── Field-level diff for modified items ─────────────────────────────────── */

function diffFields(oldObj: Record<string, unknown>, newObj: Record<string, unknown>): FieldChange[] {
  const changes: FieldChange[] = [];
  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);
  for (const key of allKeys) {
    if (SKIP_FIELDS.has(key)) continue;
    const oldVal = oldObj[key];
    const newVal = newObj[key];
    const oldStr = JSON.stringify(oldVal ?? null);
    const newStr = JSON.stringify(newVal ?? null);
    if (oldStr === newStr) continue;

    const label = FIELD_LABELS[key] ?? key;

    if (key === 'userStory') {
      changes.push({
        field: label,
        oldValue: oldVal ? formatUserStory(oldVal as UserStory) : '(none)',
        newValue: newVal ? formatUserStory(newVal as UserStory) : '(none)',
      });
      continue;
    }

    if (Array.isArray(oldVal) || Array.isArray(newVal)) {
      const oldArr = (Array.isArray(oldVal) ? oldVal : []).map(stringifyArrayItem);
      const newArr = (Array.isArray(newVal) ? newVal : []).map(stringifyArrayItem);
      const oldSet = new Set(oldArr);
      const newSet = new Set(newArr);
      const addedItems = newArr.filter((x) => !oldSet.has(x));
      const removedItems = oldArr.filter((x) => !newSet.has(x));

      const oldSummary = oldArr.length > 0 ? `${oldArr.length} item${oldArr.length !== 1 ? 's' : ''}` : '(none)';
      const newSummary = newArr.length > 0 ? `${newArr.length} item${newArr.length !== 1 ? 's' : ''}` : '(none)';

      if (addedItems.length > 0 || removedItems.length > 0) {
        changes.push({
          field: label,
          oldValue: oldSummary,
          newValue: newSummary,
          addedItems: addedItems.length > 0 ? addedItems : undefined,
          removedItems: removedItems.length > 0 ? removedItems : undefined,
        });
      }
      continue;
    }

    const formatScalar = (v: unknown): string => {
      if (v == null) return '(empty)';
      if (typeof v === 'string') return v || '(empty)';
      return String(v);
    };

    changes.push({
      field: label,
      oldValue: formatScalar(oldVal),
      newValue: formatScalar(newVal),
    });
  }
  return changes;
}

/* ── Flat diff builders ──────────────────────────────────────────────────── */

function diffItems(
  oldItems: BacklogItem[],
  newItems: BacklogItem[],
  parentPath: string,
): ItemChange[] {
  const { matched, added, removed } = matchByTitle(oldItems, newItems);
  const changes: ItemChange[] = [];

  for (const item of added) {
    changes.push({
      kind: 'added',
      itemType: (item.type as 'PBI') ?? 'Item',
      title: item.title,
      parentPath,
      fields: [],
      details: extractDetails(item as Record<string, unknown>),
    });
  }
  for (const item of removed) {
    changes.push({
      kind: 'removed',
      itemType: (item.type as 'PBI') ?? 'Item',
      title: item.title,
      parentPath,
      fields: [],
      details: extractDetails(item as Record<string, unknown>),
    });
  }
  for (const [oldItem, newItem] of matched) {
    const fields = diffFields(oldItem as Record<string, unknown>, newItem as Record<string, unknown>);
    if (fields.length > 0) {
      changes.push({
        kind: 'modified',
        itemType: (newItem.type as 'PBI') ?? 'Item',
        title: newItem.title,
        parentPath,
        fields,
        details: [],
      });
    }
  }
  return changes;
}

function diffFeatures(
  oldFeatures: Feature[],
  newFeatures: Feature[],
  parentPath: string,
): ItemChange[] {
  const { matched, added, removed } = matchByTitle(oldFeatures, newFeatures);
  const changes: ItemChange[] = [];

  for (const feat of added) {
    changes.push({
      kind: 'added',
      itemType: 'Feature',
      title: feat.title,
      parentPath,
      fields: [],
      details: extractDetails(feat as Record<string, unknown>),
    });
    for (const item of feat.items ?? []) {
      changes.push({
        kind: 'added',
        itemType: (item.type as 'PBI') ?? 'Item',
        title: item.title,
        parentPath: joinPath(parentPath, feat.title),
        fields: [],
        details: extractDetails(item as Record<string, unknown>),
      });
    }
  }
  for (const feat of removed) {
    changes.push({
      kind: 'removed',
      itemType: 'Feature',
      title: feat.title,
      parentPath,
      fields: [],
      details: extractDetails(feat as Record<string, unknown>),
    });
    for (const item of feat.items ?? []) {
      changes.push({
        kind: 'removed',
        itemType: (item.type as 'PBI') ?? 'Item',
        title: item.title,
        parentPath: joinPath(parentPath, feat.title),
        fields: [],
        details: extractDetails(item as Record<string, unknown>),
      });
    }
  }
  for (const [oldFeat, newFeat] of matched) {
    const fields = diffFields(oldFeat as Record<string, unknown>, newFeat as Record<string, unknown>);
    if (fields.length > 0) {
      changes.push({
        kind: 'modified',
        itemType: 'Feature',
        title: newFeat.title,
        parentPath,
        fields,
        details: [],
      });
    }
    const featurePath = joinPath(parentPath, newFeat.title);
    changes.push(...diffItems(oldFeat.items ?? [], newFeat.items ?? [], featurePath));
  }
  return changes;
}

function diffEpics(oldEpics: Epic[], newEpics: Epic[]): ItemChange[] {
  const { matched, added, removed } = matchByTitle(oldEpics, newEpics);
  const changes: ItemChange[] = [];

  for (const epic of added) {
    changes.push({
      kind: 'added',
      itemType: 'Epic',
      title: epic.title,
      fields: [],
      details: extractDetails(epic as Record<string, unknown>),
    });
    for (const feat of epic.features ?? []) {
      changes.push({
        kind: 'added',
        itemType: 'Feature',
        title: feat.title,
        parentPath: epic.title,
        fields: [],
        details: extractDetails(feat as Record<string, unknown>),
      });
      for (const item of feat.items ?? []) {
        changes.push({
          kind: 'added',
          itemType: (item.type as 'PBI') ?? 'Item',
          title: item.title,
          parentPath: joinPath(epic.title, feat.title),
          fields: [],
          details: extractDetails(item as Record<string, unknown>),
        });
      }
    }
  }
  for (const epic of removed) {
    changes.push({
      kind: 'removed',
      itemType: 'Epic',
      title: epic.title,
      fields: [],
      details: extractDetails(epic as Record<string, unknown>),
    });
    for (const feat of epic.features ?? []) {
      changes.push({
        kind: 'removed',
        itemType: 'Feature',
        title: feat.title,
        parentPath: epic.title,
        fields: [],
        details: extractDetails(feat as Record<string, unknown>),
      });
    }
  }
  for (const [oldEpic, newEpic] of matched) {
    const fields = diffFields(oldEpic as Record<string, unknown>, newEpic as Record<string, unknown>);
    if (fields.length > 0) {
      changes.push({
        kind: 'modified',
        itemType: 'Epic',
        title: newEpic.title,
        fields,
        details: [],
      });
    }
    changes.push(...diffFeatures(oldEpic.features ?? [], newEpic.features ?? [], newEpic.title));
  }
  return changes;
}

/* ── Entry point ─────────────────────────────────────────────────────────── */

export function computeBacklogDiff(
  oldJson: unknown,
  newJson: unknown,
): ItemChange[] {
  if (!isBacklogData(oldJson) || !isBacklogData(newJson)) return [];
  return diffEpics(oldJson.epics ?? [], newJson.epics ?? []);
}

export function countChanges(changes: ItemChange[]): { added: number; removed: number; modified: number } {
  let added = 0;
  let removed = 0;
  let modified = 0;
  for (const c of changes) {
    if (c.kind === 'added') added++;
    else if (c.kind === 'removed') removed++;
    else modified++;
  }
  return { added, removed, modified };
}
