import { eq } from 'drizzle-orm';
import type { HomeDashboardScope } from '../../shared/types/homeDashboard';
import { db } from '../db/drizzle';
import { appUsers } from '../db/schema';
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
  queryWorkItemIds(wiql: string): Promise<number[]>;
}

export interface BugToPbiRatio {
  bugCount: number;
  pbiCount: number;
  ratio: number | null;
  windowDays: 90;
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

export interface ProductionDefectRollupService {
  getRollup(input: {
    userId: string;
    project: string;
    scope: HomeDashboardScope;
    rowLimit?: number;
  }): Promise<DefectRollup>;
  getBugToPbiRatio(input: {
    userId: string;
    project: string;
    scope: HomeDashboardScope;
    now?: Date;
  }): Promise<BugToPbiRatio>;
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

  async getRollup(input: {
    project: string;
    rowLimit?: number;
    assignee?: string;
  }): Promise<DefectRollup> {
    if (!input.project) throw new Error('project is required');

    const wiql = [
      'SELECT [System.Id] FROM WorkItemLinks',
      `WHERE ([Source].[System.TeamProject] = '${escapeWiql(input.project)}')`,
      "AND ([Source].[System.WorkItemType] IN ('Product Backlog Item', 'User Story'))",
      "AND ([Target].[System.WorkItemType] = 'Bug')",
      "AND ([System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward')",
      ...(input.assignee
        ? [`AND ([Source].[System.AssignedTo] EVER '${escapeWiql(input.assignee)}')`]
        : []),
      'MODE (MustContain)',
    ].join(' ');
    const links = await this.dependencies.queryLinks(wiql);
    if (links.length === 0) return { projectOpenDefectCount: 0, pbiRows: [] };

    const ids = [...new Set(links.flatMap((link) => [link.sourceId, link.targetId]))];
    const items = await this.dependencies.getItems(ids, input.project);
    const byId = new Map(items.map((item) => [item.id, item]));
    const openBugIds = new Set<number>();
    const counts = new Map<number, number>();

    for (const link of links) {
      const source = byId.get(link.sourceId);
      const target = byId.get(link.targetId);
      if (!source || !target) continue;
      const sourceType = String(source.fields['System.WorkItemType'] ?? '').toLowerCase();
      const targetType = String(target.fields['System.WorkItemType'] ?? '').toLowerCase();
      if (!['product backlog item', 'user story'].includes(sourceType) || targetType !== 'bug') continue;

      const state = String(target.fields['System.State'] ?? '').trim().toLowerCase();
      if (!CLOSED_BUG_STATES.has(state)) {
        openBugIds.add(target.id);
        counts.set(source.id, (counts.get(source.id) ?? 0) + 1);
      }
    }

    const limit = Math.max(0, Math.min(input.rowLimit ?? 20, 20));
    // Rows come from `counts`, not from every PBI that has a bug link: a PBI
    // whose bugs are all closed has no open defect and would otherwise render
    // as a 0 row on a list titled "Open Bugs on PBIs".
    const pbiRows = [...counts.entries()]
      .map(([id, openDefectCount]): PbiDefectRow => {
        const fields = byId.get(id)?.fields ?? {};
        return {
          pbiId: id,
          title: String(fields['System.Title'] ?? ''),
          changedAt: fields['System.ChangedDate'] ? String(fields['System.ChangedDate']) : null,
          openDefectCount,
        };
      })
      .sort((a, b) => (a.changedAt ?? '').localeCompare(b.changedAt ?? '') || a.pbiId - b.pbiId)
      .slice(0, limit);

    return { projectOpenDefectCount: openBugIds.size, pbiRows };
  }

