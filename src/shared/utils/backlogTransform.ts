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

  if (result.epics) {
    result.epics = result.epics.map(epic => {
      const updated: BacklogNode = { ...epic };
      const match = epicMap.get(epic.title ?? '');
      if (match) {
        updated.adoWorkItemId = match.adoId;
        updated.adoWorkItemUrl = match.adoUrl;
      }

      if (updated.features) {
        updated.features = updated.features.map(feature => {
          const fUpdated: BacklogNode = { ...feature };
          const fMatch = featureMap.get(feature.title ?? '');
          if (fMatch) {
            fUpdated.adoWorkItemId = fMatch.adoId;
            fUpdated.adoWorkItemUrl = fMatch.adoUrl;
          }

          if (fUpdated.items) {
            fUpdated.items = fUpdated.items.map(pbi => {
              const pUpdated: BacklogNode = { ...pbi };
              const pMatch = pbiMap.get(pbi.title ?? '');
              if (pMatch) {
                pUpdated.adoWorkItemId = pMatch.adoId;
                pUpdated.adoWorkItemUrl = pMatch.adoUrl;
              }
              return pUpdated;
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
