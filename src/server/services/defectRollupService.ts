import { AzureDevOpsService } from './azureDevOps';

export interface WorkItemLink {
  sourceId: number;
  targetId: number;
}

export interface DefectWorkItem {
  id: number;
  fields: Record<string, unknown>;
}

export interface DefectRollupDependencies {
  queryLinks(wiql: string): Promise<WorkItemLink[]>;
  getItems(ids: number[], project: string): Promise<DefectWorkItem[]>;
}

export interface PbiDefectRow {
  pbiId: number;
  title: string;
  changedAt: string | null;
  openDefectCount: number;
}

export interface DefectRollup {
  projectOpenDefectCount: number;
  pbiRows: PbiDefectRow[];
}

const CLOSED_BUG_STATES = new Set(['done', 'closed', 'resolved', 'removed']);

function escapeWiql(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Computes an exact project defect total from direct PBI -> Bug hierarchy
 * edges, then limits only the stale-first presentation rows.
 */
export class DefectRollupService {
  constructor(private readonly dependencies: DefectRollupDependencies) {}

  async getRollup(input: { project: string; rowLimit?: number }): Promise<DefectRollup> {
    if (!input.project) throw new Error('project is required');

    const wiql = [
      'SELECT [System.Id] FROM WorkItemLinks',
      `WHERE ([Source].[System.TeamProject] = '${escapeWiql(input.project)}')`,
      "AND ([Source].[System.WorkItemType] IN ('Product Backlog Item', 'User Story'))",
      "AND ([Target].[System.WorkItemType] = 'Bug')",
      "AND ([System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward')",
      'MODE (MustContain)',
    ].join(' ');
    const links = await this.dependencies.queryLinks(wiql);
    if (links.length === 0) return { projectOpenDefectCount: 0, pbiRows: [] };

    const ids = [...new Set(links.flatMap((link) => [link.sourceId, link.targetId]))];
    const items = await this.dependencies.getItems(ids, input.project);
    const byId = new Map(items.map((item) => [item.id, item]));
    const openBugIds = new Set<number>();
    const counts = new Map<number, number>();
    const pbiIds = new Set<number>();

    for (const link of links) {
      const source = byId.get(link.sourceId);
      const target = byId.get(link.targetId);
      if (!source || !target) continue;
      const sourceType = String(source.fields['System.WorkItemType'] ?? '').toLowerCase();
      const targetType = String(target.fields['System.WorkItemType'] ?? '').toLowerCase();
      if (!['product backlog item', 'user story'].includes(sourceType) || targetType !== 'bug') continue;

      pbiIds.add(source.id);
      const state = String(target.fields['System.State'] ?? '').trim().toLowerCase();
      if (!CLOSED_BUG_STATES.has(state)) {
        openBugIds.add(target.id);
        counts.set(source.id, (counts.get(source.id) ?? 0) + 1);
      }
    }

    const limit = Math.max(0, Math.min(input.rowLimit ?? 20, 20));
    const pbiRows = [...pbiIds]
      .map((id): PbiDefectRow => {
        const fields = byId.get(id)?.fields ?? {};
        return {
          pbiId: id,
          title: String(fields['System.Title'] ?? ''),
          changedAt: fields['System.ChangedDate'] ? String(fields['System.ChangedDate']) : null,
          openDefectCount: counts.get(id) ?? 0,
        };
      })
      .sort((a, b) => (a.changedAt ?? '').localeCompare(b.changedAt ?? '') || a.pbiId - b.pbiId)
      .slice(0, limit);

    return { projectOpenDefectCount: openBugIds.size, pbiRows };
  }
}

/** Production ADO adapter for the project-scoped defect hierarchy rollup. */
export function createProductionDefectRollupService(): DefectRollupService {
  const clients = new Map<string, AzureDevOpsService>();
  const clientFor = (project: string): AzureDevOpsService => {
    let client = clients.get(project);
    if (!client) {
      client = new AzureDevOpsService(project);
      clients.set(project, client);
    }
    return client;
  };

  return new DefectRollupService({
    async queryLinks(wiql) {
      const projectMatch = wiql.match(
        /\[Source\]\.\[System\.TeamProject\]\s*=\s*'((?:''|[^'])+)'/i,
      );
      if (!projectMatch) throw new Error('Defect WIQL is missing its project scope');
      const project = projectMatch[1].replace(/''/g, "'");
      return clientFor(project).queryWorkItemLinksByWiql(wiql);
    },
    async getItems(ids, project) {
      if (ids.length === 0) return [];
      const result = await clientFor(project).queryWorkItemsByWiql({
        wiql: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${escapeWiql(project)}' AND [System.Id] IN (${ids.join(',')})`,
        fields: [
          'System.Id',
          'System.WorkItemType',
          'System.Title',
          'System.State',
          'System.ChangedDate',
        ],
        maxResults: Math.min(ids.length, 500),
      });
      return result.items.map((item) => ({ id: item.id, fields: item.fields }));
    },
  });
}
