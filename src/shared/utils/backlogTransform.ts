import type {
  CreatePrdAdoItemsRequest,
  CreatePrdAdoItemsResponse,
} from '../types/interview';

export interface FlattenedItem {
  type: 'Epic' | 'Feature' | 'Product Backlog Item';
  title: string;
  description?: string;
  parentTitle?: string;
  priority?: string;
  acceptanceCriteria?: Array<{ given?: string; when?: string; then?: string }>;
}

export function flattenSelectedItems(
  selectedItems: CreatePrdAdoItemsRequest['selectedItems'],
): FlattenedItem[] {
  const items: FlattenedItem[] = [];

  for (const epic of selectedItems.epics) {
    items.push({
      type: 'Epic',
      title: epic.title,
      description: epic.description,
      priority: epic.priority,
    });

    if (epic.features) {
      for (const feature of epic.features) {
        items.push({
          type: 'Feature',
          title: feature.title,
          description: feature.description,
          parentTitle: epic.title,
          priority: feature.priority,
        });

        if (feature.items) {
          for (const pbi of feature.items) {
            items.push({
              type: 'Product Backlog Item',
              title: pbi.title,
              description: pbi.description,
              parentTitle: feature.title,
              priority: pbi.priority,
              acceptanceCriteria: pbi.acceptanceCriteria,
            });
          }
        }
      }
    }
  }

  return items;
}

interface BacklogNode {
  title?: string;
  adoWorkItemId?: number;
  adoWorkItemUrl?: string;
  features?: BacklogNode[];
  items?: BacklogNode[];
  [key: string]: unknown;
}

interface BacklogJson {
  epics?: BacklogNode[];
  features?: BacklogNode[];
  [key: string]: unknown;
}

export function stampAdoIds(
  backlogJson: unknown,
  response: CreatePrdAdoItemsResponse,
): unknown {
  const source = backlogJson as BacklogJson;
  const result: BacklogJson = { ...source };

  const epicMap = new Map(response.created.epics.map(e => [e.title, e]));
  const featureMap = new Map(response.created.features.map(f => [f.title, f]));
  const pbiMap = new Map(response.created.pbis.map(p => [p.title, p]));
  const taskMap = new Map((response.created.tasks ?? []).map(t => [t.title, t]));

  // Build a unified title→adoId + backlog-id→adoId lookup for resolving dependsOn.
  // Seed with already-stamped items from prior ADO pushes so cross-batch deps resolve.
  const titleToAdoId = new Map<string, number>();
  const idToAdoId = new Map<string, number>();
  for (const epic of source.epics ?? []) {
    if (epic.title && epic.adoWorkItemId) titleToAdoId.set(epic.title, epic.adoWorkItemId);
    for (const feat of epic.features ?? []) {
      if (feat.title && feat.adoWorkItemId) titleToAdoId.set(feat.title, feat.adoWorkItemId);
      for (const item of feat.items ?? []) {
        if (item.title && item.adoWorkItemId) titleToAdoId.set(item.title, item.adoWorkItemId);
        const itemId = item.id as string | undefined;
        if (itemId && item.adoWorkItemId) idToAdoId.set(itemId, item.adoWorkItemId);
      }
    }
  }
  for (const list of [response.created.epics, response.created.features, response.created.pbis, response.created.tasks]) {
    for (const item of list ?? []) {
      titleToAdoId.set(item.title, item.adoId);
      if (item.id) idToAdoId.set(item.id, item.adoId);
    }
  }

  const resolveDepsToAdoIds = (deps: unknown): number[] | undefined => {
    if (!Array.isArray(deps) || deps.length === 0) return undefined;
    const resolved = (deps as string[]).flatMap(dep => {
      const byTitle = titleToAdoId.get(dep);
      if (byTitle != null) return [byTitle];
      const byId = idToAdoId.get(dep);
      return byId != null ? [byId] : [];
    });
    return resolved.length > 0 ? resolved : undefined;
  };

  if (result.epics) {
    result.epics = result.epics.map(epic => {
      const updated: BacklogNode = { ...epic };
      const match = epicMap.get(epic.title ?? '');
      if (match) {
        updated.adoWorkItemId = match.adoId;
        updated.adoWorkItemUrl = match.adoUrl;
      }
      const epicDepAdoIds = resolveDepsToAdoIds(epic.dependencies);
      if (epicDepAdoIds) updated.dependsOnAdoIds = epicDepAdoIds;

      if (updated.features) {
        updated.features = updated.features.map(feature => {
          const fUpdated: BacklogNode = { ...feature };
          const fMatch = featureMap.get(feature.title ?? '');
          if (fMatch) {
            fUpdated.adoWorkItemId = fMatch.adoId;
            fUpdated.adoWorkItemUrl = fMatch.adoUrl;
          }
          const featDepAdoIds = resolveDepsToAdoIds(feature.dependencies);
          if (featDepAdoIds) fUpdated.dependsOnAdoIds = featDepAdoIds;

          if (fUpdated.items) {
            fUpdated.items = fUpdated.items.map(item => {
              const iUpdated: BacklogNode = { ...item };
              const type = item.type as string | undefined;
              const iMatch = type === 'TBI'
                ? taskMap.get(item.title ?? '')
                : (pbiMap.get(item.title ?? '') ?? taskMap.get(item.title ?? ''));
              if (iMatch) {
                iUpdated.adoWorkItemId = iMatch.adoId;
                iUpdated.adoWorkItemUrl = iMatch.adoUrl;
              }
              const itemDepAdoIds = resolveDepsToAdoIds(item.dependsOn);
              if (itemDepAdoIds) iUpdated.dependsOnAdoIds = itemDepAdoIds;
              return iUpdated;
            });
          }

          return fUpdated;
        });
      }

      return updated;
    });
  }

  return result;
}