  /**
   * Bugs created in the trailing window that are children of PBIs, divided by
   * PBIs created in the same window. Mine limits both sides to PBIs the user
   * has owned at any revision.
   */
  async getBugToPbiRatio(input: {
    project: string;
    now?: Date;
    assignee?: string;
  }): Promise<BugToPbiRatio> {
    if (!input.project) throw new Error('project is required');

    const windowDays = 90 as const;
    const now = input.now ?? new Date();
    const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const assigneeClause = input.assignee
      ? `AND [System.AssignedTo] EVER '${escapeWiql(input.assignee)}'`
      : '';
    const sourceAssigneeClause = input.assignee
      ? `AND ([Source].[System.AssignedTo] EVER '${escapeWiql(input.assignee)}')`
      : '';

    const pbiWiql = [
      'SELECT [System.Id] FROM WorkItems',
      `WHERE [System.TeamProject] = '${escapeWiql(input.project)}'`,
      "AND [System.WorkItemType] IN ('Product Backlog Item', 'User Story')",
      `AND [System.CreatedDate] >= '${since}'`,
      assigneeClause,
    ].filter(Boolean).join(' ');

    const bugLinkWiql = [
      'SELECT [System.Id] FROM WorkItemLinks',
      `WHERE ([Source].[System.TeamProject] = '${escapeWiql(input.project)}')`,
      "AND ([Source].[System.WorkItemType] IN ('Product Backlog Item', 'User Story'))",
      "AND ([Target].[System.WorkItemType] = 'Bug')",
      `AND ([Target].[System.CreatedDate] >= '${since}')`,
      "AND ([System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward')",
      sourceAssigneeClause,
      'MODE (MustContain)',
    ].filter(Boolean).join(' ');

    const [pbiIds, bugLinks] = await Promise.all([
      this.dependencies.queryWorkItemIds(pbiWiql),
      this.dependencies.queryLinks(bugLinkWiql),
    ]);
    const pbiCount = new Set(pbiIds).size;
    const bugCount = new Set(bugLinks.map((link) => link.targetId)).size;
    return {
      bugCount,
      pbiCount,
      ratio: pbiCount === 0 ? null : Math.round((bugCount / pbiCount) * 10) / 10,
      windowDays,
    };
  }
}

/** Production ADO adapter for the project-scoped defect hierarchy rollup. */
export function createProductionDefectRollupService(): ProductionDefectRollupService {
  const clients = new Map<string, AzureDevOpsService>();
  const clientFor = (project: string): AzureDevOpsService => {
    let client = clients.get(project);
    if (!client) {
      client = new AzureDevOpsService(project);
      clients.set(project, client);
    }
    return client;
  };

  const service = new DefectRollupService({
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
    async queryWorkItemIds(wiql) {
      const projectMatch = wiql.match(/\[System\.TeamProject\]\s*=\s*'((?:''|[^'])+)'/i);
      if (!projectMatch) throw new Error('Defect WIQL is missing its project scope');
      const project = projectMatch[1].replace(/''/g, "'");
      const result = await clientFor(project).queryWorkItemsByWiql({
        wiql,
        fields: ['System.Id'],
        maxResults: 500,
      });
      return result.ids;
    },
  });

  async function resolveAssignee(userId: string): Promise<string> {
    const [user] = await db
      .select({ email: appUsers.email, displayName: appUsers.displayName })
      .from(appUsers)
      .where(eq(appUsers.oid, userId))
      .limit(1);
    const assignee = user?.email ?? user?.displayName;
    if (!assignee) throw new Error('Current user has no ADO identity');
    return assignee;
  }

  return {
    async getRollup(input: {
      userId: string;
      project: string;
      scope: HomeDashboardScope;
      rowLimit?: number;
    }) {
      if (input.scope === 'team') {
        return service.getRollup({ project: input.project, rowLimit: input.rowLimit });
      }
      return service.getRollup({
        project: input.project,
        rowLimit: input.rowLimit,
        assignee: await resolveAssignee(input.userId),
      });
    },
    async getBugToPbiRatio(input: {
      userId: string;
      project: string;
      scope: HomeDashboardScope;
      now?: Date;
    }) {
      if (input.scope === 'team') {
        return service.getBugToPbiRatio({ project: input.project, now: input.now });
      }
      return service.getBugToPbiRatio({
        project: input.project,
        now: input.now,
        assignee: await resolveAssignee(input.userId),
      });
    },
  };
}