/**
 * Find the ADO Feature work item id for a given designDocId.
 * Returns undefined when the backlog has not yet been pushed to ADO or the
 * matching feature cannot be found.
 */
export function findFeatureAdoIdByDesignDocId(
  backlogJson: unknown,
  designDocId: string,
): number | undefined {
  const source = backlogJson as BacklogJson;
  if (!source) return undefined;

  const allFeatures: BacklogNode[] = [
    ...(source.features ?? []),
    ...(source.epics ?? []).flatMap((e) => e.features ?? []),
  ];

  const match = allFeatures.find(
    (f) => (f as Record<string, unknown>).designDocId === designDocId,
  );
  return match?.adoWorkItemId;
}

/**
 * Stamp a designDocId or designPrototypeId onto the feature at `featureIndex`
 * in the backlog JSON. Returns a new copy with the ID set.
 *
 * `featureIndex` is the global index produced by flattening
 * top-level `features[]` then each `epics[].features[]` in order.
 */
export function stampFeatureLinkId(
  backlogJson: unknown,
  featureIndex: number,
  field: 'designDocId' | 'designPrototypeId',
  value: string,
): unknown {
  const source = backlogJson as BacklogJson;
  if (!source) return source;
  const result: BacklogJson = { ...source };

  let idx = 0;

  // Top-level features (rare, but extractFeatures reads them first)
  if (result.features) {
    result.features = result.features.map(f => {
      if (idx === featureIndex) { idx++; return { ...f, [field]: value }; }
      idx++;
      return f;
    });
  }

  if (result.epics) {
    result.epics = result.epics.map(epic => {
      if (!epic.features) return epic;
      let changed = false;
      const updatedFeatures = epic.features.map(f => {
        if (idx === featureIndex) { idx++; changed = true; return { ...f, [field]: value }; }
        idx++;
        return f;
      });
      return changed ? { ...epic, features: updatedFeatures } : (idx += 0, epic);
    });
  }

  return result;
}
