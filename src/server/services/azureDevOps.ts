import * as azdev from 'azure-devops-node-api';
import { WorkItemExpand } from 'azure-devops-node-api/interfaces/WorkItemTrackingInterfaces';
import { WorkItem, CycleTimeData, DueDateChange, DeveloperDueDateStats, DueDateHitRateStats, Release, ReleaseMetrics, InProgressTimeStats, QACycleTimeStats, UATCycleTimeStats, UATSittingItem, AIWorkItemMetric, AIWorkItemHealthSummary, DesignDocKickoffStats } from '../types/workitem';
import type { AiCodeWorkItemAdoptionSummary } from '../types/aiCapabilityLadder';
import { retryWithBackoff } from '../utils/retry';

export class AzureDevOpsService {
  private connection: azdev.WebApi;
  private organization: string;
  private project: string;
  private areaPath: string;
  private readonly WORK_ITEM_BATCH_SIZE = 200;

  constructor(project?: string, areaPath?: string) {
    const orgUrl = process.env.ADO_ORG;
    const pat = process.env.ADO_PAT;
    const defaultProject = process.env.ADO_PROJECT || '';
    const defaultAreaPath = process.env.ADO_AREA_PATH || '';
    
    // Use provided project/areaPath or fall back to env defaults
    this.project = project || defaultProject;
    this.areaPath = areaPath || defaultAreaPath;

    if (!orgUrl || !pat) {
      throw new Error(
        'Missing required environment variables: ADO_ORG and ADO_PAT must be provided'
      );
    }

    this.organization = orgUrl;
    const authHandler = azdev.getPersonalAccessTokenHandler(pat);
    // Configure with longer timeout for revision queries (default is 30s, increase to 120s)
    const options = {
      socketTimeout: 120000, // 120 seconds
    };
    this.connection = new azdev.WebApi(orgUrl, authHandler, options);
  }

  private async getWorkItemsInBatches(
    witApi: any,
    ids: number[],
    fields?: string[],
    expand?: WorkItemExpand,
  ): Promise<any[]> {
    const workItems: any[] = [];

    for (let i = 0; i < ids.length; i += this.WORK_ITEM_BATCH_SIZE) {
      const batch = ids.slice(i, i + this.WORK_ITEM_BATCH_SIZE);
      const batchItems = await witApi.getWorkItems(
        batch,
        fields,
        undefined,
        expand,
        undefined,
        this.project,
      );
      workItems.push(...batchItems);
    }

    return workItems;
  }

  /** Returns all ADO projects in the organization that the PAT has access to. */
  async getProjects(): Promise<{ id: string; name: string; description: string }[]> {
    const coreApi = await this.connection.getCoreApi();
    const projects = await coreApi.getProjects();
    return (projects || []).map((p) => ({
      id: p.id || '',
      name: p.name || '',
      description: p.description || '',
    }));
  }

  /** Returns all teams for a given ADO project. */
  async getProjectTeams(project: string): Promise<{ id: string; name: string }[]> {
    if (!project) throw new Error('project is required');
    const coreApi = await this.connection.getCoreApi();
    const teams = await coreApi.getTeams(project);
    return (teams || []).map((t) => ({
      id: t.id || '',
      name: t.name || '',
    }));
  }

  /** Returns all area paths for a given ADO project as flat sorted strings. */
  async getAreaPaths(project: string): Promise<string[]> {
    if (!project) throw new Error('project is required');
    const orgUrl = this.organization.replace(/\/$/, '');
    const pat = process.env.ADO_PAT || '';
    const token = Buffer.from(`:${pat}`).toString('base64');
    const url = `${orgUrl}/${encodeURIComponent(project)}/_apis/wit/classificationnodes/areas?$depth=10&api-version=7.1`;

    const res = await fetch(url, {
      headers: { Authorization: `Basic ${token}`, 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(`ADO area paths returned ${res.status}`);
    const data = await res.json() as { name?: string; children?: unknown[] };

    const results: string[] = [];

    function flattenNode(node: { name?: string; children?: unknown[] }, parentPath: string): void {
      if (!node?.name) return;
      const currentPath = parentPath ? `${parentPath}\\${node.name}` : node.name;
      results.push(currentPath);
      if (Array.isArray(node.children)) {
        node.children.forEach(child => flattenNode(child as { name?: string; children?: unknown[] }, currentPath));
      }
    }

    flattenNode(data, '');
    return results.sort((a, b) => a.localeCompare(b));
  }

  /**
   * Run an arbitrary WIQL query and return hydrated work item details.
   * Useful for MCP callers that need ad-hoc filtering and field selection.
   */
  async queryWorkItemsByWiql(params: {
    wiql: string;
    fields?: string[];
    maxResults?: number;
    includeRelations?: boolean;
  }): Promise<{
    totalMatched: number;
    returned: number;
    ids: number[];
    items: Array<{
      id: number;
      rev?: number;
      url?: string;
      fields: Record<string, any>;
      relations?: Array<{ rel?: string; url?: string; attributes?: Record<string, any> }>;
    }>;
  }> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();
      const queryResult = await witApi.queryByWiql(
        { query: params.wiql },
        { project: this.project },
      );

      const idSet = new Set<number>();
      for (const wi of queryResult.workItems ?? []) {
        if (typeof wi.id === 'number') idSet.add(wi.id);
      }
      for (const rel of queryResult.workItemRelations ?? []) {
        if (typeof rel.target?.id === 'number') idSet.add(rel.target.id);
        if (typeof rel.source?.id === 'number') idSet.add(rel.source.id);
      }

      const allIds = Array.from(idSet);
      if (allIds.length === 0) {
        return {
          totalMatched: 0,
          returned: 0,
          ids: [],
          items: [],
        };
      }

      const boundedMax = Math.max(1, Math.min(params.maxResults ?? 200, 500));
      const ids = allIds.slice(0, boundedMax);
      const expand = params.includeRelations ? WorkItemExpand.Relations : undefined;
      const fields = params.fields && params.fields.length > 0 ? params.fields : undefined;
      const workItems = await this.getWorkItemsInBatches(witApi, ids, fields, expand);

      return {
        totalMatched: allIds.length,
        returned: workItems.length,
        ids,
        items: workItems
          .filter((wi) => typeof wi.id === 'number')
          .map((wi) => ({
            id: wi.id!,
            rev: wi.rev,
            url: wi.url,
            fields: (wi.fields ?? {}) as Record<string, any>,
            relations: wi.relations?.map((rel: any) => ({
              rel: rel.rel,
              url: rel.url,
              attributes: rel.attributes as Record<string, any> | undefined,
            })),
          })),
      };
    });
  }

  /**
   * Return revision history for a work item so callers can inspect field changes over time.
   */
  async getWorkItemRevisionHistory(workItemId: number, limit = 100): Promise<Array<{
    rev: number;
    changedDate?: string;
    changedBy?: string;
    state?: string;
    title?: string;
    history?: string;
    fields: Record<string, any>;
  }>> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();
      const revisions = await witApi.getRevisions(workItemId, undefined, undefined, undefined, this.project);
      if (!revisions || revisions.length === 0) return [];

      const boundedLimit = Math.max(1, Math.min(limit, 500));
      return revisions
        .slice(-boundedLimit)
        .map((revision) => ({
          rev: revision.rev ?? 0,
          changedDate: revision.fields?.['System.ChangedDate'],
          changedBy: revision.fields?.['System.ChangedBy']?.displayName
            || revision.fields?.['System.ChangedBy']?.uniqueName
            || revision.fields?.['System.ChangedBy'],
          state: revision.fields?.['System.State'],
          title: revision.fields?.['System.Title'],
          history: revision.fields?.['System.History'],
          fields: (revision.fields ?? {}) as Record<string, any>,
        }));
    });
  }

  async getWorkItems(from?: string, to?: string): Promise<WorkItem[]> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();

      // Build WIQL query to include Product Backlog Items, Technical Backlog Items, Epics, Features, and Bugs
      let wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${this.project}' AND ([System.WorkItemType] = 'Product Backlog Item' OR [System.WorkItemType] = 'Technical Backlog Item' OR [System.WorkItemType] = 'Epic' OR [System.WorkItemType] = 'Feature' OR [System.WorkItemType] = 'Bug')`;

      if (this.areaPath) {
        // Use exact match (=) instead of UNDER to avoid getting child area paths
        wiql += ` AND [System.AreaPath] = '${this.areaPath}'`;
      }

      // Query for items in date range OR with no due date/target date
      if (from && to) {
        wiql += ` AND (([Microsoft.VSTS.Scheduling.DueDate] >= '${from}' AND [Microsoft.VSTS.Scheduling.DueDate] <= '${to}') OR ([Microsoft.VSTS.Scheduling.TargetDate] >= '${from}' AND [Microsoft.VSTS.Scheduling.TargetDate] <= '${to}') OR [Microsoft.VSTS.Scheduling.DueDate] = '' OR [Microsoft.VSTS.Scheduling.TargetDate] = '')`;
      }

      wiql += ' ORDER BY [System.ChangedDate] DESC';

      const queryResult = await witApi.queryByWiql(
        { query: wiql },
        { project: this.project }
      );

      if (!queryResult.workItems || queryResult.workItems.length === 0) {
        return [];
      }

      const ids = queryResult.workItems.map((wi) => wi.id!);

      // Fetch work items in batches of 200 (ADO limit)
      const batchSize = 200;
      const batches: number[][] = [];
      for (let i = 0; i < ids.length; i += batchSize) {
        batches.push(ids.slice(i, i + batchSize));
      }

      const fields = [
        'System.Id',
        'System.Title',
        'System.State',
        'System.AssignedTo',
        'System.WorkItemType',
        'System.ChangedDate',
        'System.CreatedDate',
        'Microsoft.VSTS.Common.ClosedDate',
        'System.AreaPath',
        'System.IterationPath',
        'Microsoft.VSTS.Scheduling.DueDate',
        'Microsoft.VSTS.Scheduling.TargetDate',
        'Custom.QACompleteDate',
        'System.Tags',
        'System.Description',
        'Microsoft.VSTS.Common.AcceptanceCriteria',
        'Microsoft.VSTS.TCM.ReproSteps',
        'Custom.Design',
        'System.History',
      ];

      const allWorkItems: WorkItem[] = [];

      for (const batch of batches) {
        const workItems = await witApi.getWorkItems(
          batch,
          fields,
          undefined,
          undefined,
          undefined
        );

        for (const wi of workItems) {
          if (!wi.id || !wi.fields) continue;

          // Helper function to extract date as YYYY-MM-DD without timezone issues
          const extractDate = (dateValue: any): string | undefined => {
            if (!dateValue) return undefined;
            const date = new Date(dateValue);
            
            // Use LOCAL date methods because ADO stores dates at midnight UTC
            // which appears as the previous day in timezones behind UTC (EST/CST)
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const result = `${year}-${month}-${day}`;
            
            return result;
          };

          // Debug logging for item 38656
          if (wi.id === 38656) {
            console.log('Item 38656 tags field:', wi.fields['System.Tags']);
            console.log('Item 38656 all fields:', Object.keys(wi.fields));
          }
          
          allWorkItems.push({
            id: wi.id,
            title: wi.fields['System.Title'] || '',
            state: wi.fields['System.State'] || '',
            assignedTo: wi.fields['System.AssignedTo']?.displayName,
            dueDate: extractDate(wi.fields['Microsoft.VSTS.Scheduling.DueDate']),
            targetDate: extractDate(wi.fields['Microsoft.VSTS.Scheduling.TargetDate']),
            qaCompleteDate: extractDate(wi.fields['Custom.QACompleteDate']),
            workItemType: wi.fields['System.WorkItemType'] || '',
            changedDate: wi.fields['System.ChangedDate'] || '',
            createdDate: wi.fields['System.CreatedDate'] || '',
            closedDate: extractDate(wi.fields['Microsoft.VSTS.Common.ClosedDate']),
            areaPath: wi.fields['System.AreaPath'] || '',
            iterationPath: wi.fields['System.IterationPath'] || '',
            tags: wi.fields['System.Tags'] || '',
            description: wi.fields['System.Description'] || '',
            acceptanceCriteria: wi.fields['Microsoft.VSTS.Common.AcceptanceCriteria'] || '',
            reproSteps: wi.fields['Microsoft.VSTS.TCM.ReproSteps'] || '',
            design: wi.fields['Custom.Design'] || '',
            discussions: wi.fields['System.History'] || '',
          });
        }
      }

      // Now fetch parent relationships in a separate call
      // Batch the IDs again for relations
      const relationBatches: number[][] = [];
      for (let i = 0; i < ids.length; i += batchSize) {
        relationBatches.push(ids.slice(i, i + batchSize));
      }

      const parentMap = new Map<number, number>();
      
      for (const batch of relationBatches) {
        try {
          // Fetch with Relations expand but no fields to avoid the conflict
          const workItemsWithRelations = await witApi.getWorkItems(
            batch,
            undefined,
            undefined,
            WorkItemExpand.Relations
          );

          for (const wi of workItemsWithRelations) {
            if (!wi.id || !wi.relations) continue;

            // Find parent relation
            const parentRelation = wi.relations.find(
              (rel) => rel.rel === 'System.LinkTypes.Hierarchy-Reverse'
            );
            
            if (parentRelation && parentRelation.url) {
              const match = parentRelation.url.match(/\/(\d+)$/);
              if (match) {
                parentMap.set(wi.id, parseInt(match[1], 10));
              }
            }
          }
        } catch (error) {
          console.error('Error fetching relations for batch:', error);
          // Continue even if relations fetch fails
        }
      }

      // Apply parent IDs to work items
      allWorkItems.forEach(item => {
        const parentId = parentMap.get(item.id);
        if (parentId) {
          item.parentId = parentId;
        }
      });

      // Skip cycle time calculation for now to improve load performance
      // Cycle time queries are timing out due to large revision history
      // TODO: Implement background job or on-demand cycle time calculation
      console.log(`Returning ${allWorkItems.length} work items (without cycle time data)`);
      
      return allWorkItems;
    });
  }

  async calculateCycleTime(workItemId: number): Promise<CycleTimeData | undefined> {
    try {
      const witApi = await this.connection.getWorkItemTrackingApi();
      
      // Get all revisions to track state changes
      const revisions = await witApi.getRevisions(workItemId, undefined, undefined, undefined, this.project);
      
      if (!revisions || revisions.length === 0) {
        return undefined;
      }

      let inProgressDate: string | undefined;
      let qaReadyDate: string | undefined;
      let uatReadyDate: string | undefined;
      let assignedToAtInProgress: string | undefined;
      let assignedToAtReadyForTest: string | undefined;

      // Iterate through revisions to find state transitions
      for (let i = 0; i < revisions.length; i++) {
        const revision = revisions[i];
        const state = revision.fields?.['System.State'];
        const changedDate = revision.fields?.['System.ChangedDate'];
        const assignedTo = revision.fields?.['System.AssignedTo'];

        // Track when item moved to "In Progress"
        if (!inProgressDate && state === 'In Progress' && changedDate) {
          inProgressDate = new Date(changedDate).toISOString();
          // Track who was assigned at this point
          assignedToAtInProgress = assignedTo?.displayName || assignedTo?.uniqueName || assignedTo;
        }

        // Track when item moved to "Ready For Test"
        if (!qaReadyDate && state === 'Ready For Test' && changedDate) {
          qaReadyDate = new Date(changedDate).toISOString();
          // Track who was assigned at this point (QA tester)
          assignedToAtReadyForTest = assignedTo?.displayName || assignedTo?.uniqueName || assignedTo;
        }

        // Track when item moved to "UAT - Ready For Test"
        if (!uatReadyDate && state === 'UAT - Ready For Test' && changedDate) {
          uatReadyDate = new Date(changedDate).toISOString();
        }
      }

      // Calculate developer cycle time in days if we have both dates
      let cycleTimeDays: number | undefined;
      if (inProgressDate && qaReadyDate) {
        const start = new Date(inProgressDate);
        const end = new Date(qaReadyDate);
        cycleTimeDays = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
      }

      // Calculate QA cycle time in days
      let qaCycleTimeDays: number | undefined;
      if (qaReadyDate && uatReadyDate) {
        const start = new Date(qaReadyDate);
        const end = new Date(uatReadyDate);
        qaCycleTimeDays = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
      }

      return {
        inProgressDate: inProgressDate ? inProgressDate.split('T')[0] : undefined,
        qaReadyDate: qaReadyDate ? qaReadyDate.split('T')[0] : undefined,
        cycleTimeDays,
        assignedTo: assignedToAtInProgress,
        uatReadyDate: uatReadyDate ? uatReadyDate.split('T')[0] : undefined,
        qaCycleTimeDays,
        qaAssignedTo: assignedToAtReadyForTest,
      };
    } catch (error) {
      console.error(`Error calculating cycle time for work item ${workItemId}:`, error);
      return undefined;
    }
  }

  async updateDueDate(id: number, dueDate: string | null, reason?: string): Promise<void> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();

      const patchDocument: any[] = [];

      if (dueDate === null) {
        // Remove the due date field
        patchDocument.push({
          op: 'remove',
          path: '/fields/Microsoft.VSTS.Scheduling.DueDate',
        });
      } else {
        // Create a Date object at midnight in local timezone, then convert to UTC
        // This ensures ADO stores a time that, when read back with local methods, gives the correct date
        const [year, month, day] = dueDate.split('-').map(Number);
        const localDate = new Date(year, month - 1, day, 0, 0, 0);
        const dateValue = localDate.toISOString();
        
        // Add or replace the due date field
        patchDocument.push({
          op: 'add',
          path: '/fields/Microsoft.VSTS.Scheduling.DueDate',
          value: dateValue,
        });
      }

      // If a reason is provided, add to history
      if (reason) {
        // Add to history (this field always exists)
        patchDocument.push({
          op: 'add',
          path: '/fields/System.History',
          value: `Due date change reason: ${reason}`,
        });
      }

      await witApi.updateWorkItem({}, patchDocument, id, this.project);
    });
  }

  async updateWorkItemField(id: number, field: string, value: any): Promise<void> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();

      // Map friendly field names to Azure DevOps field names
      const fieldMap: Record<string, string> = {
        state: 'System.State',
        assignedTo: 'System.AssignedTo',
        iterationPath: 'System.IterationPath',
        areaPath: 'System.AreaPath',
        title: 'System.Title',
        qaCompleteDate: 'Custom.QACompleteDate',
        targetDate: 'Microsoft.VSTS.Scheduling.TargetDate',
      };

      const adoFieldName = fieldMap[field] || field;
      
      const patchDocument: any[] = [];

      if (value === null || value === undefined || value === '') {
        // Remove the field
        patchDocument.push({
          op: 'remove',
          path: `/fields/${adoFieldName}`,
        });
      } else {
        // Check if this is a date field that needs special handling
        const dateFields = ['Custom.QACompleteDate', 'Microsoft.VSTS.Scheduling.DueDate', 'Microsoft.VSTS.Scheduling.TargetDate'];
        let fieldValue = value;
        
        if (dateFields.includes(adoFieldName) && typeof value === 'string' && value.match(/^\d{4}-\d{2}-\d{2}$/)) {
          // Convert YYYY-MM-DD to ISO string at midnight local time
          const [year, month, day] = value.split('-').map(Number);
          const localDate = new Date(year, month - 1, day, 0, 0, 0);
          fieldValue = localDate.toISOString();
        }
        
        // Add or replace the field
        patchDocument.push({
          op: 'add',
          path: `/fields/${adoFieldName}`,
          value: fieldValue,
        });
      }

      console.log(`Updating work item ${id} field ${adoFieldName} to:`, value);
      await witApi.updateWorkItem({}, patchDocument, id, this.project);
    });
  }

  /**
   * Append a tag to an ADO work item's System.Tags field (semicolon-separated).
   * No-ops if the tag is already present. Case-insensitive duplicate check.
   */
  async addTagToWorkItem(id: number, tag: string): Promise<void> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();
      const workItem = await witApi.getWorkItem(id, ['System.Tags'], undefined, undefined, this.project);
      const existing: string = workItem.fields?.['System.Tags'] ?? '';
      const currentTags = existing.split(';').map(t => t.trim()).filter(Boolean);
      if (currentTags.some(t => t.toLowerCase() === tag.toLowerCase())) return;
      const newTags = [...currentTags, tag].join('; ');
      await witApi.updateWorkItem({}, [{ op: 'add', path: '/fields/System.Tags', value: newTags }], id, this.project);
    });
  }

  async healthCheck(): Promise<boolean> {
    try {
      const coreApi = await this.connection.getCoreApi();
      await coreApi.getProject(this.project);
      return true;
    } catch (error) {
      console.error('Health check failed:', error);
      return false;
    }
  }

  async calculateCycleTimeForItems(workItemIds: number[]): Promise<Record<number, CycleTimeData>> {
    const result: Record<number, CycleTimeData> = {};
    const batchSize = 3; // Process fewer items at a time to avoid timeouts
    
    for (let i = 0; i < workItemIds.length; i += batchSize) {
      const batch = workItemIds.slice(i, i + batchSize);
      console.log(`Processing cycle time batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(workItemIds.length / batchSize)}`);
      
      const batchResults = await Promise.all(
        batch.map(async (id) => {
          const cycleTime = await this.calculateCycleTime(id);
          return { id, cycleTime };
        })
      );
      
      batchResults.forEach(({ id, cycleTime }) => {
        if (cycleTime) {
          result[id] = cycleTime;
        }
      });
    }
    
    return result;
  }

  async getDueDateChangeHistory(workItemIds: number[]): Promise<DueDateChange[]> {
    try {
      const witApi = await this.connection.getWorkItemTrackingApi();
      const allChanges: DueDateChange[] = [];

      // Process items in batches to avoid overwhelming the API
      const batchSize = 5;
      for (let i = 0; i < workItemIds.length; i += batchSize) {
        const batch = workItemIds.slice(i, i + batchSize);
        console.log(`Processing due date history batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(workItemIds.length / batchSize)}`);
        
        for (const workItemId of batch) {
          try {
            // Get all revisions for this work item
            const revisions = await witApi.getRevisions(workItemId);
            
            if (!revisions || revisions.length === 0) continue;
            
            let previousDueDate: string | undefined = undefined;
            
            for (const revision of revisions) {
              const fields = revision.fields;
              if (!fields) continue;
              
              const currentDueDate = fields['Microsoft.VSTS.Scheduling.DueDate'];
              const changedBy = fields['System.ChangedBy']?.displayName || fields['System.ChangedBy'] || 'Unknown';
              // System.AssignedTo can be an identity object {displayName, uniqueName} or a plain string
              const assignedToRaw = fields['System.AssignedTo'];
              const assignedTo: string =
                (assignedToRaw && typeof assignedToRaw === 'object' && assignedToRaw.displayName)
                  ? assignedToRaw.displayName
                  : (typeof assignedToRaw === 'string' && assignedToRaw)
                    ? assignedToRaw
                    : 'Unassigned';
              const changedDate = fields['System.ChangedDate'];
              
              // Try multiple possible field names for the reason
              let reason = fields['Custom.DueDateMovementReasons'] 
                || fields['Custom.DueDateMovementReason']
                || fields['Custom.DueDateReason']
                || undefined;
              
              // If no custom field, try to extract from history
              if (!reason && fields['System.History']) {
                const historyText = fields['System.History'];
                const match = historyText.match(/Due date change reason:\s*(.+?)(?:<|$)/i);
                if (match) {
                  reason = match[1].trim();
                }
              }
              
              // Normalize dates to YYYY-MM-DD format
              const normalizeDate = (dateValue: any): string | undefined => {
                if (!dateValue) return undefined;
                try {
                  const date = new Date(dateValue);
                  return date.toISOString().split('T')[0];
                } catch {
                  return undefined;
                }
              };
              
              const normalizedCurrent = normalizeDate(currentDueDate);
              const normalizedPrevious = normalizeDate(previousDueDate);
              
              // Check if due date changed in this revision, including initial assignment.
              // Record when a due date is set or changed (but not when it is removed).
              if (normalizedCurrent !== normalizedPrevious && normalizedCurrent !== undefined && changedDate) {
                // DEBUG: Log all available fields when a due date change is detected
                console.log(`\n=== Due Date Change Detected for Work Item ${workItemId} ===`);
                console.log(`Old: ${normalizedPrevious} -> New: ${normalizedCurrent}`);
                console.log(`Changed by: ${changedBy}, Assigned to: ${assignedTo} (raw: ${JSON.stringify(assignedToRaw)})`);
                console.log(`Changed date: ${changedDate}`);
                console.log(`Reason found:`, reason);
                console.log(`History field:`, fields['System.History']?.substring(0, 200));
                console.log(`Available custom fields:`, Object.keys(fields).filter(k => k.startsWith('Custom')));
                
                allChanges.push({
                  changedDate: new Date(changedDate).toISOString(),
                  changedBy,
                  assignedTo,
                  oldDueDate: normalizedPrevious,
                  newDueDate: normalizedCurrent,
                  reason: reason || 'No reason provided'
                });
              }
              
              previousDueDate = currentDueDate;
            }
          } catch (error) {
            console.error(`Error getting revisions for work item ${workItemId}:`, error);
            // Continue processing other work items
          }
        }
      }

      return allChanges;
    } catch (error) {
      console.error('Error in getDueDateChangeHistory:', error);
      return []; // Return empty array instead of throwing
    }
  }

  async getDueDateStatsByDeveloper(from?: string, to?: string, developerFilter?: string): Promise<DeveloperDueDateStats[]> {
    try {
      console.log('Fetching work items for due date stats...', {
        project: this.project,
        areaPath: this.areaPath,
        from,
        to,
        developerFilter
      });
      
      const witApi = await this.connection.getWorkItemTrackingApi();
      
      // Include all schedulable work item types that can have a due date.
      // NOTE: Do NOT add date filters to WIQL – ADO WIQL date literals are unreliable.
      // Date filtering is applied in JS after fetching revision history.
      let wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${this.project}'`;
      wiql += ` AND [System.WorkItemType] IN ('Product Backlog Item', 'Technical Backlog Item', 'Bug', 'Task', 'Feature', 'User Story')`;

      if (this.areaPath) {
        wiql += ` AND [System.AreaPath] UNDER '${this.areaPath}'`;
      }

      // When a specific developer is selected, scope WIQL to items currently assigned to
      // them so we avoid the need for any hard item cap.
      if (developerFilter) {
        const escaped = developerFilter.replace(/'/g, "''");
        wiql += ` AND [System.AssignedTo] = '${escaped}'`;
      }

      wiql += ' ORDER BY [System.ChangedDate] DESC';
      
      console.log('Executing WIQL:', wiql);
      
      const queryResult = await witApi.queryByWiql(
        { query: wiql },
        { project: this.project }
      );

      if (!queryResult.workItems || queryResult.workItems.length === 0) {
        console.log('No work items found matching criteria');
        return [];
      }

      const ids = queryResult.workItems.map((wi) => wi.id!);
      console.log(`Found ${ids.length} work items`);
      
      // For "all developers" cap at 400 most-recently-changed items to stay performant.
      // For a specific developer there's no cap – their item set is already narrow.
      const limitedIds = developerFilter ? ids : ids.slice(0, 400);
      if (!developerFilter && ids.length > 400) {
        console.log(`All-developers query: limiting to 400 of ${ids.length} work items`);
      }
      
      console.log(`Processing ${limitedIds.length} work items for due date change history...`);
      const changes = await this.getDueDateChangeHistory(limitedIds);
      console.log(`Found ${changes.length} due date changes total`);

      // Filter by date range using JS Date comparison (reliable, no WIQL date quirks)
      const fromMs = from ? new Date(from).getTime() : 0;
      const toMs   = to   ? new Date(`${to}T23:59:59.999Z`).getTime() : Infinity;
      const dateFilteredChanges = changes.filter(change => {
        const t = new Date(change.changedDate).getTime();
        return t >= fromMs && t <= toMs;
      });
      console.log(`After date filter (${from ?? 'all'} – ${to ?? 'all'}): ${dateFilteredChanges.length} changes`);

      // Filter by assigned owner – when WIQL already scoped by assignee, changes from
      // revisions where the item was assigned to someone else are excluded here too.
      const devFilteredChanges = developerFilter
        ? dateFilteredChanges.filter(change => change.assignedTo === developerFilter)
        : dateFilteredChanges;

      // Exclude initialization entries — changes whose reason indicates the due date
      // was being set for the first time rather than genuinely moved.
      const filteredChanges = devFilteredChanges.filter(
        change => !/^initializ/i.test(change.reason || '')
      );
      
      console.log(`After developer filter: ${filteredChanges.length} changes`);
      
      // Aggregate by assigned owner
      const statsByDev = new Map<string, { totalChanges: number, reasonBreakdown: Map<string, number> }>();
      
      for (const change of filteredChanges) {
        const developer = change.assignedTo;
        
        if (!statsByDev.has(developer)) {
          statsByDev.set(developer, {
            totalChanges: 0,
            reasonBreakdown: new Map()
          });
        }
        
        const devStats = statsByDev.get(developer)!;
        devStats.totalChanges++;
        
        const reason = change.reason || 'No reason provided';
        devStats.reasonBreakdown.set(reason, (devStats.reasonBreakdown.get(reason) || 0) + 1);
      }
      
      // Convert to array format
      const result = Array.from(statsByDev.entries()).map(([developer, stats]) => ({
        developer,
        totalChanges: stats.totalChanges,
        reasonBreakdown: Object.fromEntries(stats.reasonBreakdown)
      })).sort((a, b) => b.totalChanges - a.totalChanges);
      
      console.log(`Returning stats for ${result.length} developers`);
      return result;
    } catch (error) {
      console.error('Error in getDueDateStatsByDeveloper:', error);
      return []; // Return empty array instead of throwing
    }
  }

  async getEpicChildren(epicId: number): Promise<WorkItem[]> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();

      // Query for all work items that are descendants of this Epic (recursive query to get Features AND their PBIs)
      const wiql = `SELECT [System.Id] FROM WorkItemLinks WHERE ([Source].[System.Id] = ${epicId}) AND ([System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward') MODE (Recursive)`;

      const queryResult = await witApi.queryByWiql(
        { query: wiql },
        { project: this.project }
      );

      if (!queryResult.workItemRelations || queryResult.workItemRelations.length === 0) {
        return [];
      }

      // Extract all descendant IDs (skip the first relation which is the Epic itself)
      const descendantIds = queryResult.workItemRelations
        .slice(1) // Skip the source Epic
        .map(rel => rel.target?.id)
        .filter((id): id is number => id !== undefined);

      if (descendantIds.length === 0) {
        return [];
      }

      // Fetch work items in batches of 200 (ADO limit)
      const batchSize = 200;
      const batches: number[][] = [];
      for (let i = 0; i < descendantIds.length; i += batchSize) {
        batches.push(descendantIds.slice(i, i + batchSize));
      }

      const fields = [
        'System.Id',
        'System.Title',
        'System.State',
        'System.AssignedTo',
        'System.WorkItemType',
        'System.ChangedDate',
        'System.CreatedDate',
        'Microsoft.VSTS.Common.ClosedDate',
        'System.AreaPath',
        'System.IterationPath',
        'Microsoft.VSTS.Scheduling.DueDate',
        'Microsoft.VSTS.Scheduling.TargetDate',
        'System.Tags',
        'System.Description',
        'Microsoft.VSTS.Common.AcceptanceCriteria',
        'Microsoft.VSTS.TCM.ReproSteps',
        'Custom.Design',
        'System.History',
      ];

      const allWorkItems: WorkItem[] = [];

      for (const batch of batches) {
        const workItems = await witApi.getWorkItems(
          batch,
          fields,
          undefined,
          undefined,
          undefined
        );

        for (const wi of workItems) {
          if (!wi.id || !wi.fields) continue;

          const extractDate = (dateValue: any): string | undefined => {
            if (!dateValue) return undefined;
            const date = new Date(dateValue);
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
          };

          allWorkItems.push({
            id: wi.id,
            title: wi.fields['System.Title'] || '',
            state: wi.fields['System.State'] || '',
            assignedTo: wi.fields['System.AssignedTo']?.displayName,
            dueDate: extractDate(wi.fields['Microsoft.VSTS.Scheduling.DueDate']),
            targetDate: extractDate(wi.fields['Microsoft.VSTS.Scheduling.TargetDate']),
            workItemType: wi.fields['System.WorkItemType'] || '',
            changedDate: wi.fields['System.ChangedDate'] || '',
            createdDate: wi.fields['System.CreatedDate'] || '',
            closedDate: extractDate(wi.fields['Microsoft.VSTS.Common.ClosedDate']),
            areaPath: wi.fields['System.AreaPath'] || '',
            iterationPath: wi.fields['System.IterationPath'] || '',
            tags: wi.fields['System.Tags'] || '',
            description: wi.fields['System.Description'] || '',
            acceptanceCriteria: wi.fields['Microsoft.VSTS.Common.AcceptanceCriteria'] || '',
            reproSteps: wi.fields['Microsoft.VSTS.TCM.ReproSteps'] || '',
            design: wi.fields['Custom.Design'] || '',
            discussions: wi.fields['System.History'] || '',
          });
        }
      }

      // For Epic children, return Features (direct children for rollup calculation)
      const featureItems = allWorkItems.filter(item => 
        item.workItemType === 'Feature'
      );

      return featureItems;
    });
  }

  async getFeatureChildren(featureId: number): Promise<WorkItem[]> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();

      // Query for all work items that are descendants of this Feature (recursive query to get PBIs/TBIs)
      const wiql = `SELECT [System.Id] FROM WorkItemLinks WHERE ([Source].[System.Id] = ${featureId}) AND ([System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward') MODE (Recursive)`;

      const queryResult = await witApi.queryByWiql(
        { query: wiql },
        { project: this.project }
      );

      if (!queryResult.workItemRelations || queryResult.workItemRelations.length === 0) {
        return [];
      }

      // Extract all descendant IDs (skip the first relation which is the Feature itself)
      const descendantIds = queryResult.workItemRelations
        .slice(1) // Skip the source Feature
        .map(rel => rel.target?.id)
        .filter((id): id is number => id !== undefined);

      if (descendantIds.length === 0) {
        return [];
      }

      // Fetch work items in batches of 200 (ADO limit)
      const batchSize = 200;
      const batches: number[][] = [];
      for (let i = 0; i < descendantIds.length; i += batchSize) {
        batches.push(descendantIds.slice(i, i + batchSize));
      }

      const fields = [
        'System.Id',
        'System.Title',
        'System.State',
        'System.AssignedTo',
        'System.WorkItemType',
        'System.ChangedDate',
        'System.CreatedDate',
        'Microsoft.VSTS.Common.ClosedDate',
        'System.AreaPath',
        'System.IterationPath',
        'Microsoft.VSTS.Scheduling.DueDate',
        'Custom.QACompleteDate',
        'System.Tags',
        'System.Description',
        'Microsoft.VSTS.Common.AcceptanceCriteria',
        'Microsoft.VSTS.TCM.ReproSteps',
        'Custom.Design',
        'System.History',
      ];

      const allWorkItems: WorkItem[] = [];

      for (const batch of batches) {
        const workItems = await witApi.getWorkItems(
          batch,
          fields,
          undefined,
          undefined,
          undefined
        );

        for (const wi of workItems) {
          if (!wi.id || !wi.fields) continue;

          const extractDate = (dateValue: any): string | undefined => {
            if (!dateValue) return undefined;
            const date = new Date(dateValue);
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
          };

          allWorkItems.push({
            id: wi.id,
            title: wi.fields['System.Title'] || '',
            state: wi.fields['System.State'] || '',
            assignedTo: wi.fields['System.AssignedTo']?.displayName,
            dueDate: extractDate(wi.fields['Microsoft.VSTS.Scheduling.DueDate']),
            qaCompleteDate: extractDate(wi.fields['Custom.QACompleteDate']),
            workItemType: wi.fields['System.WorkItemType'] || '',
            changedDate: wi.fields['System.ChangedDate'] || '',
            createdDate: wi.fields['System.CreatedDate'] || '',
            closedDate: extractDate(wi.fields['Microsoft.VSTS.Common.ClosedDate']),
            areaPath: wi.fields['System.AreaPath'] || '',
            iterationPath: wi.fields['System.IterationPath'] || '',
            tags: wi.fields['System.Tags'] || '',
            description: wi.fields['System.Description'] || '',
            acceptanceCriteria: wi.fields['Microsoft.VSTS.Common.AcceptanceCriteria'] || '',
            reproSteps: wi.fields['Microsoft.VSTS.TCM.ReproSteps'] || '',
            design: wi.fields['Custom.Design'] || '',
            discussions: wi.fields['System.History'] || '',
          });
        }
      }

      // Return all PBIs, Technical Backlog Items, and Bugs
      const childItems = allWorkItems.filter(item => 
        item.workItemType === 'Product Backlog Item' || 
        item.workItemType === 'Technical Backlog Item' ||
        item.workItemType === 'Bug'
      );

      return childItems;
    });
  }

  async getTeamMembers(teamName: string): Promise<string[]> {
    try {
      const coreApi = await this.connection.getCoreApi();
      
      // Get team members
      const teamMembers = await coreApi.getTeamMembersWithExtendedProperties(
        this.project,
        teamName
      );
      
      // Extract display names
      const memberNames = teamMembers
        .map(member => member.identity?.displayName)
        .filter((name): name is string => !!name)
        .sort();
      
      return memberNames;
    } catch (error) {
      console.error(`Error fetching team members for ${teamName}:`, error);
      return [];
    }
  }

  async getTeamMembersWithEmails(teamName: string): Promise<Array<{ name: string; email: string }>> {
    try {
      const coreApi = await this.connection.getCoreApi();

      const teamMembers = await coreApi.getTeamMembersWithExtendedProperties(
        this.project,
        teamName
      );

      return teamMembers
        .filter(member => member.identity?.displayName)
        .map(member => ({
          name: member.identity!.displayName!,
          email: (member.identity!.uniqueName ?? '').toLowerCase(),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      console.error(`Error fetching team members with emails for ${teamName}:`, error);
      return [];
    }
  }

  /**
   * Analyzes work item history to determine if developers hit their due dates.
   * Criteria: 
   * - Hit = Work item transitions from "In Progress" to completion state on or before the due date without any due date changes
   * - Miss = Count each due date change as a miss
   */
  async getDueDateHitRate(from?: string, to?: string, developerFilter?: string): Promise<DueDateHitRateStats[]> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();

      // Build WIQL query to get PBIs, Technical Backlog Items, and Bugs with due dates
      let wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${this.project}' AND ([System.WorkItemType] = 'Product Backlog Item' OR [System.WorkItemType] = 'Technical Backlog Item' OR [System.WorkItemType] = 'Bug') AND [Microsoft.VSTS.Scheduling.DueDate] <> ''`;

      if (this.areaPath) {
        wiql += ` AND [System.AreaPath] UNDER '${this.areaPath}'`;
      }

      // Filter by date range based on when items were changed
      if (from && to) {
        wiql += ` AND [System.ChangedDate] >= '${from}' AND [System.ChangedDate] <= '${to}'`;
      }

      wiql += ' ORDER BY [System.ChangedDate] DESC';

      const queryResult = await witApi.queryByWiql(
        { query: wiql },
        { project: this.project }
      );

      if (!queryResult.workItems || queryResult.workItems.length === 0) {
        return [];
      }

      const ids = queryResult.workItems.map((wi) => wi.id!);
      console.log(`Analyzing ${ids.length} work items with due dates for hit rate`);
      
      // Debug: Check if 38505 is in the query results
      if (ids.includes(38505)) {
        console.log(`✓ Work item 38505 is in the query results`);
      } else {
        console.log(`✗ Work item 38505 NOT in query results - it may not match the WIQL filter criteria`);
      }

      // Fetch work items in batches
      const batchSize = 200;
      const batches: number[][] = [];
      for (let i = 0; i < ids.length; i += batchSize) {
        batches.push(ids.slice(i, i + batchSize));
      }

      const fields = [
        'System.Id',
        'System.Title',
        'System.State',
        'System.AssignedTo',
        'Microsoft.VSTS.Scheduling.DueDate',
        'System.WorkItemType',
      ];

      interface WorkItemAnalysis {
        id: number;
        title: string;
        assignedTo?: string;
        dueDate?: string;
        workItemType: string;
        dueDateChangeCount: number;
        dueDateChangeReasons: string[];
        hit: boolean;
        completionInfo: string;
        status: 'hit' | 'miss' | 'in-progress';
      }

      const developerMap = new Map<string, WorkItemAnalysis[]>();

      for (const batch of batches) {
        const workItems = await witApi.getWorkItems(
          batch,
          fields,
          undefined,
          undefined,
          undefined
        );

        // Analyze each work item's history
        for (const wi of workItems) {
          if (!wi.id || !wi.fields) continue;

          const assignedTo = wi.fields['System.AssignedTo']?.displayName;
          const currentDueDate = wi.fields['Microsoft.VSTS.Scheduling.DueDate'];

          // Debug: Check if this is work item 38505
          if (wi.id === 38505) {
            console.log(`\n=== FOUND Work Item 38505 ===`);
            console.log(`Assigned to: ${assignedTo}`);
            console.log(`Has due date: ${!!currentDueDate}`);
            console.log(`Due date value: ${currentDueDate}`);
            console.log(`Will be processed: ${assignedTo && currentDueDate ? 'YES' : 'NO'}`);
            if (developerFilter) {
              console.log(`Developer filter active: ${developerFilter}`);
              console.log(`Matches filter: ${assignedTo === developerFilter ? 'YES' : 'NO'}`);
            }
            console.log(`=== END ===\n`);
          }

          // Skip if no assignee or no due date
          if (!assignedTo || !currentDueDate) continue;

          // Apply developer filter if specified
          if (developerFilter && assignedTo !== developerFilter) continue;

          try {
            // Get full revision history
            const revisions = await witApi.getRevisions(wi.id);

            if (!revisions || revisions.length === 0) continue;

            // Track due date changes and state transitions
            let dueDateChangeCount = 0;
            let dueDateChangeReasons: string[] = [];
            let previousDueDate: string | null = null;
            let transitionDate: string | null = null;
            let dueDateAtTransition: string | null = null;
            let hitDueDate = false;
            let hasTransitioned = false;
            let assignedToAtTransition: string | undefined = undefined;

            // Debug logging for specific work item
            const isDebugItem = wi.id === 38505;
            if (isDebugItem) {
              console.log(`\n=== DEBUG: Work Item ${wi.id} ===`);
              console.log(`Currently assigned to: ${assignedTo}`);
              console.log(`Current state: ${wi.fields['System.State']}`);
              console.log(`Due date: ${currentDueDate}`);
              console.log(`Total revisions: ${revisions.length}`);
            }

            // Process revisions in chronological order
            for (let i = 0; i < revisions.length; i++) {
              const revision = revisions[i];
              const prevRevision = i > 0 ? revisions[i - 1] : null;

              const revState = revision.fields?.['System.State'];
              const prevState = prevRevision?.fields?.['System.State'];
              const revDueDate = revision.fields?.['Microsoft.VSTS.Scheduling.DueDate'];
              const revChangedDate = revision.fields?.['System.ChangedDate'];

              // Track due date changes
              if (revDueDate) {
                // Parse as UTC to avoid timezone shifts
                const dueDateStr = revDueDate.split('T')[0];
                
                if (previousDueDate && previousDueDate !== dueDateStr) {
                  dueDateChangeCount++;

                  // Extract reason from custom fields or history (same logic as getDueDateChangeHistory)
                  const revFields = revision.fields ?? {};
                  let changeReason: string =
                    revFields['Custom.DueDateMovementReasons'] ||
                    revFields['Custom.DueDateMovementReason'] ||
                    revFields['Custom.DueDateReason'] ||
                    '';
                  if (!changeReason && revFields['System.History']) {
                    const match = (revFields['System.History'] as string).match(
                      /Due date change reason:\s*(.+?)(?:<|$)/i
                    );
                    if (match) changeReason = match[1].trim();
                  }
                  if (!/^initializ/i.test(changeReason)) {
                    dueDateChangeReasons.push(changeReason || 'No reason provided');
                  }
                }
                
                previousDueDate = dueDateStr;
              }

              // Check for transition from working states to completion states
              const workingStates = ['In Progress', 'Committed', 'In Pull Request'];
              const completionStates = ['Ready for Test', 'Ready For Test', 'In Test', 'Done'];
              
              if (workingStates.includes(prevState) && completionStates.includes(revState)) {
                hasTransitioned = true;
                transitionDate = revChangedDate ? revChangedDate.split('T')[0] : null;
                
                // Capture who was assigned at the time of transition (from the previous revision)
                assignedToAtTransition = prevRevision?.fields?.['System.AssignedTo']?.displayName;
                
                if (isDebugItem) {
                  console.log(`\nTransition detected at revision ${i}:`);
                  console.log(`  From: ${prevState} → To: ${revState}`);
                  console.log(`  Transition date: ${transitionDate}`);
                  console.log(`  Assigned to at transition: ${assignedToAtTransition}`);
                }
                
                // Get the due date at the time of transition
                const prevDueDate = prevRevision?.fields?.['Microsoft.VSTS.Scheduling.DueDate'];
                if (prevDueDate) {
                  dueDateAtTransition = prevDueDate.split('T')[0];
                  
                  if (isDebugItem) {
                    console.log(`  Due date at transition: ${dueDateAtTransition}`);
                  }
                  
                  // Check if transition happened on or before the due date
                  if (transitionDate && dueDateAtTransition) {
                    const transitionTime = new Date(transitionDate).getTime();
                    const dueTime = new Date(dueDateAtTransition).getTime();
                    
                    if (transitionTime <= dueTime) {
                      hitDueDate = true;
                      if (isDebugItem) console.log(`  Result: HIT (${transitionDate} <= ${dueDateAtTransition})`);
                    } else {
                      if (isDebugItem) console.log(`  Result: MISS (${transitionDate} > ${dueDateAtTransition})`);
                    }
                  }
                }
              }
            }

            const currentDueDateStr = currentDueDate.split('T')[0];
            const currentState = wi.fields['System.State'];
            const workItemType = wi.fields['System.WorkItemType'] || '';
            const today = new Date().toISOString().split('T')[0];
            
            // Determine hit/miss/in-progress status
            // Hit = transitioned from working state to completion on/before due date AND no due date changes
            const hit = hitDueDate && dueDateChangeCount === 0;
            
            // Check if item has reached a completion state
            const completionStates = ['Ready for Test', 'Ready For Test', 'In Test', 'Done', 'Closed', 'Resolved'];
            const isCompleted = completionStates.includes(currentState);
            
            // Determine status: 'hit', 'miss', or 'in-progress'
            let status: 'hit' | 'miss' | 'in-progress';
            if (dueDateChangeCount > 0) {
              status = 'miss';
            } else if (hit) {
              status = 'hit';
            } else if (hasTransitioned && !hitDueDate) {
              // Transitioned but after the due date
              status = 'miss';
            } else {
              status = 'in-progress';
            }
            
            if (isDebugItem) {
              console.log(`\nFinal analysis:`);
              console.log(`  Due date changes: ${dueDateChangeCount}`);
              console.log(`  Has transitioned: ${hasTransitioned}`);
              console.log(`  Hit due date: ${hitDueDate}`);
              console.log(`  Status: ${status}`);
              console.log(`  Will be attributed to: ${assignedToAtTransition || assignedTo}`);
              console.log(`=== END DEBUG ===\n`);
            }
            
            let completionInfo: string;
            if (dueDateChangeCount > 0) {
              completionInfo = `${dueDateChangeCount} change${dueDateChangeCount > 1 ? 's' : ''}`;
            } else if (transitionDate && dueDateAtTransition) {
              completionInfo = `Completed ${transitionDate}`;
            } else if (!isCompleted) {
              // Still in progress - check if past due
              if (currentDueDateStr < today) {
                completionInfo = 'Past due (In Progress)';
              } else {
                completionInfo = 'In Progress';
              }
            } else {
              // Completed but didn't track the transition properly
              completionInfo = 'Completed (date unknown)';
            }

            // Use the assignee at transition time if available, otherwise current assignee
            const developerForStats = assignedToAtTransition || assignedTo;

            const analysis: WorkItemAnalysis = {
              id: wi.id,
              title: wi.fields['System.Title'] || '',
              assignedTo: developerForStats,
              dueDate: currentDueDateStr,
              workItemType,
              dueDateChangeCount,
              dueDateChangeReasons,
              hit,
              completionInfo,
              status
            };

            if (!developerMap.has(developerForStats)) {
              developerMap.set(developerForStats, []);
            }
            developerMap.get(developerForStats)!.push(analysis);
          } catch (error) {
            console.error(`Error analyzing work item ${wi.id}:`, error);
            // Continue with next work item
          }
        }
      }

      // Build stats for each developer
      const stats: DueDateHitRateStats[] = [];

      for (const [developer, workItems] of developerMap.entries()) {
        // Hit count = work items that completed on time with no due date changes
        const hitCount = workItems.filter(wi => wi.hit).length;
        
        // Miss count = work items that had due date changes OR completed after due date
        const missCount = workItems.filter(wi => wi.status === 'miss').length;
        
        const totalCount = workItems.length;

        stats.push({
          developer,
          totalWorkItems: totalCount,
          hitDueDate: hitCount,
          missedDueDate: missCount,
          hitRate: totalCount > 0 ? (hitCount / totalCount) * 100 : 0,
          workItemDetails: workItems.map(wi => ({
            id: wi.id,
            title: wi.title,
            workItemType: wi.workItemType,
            dueDate: wi.dueDate!,
            completionDate: wi.completionInfo,
            dueDateChangeReasons: wi.dueDateChangeReasons,
            hit: wi.hit,
            status: wi.status
          }))
        });
      }

      console.log(`Calculated hit rate stats for ${stats.length} developers`);
      return stats.sort((a, b) => a.developer.localeCompare(b.developer));
    });
  }

  async getWorkItemRelations(workItemId: number): Promise<WorkItem[]> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();

      // Get the work item with relations - must explicitly expand relations
      const workItem = await witApi.getWorkItem(
        workItemId,
        undefined,
        undefined,
        WorkItemExpand.Relations, // Expand relations
        this.project
      );

      console.log(`Fetching relations for work item ${workItemId}`);
      console.log(`Relations found: ${workItem?.relations?.length || 0}`);

      if (!workItem || !workItem.relations) {
        console.log(`No relations found for work item ${workItemId}`);
        return [];
      }

      // Filter for relevant relation types:
      // - Hierarchy-Forward: Child items
      // - Hierarchy-Reverse: Parent items
      // - Related: Related work items
      const relevantRelations = workItem.relations.filter(
        (rel) => rel.rel === 'System.LinkTypes.Hierarchy-Forward' ||
                 rel.rel === 'System.LinkTypes.Hierarchy-Reverse' ||
                 rel.rel === 'System.LinkTypes.Related'
      );

      console.log(`All relations:`, workItem.relations.map(r => ({ rel: r.rel, url: r.url })));
      console.log(`Relevant relations found: ${relevantRelations.length}`);

      if (relevantRelations.length === 0) {
        return [];
      }

      // Extract related work item IDs from URLs
      const relatedIds = relevantRelations
        .map((rel) => {
          const url = rel.url;
          if (!url) return null;
          const match = url.match(/\/(\d+)$/);
          return match ? parseInt(match[1], 10) : null;
        })
        .filter((id): id is number => id !== null);

      console.log(`Extracted related IDs: ${relatedIds.join(', ')}`);

      if (relatedIds.length === 0) {
        return [];
      }

      // Fetch related work items
      const fields = [
        'System.Id',
        'System.Title',
        'System.State',
        'System.AssignedTo',
        'System.WorkItemType',
        'System.ChangedDate',
        'System.CreatedDate',
        'Microsoft.VSTS.Common.ClosedDate',
        'System.AreaPath',
        'System.IterationPath',
        'Microsoft.VSTS.Scheduling.DueDate',
        'Microsoft.VSTS.Scheduling.TargetDate',
        'Custom.QACompleteDate',
        'System.Tags',
        'System.Description',
        'Microsoft.VSTS.Common.AcceptanceCriteria',
        'Microsoft.VSTS.TCM.ReproSteps',
        'Custom.Design',
        'System.History',
      ];

      const workItems = await witApi.getWorkItems(
        relatedIds,
        fields,
        undefined,
        undefined,
        undefined
      );

      const extractDate = (dateValue: any): string | undefined => {
        if (!dateValue) return undefined;
        const date = new Date(dateValue);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      };

      const relatedItems: WorkItem[] = [];
      for (const wi of workItems) {
        if (!wi.id || !wi.fields) continue;

        relatedItems.push({
          id: wi.id,
          title: wi.fields['System.Title'] || '',
          state: wi.fields['System.State'] || '',
          assignedTo: wi.fields['System.AssignedTo']?.displayName,
          dueDate: extractDate(wi.fields['Microsoft.VSTS.Scheduling.DueDate']),
          targetDate: extractDate(wi.fields['Microsoft.VSTS.Scheduling.TargetDate']),
          qaCompleteDate: extractDate(wi.fields['Custom.QACompleteDate']),
          workItemType: wi.fields['System.WorkItemType'] || '',
          changedDate: wi.fields['System.ChangedDate'] || '',
          createdDate: wi.fields['System.CreatedDate'] || '',
          closedDate: extractDate(wi.fields['Microsoft.VSTS.Common.ClosedDate']),
          areaPath: wi.fields['System.AreaPath'] || '',
          iterationPath: wi.fields['System.IterationPath'] || '',
          tags: wi.fields['System.Tags'] || '',
          description: wi.fields['System.Description'] || '',
          acceptanceCriteria: wi.fields['Microsoft.VSTS.Common.AcceptanceCriteria'] || '',
          reproSteps: wi.fields['Microsoft.VSTS.TCM.ReproSteps'] || '',
          design: wi.fields['Custom.Design'] || '',
          discussions: wi.fields['System.History'] || '',
        });
      }

      return relatedItems;
    });
  }

  async getDueDateChangeHistoryForItem(workItemId: number): Promise<Array<{
    changedDate: string;
    changedBy: string;
    oldDueDate: string | null;
    newDueDate: string | null;
    reason: string | null;
  }>> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();
      
      // Get all revisions of the work item
      const revisions = await witApi.getRevisions(workItemId);
      
      if (!revisions || revisions.length === 0) {
        return [];
      }

      const changes: Array<{
        changedDate: string;
        changedBy: string;
        oldDueDate: string | null;
        newDueDate: string | null;
        reason: string | null;
      }> = [];

      let previousDueDate: string | null = null;

      for (let i = 0; i < revisions.length; i++) {
        const revision = revisions[i];
        const currentDueDate = revision.fields?.['Microsoft.VSTS.Scheduling.DueDate'];
        const currentDueDateStr = currentDueDate ? currentDueDate.split('T')[0] : null;
        const changedBy = revision.fields?.['System.ChangedBy']?.displayName || 'Unknown';
        const changedDate = revision.fields?.['System.ChangedDate'];
        
        // Try to get reason from custom fields (same names as getDueDateChangeHistory)
        let reason: string | null =
          revision.fields?.['Custom.DueDateMovementReasons'] ||
          revision.fields?.['Custom.DueDateMovementReason'] ||
          revision.fields?.['Custom.DueDateReason'] ||
          null;
        if (!reason) {
          const history = revision.fields?.['System.History'];
          if (history && typeof history === 'string') {
            const match = history.match(/Due date change reason:\s*(.+?)(?:<|$)/i);
            if (match) reason = match[1].trim();
          }
        }
        // Exclude initialization entries
        if (reason && /^initializ/i.test(reason)) reason = null;

        // Detect due date change (skip initial setting from null)
        if (currentDueDateStr !== previousDueDate && previousDueDate !== null) {
          changes.push({
            changedDate: changedDate ? new Date(changedDate).toISOString() : '',
            changedBy,
            oldDueDate: previousDueDate,
            newDueDate: currentDueDateStr,
            reason: reason || 'No reason provided'
          });
        }

        previousDueDate = currentDueDateStr;
      }

      return changes;
    });
  }

  async getWorkItemComments(workItemId: number): Promise<string> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();
      
      try {
        // Get comments for the work item
        const comments = await witApi.getComments(this.project, workItemId);
        
        if (!comments || !comments.comments || comments.comments.length === 0) {
          return '';
        }

        // Format comments as HTML
        const commentsHtml = comments.comments
          .map(comment => {
            const author = comment.createdBy?.displayName || 'Unknown';
            const date = comment.createdDate ? new Date(comment.createdDate).toLocaleString() : '';
            const text = comment.text || '';
            
            return `
              <div class="discussion-comment">
                <div class="discussion-header">
                  <strong>${author}</strong> <span class="discussion-date">${date}</span>
                </div>
                <div class="discussion-text">${text}</div>
              </div>
            `;
          })
          .join('\n');

        return commentsHtml;
      } catch (error) {
        console.error(`Error fetching comments for work item ${workItemId}:`, error);
        return '';
      }
    });
  }

  /**
   * Return structured comment history for a work item.
   */
  async getWorkItemCommentHistory(workItemId: number, limit = 200): Promise<Array<{
    id: number;
    text: string;
    createdDate?: string;
    modifiedDate?: string;
    createdBy?: string;
    modifiedBy?: string;
    isDeleted?: boolean;
    version?: number;
  }>> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();
      const commentsResult = await witApi.getComments(this.project, workItemId);
      const comments = commentsResult?.comments ?? [];
      if (!comments.length) return [];

      const boundedLimit = Math.max(1, Math.min(limit, 500));
      return comments
        .slice(-boundedLimit)
        .map((comment) => ({
          id: comment.id ?? 0,
          text: comment.text ?? '',
          createdDate: comment.createdDate ? new Date(comment.createdDate).toISOString() : undefined,
          modifiedDate: comment.modifiedDate ? new Date(comment.modifiedDate).toISOString() : undefined,
          createdBy: comment.createdBy?.displayName || comment.createdBy?.uniqueName,
          modifiedBy: comment.modifiedBy?.displayName || comment.modifiedBy?.uniqueName,
          isDeleted: comment.isDeleted,
          version: comment.version,
        }));
    });
  }

  /**
   * Get all unique release versions from work item tags
   * Tags follow format: Release:v1.0, Release:v2.0, etc.
   */
  async getReleaseVersions(): Promise<string[]> {
    return retryWithBackoff(async () => {
      try {
        const witApi = await this.connection.getWorkItemTrackingApi();

        // Query all Features and Epics to extract release tags
        let wiql = `SELECT [System.Id], [System.Tags] FROM WorkItems WHERE [System.TeamProject] = '${this.project}' AND ([System.WorkItemType] = 'Feature' OR [System.WorkItemType] = 'Epic')`;

        if (this.areaPath) {
          wiql += ` AND [System.AreaPath] = '${this.areaPath}'`;
        }

        console.log('[getReleaseVersions] Executing WIQL query for releases');

        const queryResult = await witApi.queryByWiql(
          { query: wiql },
          { project: this.project }
        );

        if (!queryResult.workItems || queryResult.workItems.length === 0) {
          console.log('[getReleaseVersions] No Features or Epics found');
          return [];
        }

        console.log(`[getReleaseVersions] Found ${queryResult.workItems.length} Features/Epics`);

        const ids = queryResult.workItems.map((wi) => wi.id!);
        console.log(`[getReleaseVersions] Work item IDs to fetch:`, ids);
        
        if (ids.length === 0) {
          console.log('[getReleaseVersions] No work item IDs, returning empty array');
          return [];
        }

        const workItems = await this.getWorkItemsInBatches(witApi, ids, ['System.Tags']);

        console.log(`[getReleaseVersions] getWorkItems returned:`, workItems ? `${workItems.length} items` : 'null');

        const releaseVersions = new Set<string>();

        if (!workItems || workItems.length === 0) {
          console.log('[getReleaseVersions] No work items returned, returning empty array');
          return [];
        }

        workItems.forEach((wi) => {
          const tags = wi.fields?.['System.Tags'] as string;
          if (tags) {
            // Extract release tags (format: Release:v1.0)
            const releaseTags = tags.split(';').map(t => t.trim()).filter(t => t.startsWith('Release:'));
            releaseTags.forEach(tag => {
              const version = tag.substring('Release:'.length);
              if (version) {
                releaseVersions.add(version);
              }
            });
          }
        });

        const versions = Array.from(releaseVersions).sort();
        console.log(`[getReleaseVersions] Found ${versions.length} unique release versions:`, versions);
        
        return versions;
      } catch (error) {
        console.error('[getReleaseVersions] Error:', error);
        throw error;
      }
    });
  }

  /**
   * Get work items (Features/Epics) tagged with a specific release version
   */
  async getWorkItemsByRelease(releaseVersion: string): Promise<WorkItem[]> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();

      // Query Features and Epics with the release tag
      let wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${this.project}' AND ([System.WorkItemType] = 'Feature' OR [System.WorkItemType] = 'Epic') AND [System.Tags] CONTAINS 'Release:${releaseVersion}'`;

      if (this.areaPath) {
        wiql += ` AND [System.AreaPath] = '${this.areaPath}'`;
      }

      wiql += ' ORDER BY [System.WorkItemType], [System.ChangedDate] DESC';

      const queryResult = await witApi.queryByWiql(
        { query: wiql },
        { project: this.project }
      );

      if (!queryResult.workItems || queryResult.workItems.length === 0) {
        return [];
      }

      const ids = queryResult.workItems.map((wi) => wi.id!);

      const fields = [
        'System.Id',
        'System.Title',
        'System.State',
        'System.AssignedTo',
        'System.WorkItemType',
        'System.ChangedDate',
        'System.CreatedDate',
        'Microsoft.VSTS.Common.ClosedDate',
        'System.AreaPath',
        'System.IterationPath',
        'Microsoft.VSTS.Scheduling.TargetDate',
        'System.Tags',
        'System.Description',
      ];

      const workItems = await this.getWorkItemsInBatches(witApi, ids, fields, WorkItemExpand.All);

      return workItems.map((wi) => {
        const extractDate = (dateValue: any): string | undefined => {
          if (!dateValue) return undefined;
          const date = new Date(dateValue);
          const year = date.getFullYear();
          const month = String(date.getMonth() + 1).padStart(2, '0');
          const day = String(date.getDate()).padStart(2, '0');
          return `${year}-${month}-${day}`;
        };

        return {
          id: wi.id!,
          title: wi.fields?.['System.Title'] || '',
          state: wi.fields?.['System.State'] || '',
          assignedTo: wi.fields?.['System.AssignedTo']?.displayName,
          workItemType: wi.fields?.['System.WorkItemType'] || '',
          changedDate: wi.fields?.['System.ChangedDate'] || '',
          createdDate: wi.fields?.['System.CreatedDate'] || '',
          closedDate: extractDate(wi.fields?.['Microsoft.VSTS.Common.ClosedDate']),
          areaPath: wi.fields?.['System.AreaPath'] || '',
          iterationPath: wi.fields?.['System.IterationPath'] || '',
          targetDate: extractDate(wi.fields?.['Microsoft.VSTS.Scheduling.TargetDate']),
          tags: wi.fields?.['System.Tags'] || '',
          description: wi.fields?.['System.Description'] || '',
        };
      });
    });
  }

  /**
   * Calculate release metrics for a specific release version
   */
  async getReleaseMetrics(releaseVersion: string): Promise<ReleaseMetrics> {
    return retryWithBackoff(async () => {
      const features = await this.getWorkItemsByRelease(releaseVersion);

      const totalFeatures = features.length;
      let completedFeatures = 0;
      let inProgressFeatures = 0;
      let blockedFeatures = 0;
      let readyForReleaseFeatures = 0;
      let uatReadyForTestFeatures = 0;

      const completedStates = ['Ready For Release', 'UAT - Test Done', 'Done', 'Closed'];
      const amberStates = ['UAT - Ready For Test', 'UAT Ready For Test', 'UAT-Ready For Test'];
      const inProgressStates = ['Committed', 'In Progress', 'Ready For Test', 'In Test', 'UAT - Ready For Test'];
      const blockedStates = ['Blocked'];

      features.forEach((feature) => {
        const state = feature.state;

        if (completedStates.includes(state)) {
          completedFeatures++;
        }
        if (state === 'Ready For Release') {
          readyForReleaseFeatures++;
        }
        if (amberStates.includes(state)) {
          uatReadyForTestFeatures++;
        }
        if (inProgressStates.includes(state)) {
          inProgressFeatures++;
        }
        if (blockedStates.includes(state)) {
          blockedFeatures++;
        }
      });

      return {
        releaseVersion,
        totalFeatures,
        completedFeatures,
        inProgressFeatures,
        blockedFeatures,
        readyForReleaseFeatures,
        uatReadyForTestFeatures,
        deploymentHistory: [],
      };
    });
  }

  /**
   * Add a release tag to a work item
   */
  async addReleaseTag(workItemId: number, releaseVersion: string): Promise<void> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();

      // Get current tags
      const workItem = await witApi.getWorkItem(workItemId, ['System.Tags'], undefined, undefined, this.project);
      const currentTags = (workItem.fields?.['System.Tags'] as string) || '';

      const releaseTag = `Release:${releaseVersion}`;

      // Check if release tag already exists
      if (currentTags.includes(releaseTag)) {
        return; // Tag already exists
      }

      // Add new release tag
      const newTags = currentTags ? `${currentTags}; ${releaseTag}` : releaseTag;

      const patchDocument = [
        {
          op: 'add',
          path: '/fields/System.Tags',
          value: newTags,
        },
      ];

      await witApi.updateWorkItem(
        {},
        patchDocument,
        workItemId,
        this.project
      );
    });
  }

  /**
   * Remove a release tag from a work item
   */
  async removeReleaseTag(workItemId: number, releaseVersion: string): Promise<void> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();

      // Get current tags
      const workItem = await witApi.getWorkItem(workItemId, ['System.Tags'], undefined, undefined, this.project);
      const currentTags = (workItem.fields?.['System.Tags'] as string) || '';

      const releaseTag = `Release:${releaseVersion}`;

      // Remove the release tag
      const tagArray = currentTags.split(';').map(t => t.trim()).filter(t => t !== releaseTag);
      const newTags = tagArray.join('; ');

      const patchDocument = [
        {
          op: 'add',
          path: '/fields/System.Tags',
          value: newTags,
        },
      ];

      await witApi.updateWorkItem(
        {},
        patchDocument,
        workItemId,
        this.project
      );
    });
  }

  /**
   * Create a release Epic in Azure DevOps
   */
  async createReleaseEpic(releaseVersion: string, startDate?: string, targetDate?: string, description?: string): Promise<number> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();

      const patchDocument: any[] = [
        {
          op: 'add',
          path: '/fields/System.Title',
          value: releaseVersion,
        },
        {
          op: 'add',
          path: '/fields/System.Tags',
          value: `ReleaseVersion`,
        },
      ];

      // Add area path if configured
      if (this.areaPath) {
        patchDocument.push({
          op: 'add',
          path: '/fields/System.AreaPath',
          value: this.areaPath,
        });
      }

      // Add start date if provided
      if (startDate) {
        const [year, month, day] = startDate.split('-').map(Number);
        const localDate = new Date(year, month - 1, day, 0, 0, 0);
        const dateValue = localDate.toISOString();
        patchDocument.push({
          op: 'add',
          path: '/fields/Microsoft.VSTS.Scheduling.StartDate',
          value: dateValue,
        });
      }

      // Add target date if provided
      if (targetDate) {
        const [year, month, day] = targetDate.split('-').map(Number);
        const localDate = new Date(year, month - 1, day, 0, 0, 0);
        const dateValue = localDate.toISOString();
        patchDocument.push({
          op: 'add',
          path: '/fields/Microsoft.VSTS.Scheduling.TargetDate',
          value: dateValue,
        });
      }

      // Add description if provided
      if (description) {
        patchDocument.push({
          op: 'add',
          path: '/fields/System.Description',
          value: description,
        });
      }

      const workItem = await witApi.createWorkItem(
        {},
        patchDocument,
        this.project,
        'Epic'
      );

      if (!workItem.id) {
        throw new Error('Failed to create release Epic');
      }

      return workItem.id;
    });
  }

  /**
   * Get all release Epics with their details and progress
   */
  async getReleaseEpics(): Promise<any[]> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();

      // Query all Epics with ReleaseVersion tag
      let wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${this.project}' AND [System.WorkItemType] = 'Epic' AND [System.Tags] CONTAINS 'ReleaseVersion'`;

      if (this.areaPath) {
        wiql += ` AND [System.AreaPath] = '${this.areaPath}'`;
      }

      wiql += ' ORDER BY [Microsoft.VSTS.Scheduling.TargetDate] DESC';

      const queryResult = await witApi.queryByWiql(
        { query: wiql },
        { project: this.project }
      );

      if (!queryResult.workItems || queryResult.workItems.length === 0) {
        return [];
      }

      const ids = queryResult.workItems.map((wi) => wi.id!);

      const fields = [
        'System.Id',
        'System.Title',
        'System.State',
        'System.Description',
        'Microsoft.VSTS.Scheduling.StartDate',
        'Microsoft.VSTS.Scheduling.TargetDate',
        'System.Tags',
      ];

      const workItems = await this.getWorkItemsInBatches(witApi, ids, fields);

      const releaseEpics = [];

      for (const wi of workItems) {
        if (!wi.id || !wi.fields) continue;

        // Helper function to extract date
        const extractDate = (dateValue: any): string | undefined => {
          if (!dateValue) return undefined;
          const date = new Date(dateValue);
          const year = date.getFullYear();
          const month = String(date.getMonth() + 1).padStart(2, '0');
          const day = String(date.getDate()).padStart(2, '0');
          return `${year}-${month}-${day}`;
        };

        // Get all related work items to calculate progress
        const childrenResponse = await fetch(
          `${this.organization}/${this.project}/_apis/wit/wiql?api-version=6.0`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Basic ${Buffer.from(':' + process.env.ADO_PAT).toString('base64')}`,
            },
            body: JSON.stringify({
              query: `SELECT [System.Id] FROM WorkItemLinks WHERE ([Source].[System.Id] = ${wi.id}) AND ([System.Links.LinkType] = 'System.LinkTypes.Related') MODE (MustContain)`,
            }),
          }
        );

        let totalItems = 0;
        let completedItems = 0;
        let progress = 0;
        let greenItems = 0;
        let amberItems = 0;
        let redItems = 0;

        if (childrenResponse.ok) {
          const childrenData = await childrenResponse.json() as any;
          const childIds = childrenData.workItemRelations
            ?.filter((rel: any) => rel.target && rel.target.id !== wi.id)
            .map((rel: any) => rel.target.id) || [];

          if (childIds.length > 0) {
            const childWorkItems = await this.getWorkItemsInBatches(witApi, childIds, ['System.State', 'System.WorkItemType', 'System.Id']);
            const actualChildren = childWorkItems.filter((child) => child.id !== wi.id);
            totalItems = actualChildren.length;
            
            const greenStates = ['Ready For Release', 'UAT - Test Done', 'Done', 'Closed'];
            const amberStates = ['UAT - Ready For Test', 'UAT Ready For Test', 'UAT-Ready For Test'];

            actualChildren.forEach((child) => {
              const state = child.fields?.['System.State'];
              if (greenStates.includes(state)) {
                greenItems++;
              } else if (amberStates.includes(state)) {
                amberItems++;
              } else {
                redItems++;
              }
            });

            completedItems = greenItems;
            progress = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;
          }
        }

        releaseEpics.push({
          id: wi.id,
          version: wi.fields['System.Title'] || '',
          status: wi.fields['System.State'] || '',
          startDate: extractDate(wi.fields['Microsoft.VSTS.Scheduling.StartDate']),
          targetDate: extractDate(wi.fields['Microsoft.VSTS.Scheduling.TargetDate']),
          description: wi.fields['System.Description'] || '',
          progress,
          totalItems,
          completedItems,
          greenItems,
          amberItems,
          redItems,
        });
      }

      return releaseEpics;
    });
  }

  /**
   * Update a release Epic in Azure DevOps
   */
  async updateReleaseEpic(epicId: number, title?: string, startDate?: string, targetDate?: string, description?: string, status?: string): Promise<void> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();

      const patchDocument: any[] = [];

      // Update title if provided
      if (title) {
        patchDocument.push({
          op: 'add',
          path: '/fields/System.Title',
          value: title,
        });
      }

      // Update start date if provided
      if (startDate) {
        const [year, month, day] = startDate.split('-').map(Number);
        const localDate = new Date(year, month - 1, day, 0, 0, 0);
        const dateValue = localDate.toISOString();
        patchDocument.push({
          op: 'add',
          path: '/fields/Microsoft.VSTS.Scheduling.StartDate',
          value: dateValue,
        });
      }

      // Update target date if provided
      if (targetDate) {
        const [year, month, day] = targetDate.split('-').map(Number);
        const localDate = new Date(year, month - 1, day, 0, 0, 0);
        const dateValue = localDate.toISOString();
        patchDocument.push({
          op: 'add',
          path: '/fields/Microsoft.VSTS.Scheduling.TargetDate',
          value: dateValue,
        });
      }

      // Update description if provided
      if (description !== undefined) {
        patchDocument.push({
          op: 'add',
          path: '/fields/System.Description',
          value: description,
        });
      }

      // Update status if provided
      if (status) {
        patchDocument.push({
          op: 'add',
          path: '/fields/System.State',
          value: status,
        });
      }

      if (patchDocument.length > 0) {
        await witApi.updateWorkItem(
          {},
          patchDocument,
          epicId,
          this.project
        );
      }
    });
  }

  /**
   * Search for work items by query string
   */
  async searchWorkItems(query: string, typeFilter?: string): Promise<WorkItem[]> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();

      // Build WIQL query
      let wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${this.project}'`;

      if (this.areaPath) {
        wiql += ` AND [System.AreaPath] = '${this.areaPath}'`;
      }

      // Filter by work item type if specified
      if (typeFilter && typeFilter !== 'All') {
        wiql += ` AND [System.WorkItemType] = '${typeFilter}'`;
      } else {
        wiql += ` AND ([System.WorkItemType] = 'Epic' OR [System.WorkItemType] = 'Feature' OR [System.WorkItemType] = 'Product Backlog Item' OR [System.WorkItemType] = 'Technical Backlog Item' OR [System.WorkItemType] = 'Bug')`;
      }

      // Search by ID or title/description
      const numericQuery = parseInt(query, 10);
      if (!isNaN(numericQuery)) {
        wiql += ` AND [System.Id] = ${numericQuery}`;
      } else {
        wiql += ` AND ([System.Title] CONTAINS '${query}' OR [System.Description] CONTAINS '${query}')`;
      }

      wiql += ' ORDER BY [System.ChangedDate] DESC';

      const queryResult = await witApi.queryByWiql(
        { query: wiql },
        { project: this.project }
      );

      if (!queryResult.workItems || queryResult.workItems.length === 0) {
        return [];
      }

      const ids = queryResult.workItems.map((wi) => wi.id!).slice(0, 50); // Limit to 50 results

      const fields = [
        'System.Id',
        'System.Title',
        'System.State',
        'System.AssignedTo',
        'System.WorkItemType',
      ];

      const workItems = await witApi.getWorkItems(ids, fields);

      return workItems.map((wi) => ({
        id: wi.id!,
        title: wi.fields!['System.Title'] || '',
        state: wi.fields!['System.State'] || '',
        assignedTo: wi.fields!['System.AssignedTo']?.displayName,
        workItemType: wi.fields!['System.WorkItemType'] || '',
        changedDate: '',
        createdDate: '',
        areaPath: '',
        iterationPath: '',
        tags: '',
      }));
    });
  }

  /**
   * Get direct child work items for a release Epic (not including nested Epic children)
   * This is different from getEpicChildren which only returns Features
   */
  async getReleaseEpicChildren(epicId: number): Promise<WorkItem[]> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();

      // Query for only DIRECT children of this Epic (non-recursive)
      const wiql = `SELECT [System.Id] FROM WorkItemLinks WHERE ([Source].[System.Id] = ${epicId}) AND ([System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward') MODE (MustContain)`;

      console.log(`Executing WIQL query for release epic ${epicId}`);
      const queryResult = await witApi.queryByWiql(
        { query: wiql },
        { project: this.project }
      );

      if (!queryResult.workItemRelations || queryResult.workItemRelations.length === 0) {
        console.log(`No work item relations found for epic ${epicId}`);
        return [];
      }

      // Extract all direct child IDs
      const childIds = queryResult.workItemRelations
        .filter(rel => rel.target) // Only get targets (children)
        .map(rel => rel.target?.id)
        .filter((id): id is number => id !== undefined);

      console.log(`Found ${childIds.length} direct child IDs for epic ${epicId}:`, childIds);

      if (childIds.length === 0) {
        return [];
      }

      // Fetch work items in batches of 200 (ADO limit)
      const batchSize = 200;
      const batches: number[][] = [];
      for (let i = 0; i < childIds.length; i += batchSize) {
        batches.push(childIds.slice(i, i + batchSize));
      }

      const fields = [
        'System.Id',
        'System.Title',
        'System.State',
        'System.AssignedTo',
        'System.WorkItemType',
        'System.ChangedDate',
        'System.CreatedDate',
        'Microsoft.VSTS.Common.ClosedDate',
        'System.AreaPath',
        'System.IterationPath',
        'Microsoft.VSTS.Scheduling.DueDate',
        'Microsoft.VSTS.Scheduling.TargetDate',
        'System.Tags',
      ];

      const allWorkItems: WorkItem[] = [];

      for (const batch of batches) {
        const workItems = await witApi.getWorkItems(
          batch,
          fields,
          undefined,
          undefined,
          undefined
        );

        for (const wi of workItems) {
          if (!wi.id || !wi.fields) continue;
          
          // Skip the parent Epic itself
          if (wi.id === epicId) continue;

          const extractDate = (dateValue: any): string | undefined => {
            if (!dateValue) return undefined;
            const date = new Date(dateValue);
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
          };

          allWorkItems.push({
            id: wi.id,
            title: wi.fields['System.Title'] || '',
            state: wi.fields['System.State'] || '',
            assignedTo: wi.fields['System.AssignedTo']?.displayName,
            workItemType: wi.fields['System.WorkItemType'] || '',
            changedDate: extractDate(wi.fields['System.ChangedDate']) || '',
            createdDate: extractDate(wi.fields['System.CreatedDate']) || '',
            closedDate: extractDate(wi.fields['Microsoft.VSTS.Common.ClosedDate']),
            areaPath: wi.fields['System.AreaPath'] || '',
            iterationPath: wi.fields['System.IterationPath'] || '',
            dueDate: extractDate(wi.fields['Microsoft.VSTS.Scheduling.DueDate']),
            targetDate: extractDate(wi.fields['Microsoft.VSTS.Scheduling.TargetDate']),
            tags: wi.fields['System.Tags'] || '',
          });
        }
      }

      console.log(`Returning ${allWorkItems.length} work items for epic ${epicId}`);
      return allWorkItems;
    });
  }

  /**
   * Get parent release epic for a work item (if it has ReleaseVersion tag)
   */
  async getParentReleaseEpic(workItemId: number): Promise<{id: number; title: string; version: string} | null> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();

      console.log(`[getParentReleaseEpic] Fetching parent release epic for work item ${workItemId}`);

      // Query for parent Epic with ReleaseVersion tag
      // Using Hierarchy-Reverse to get parent from child's perspective
      const wiql = `SELECT [System.Id] FROM WorkItemLinks WHERE ([Source].[System.Id] = ${workItemId}) AND ([Target].[System.WorkItemType] = 'Epic') AND ([Target].[System.Tags] CONTAINS 'ReleaseVersion') AND ([System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Reverse') MODE (MustContain)`;

      console.log(`[getParentReleaseEpic] Executing WIQL: ${wiql}`);

      const queryResult = await witApi.queryByWiql(
        { query: wiql },
        { project: this.project }
      );

      console.log(`[getParentReleaseEpic] Query result:`, JSON.stringify(queryResult, null, 2));

      if (!queryResult.workItemRelations || queryResult.workItemRelations.length === 0) {
        console.log(`[getParentReleaseEpic] No parent epic found for work item ${workItemId}`);
        return null;
      }

      // Get the target (parent) Epic ID - now using target since we reversed the query
      const parentId = queryResult.workItemRelations[0]?.target?.id;
      
      console.log(`[getParentReleaseEpic] Found parent epic ID: ${parentId}`);
      
      if (!parentId) {
        console.log(`[getParentReleaseEpic] Parent ID is null or undefined`);
        return null;
      }

      // Fetch the parent Epic details
      const parentWorkItem = await witApi.getWorkItem(parentId, undefined, undefined, undefined, this.project);
      
      if (!parentWorkItem || !parentWorkItem.fields) {
        console.log(`[getParentReleaseEpic] Failed to fetch parent work item details`);
        return null;
      }

      console.log(`[getParentReleaseEpic] Parent epic details:`, {
        id: parentWorkItem.id,
        title: parentWorkItem.fields['System.Title'],
        tags: parentWorkItem.fields['System.Tags']
      });

      return {
        id: parentWorkItem.id!,
        title: parentWorkItem.fields['System.Title'] || '',
        version: parentWorkItem.fields['System.Title'] || ''
      };
    });
  }

  /**
   * Link work items to a release/epic as related items
   * Uses "Related" link type instead of hierarchy
   */
  async linkWorkItemsToRelease(epicId: number, workItemIds: number[]): Promise<void> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();

      for (const workItemId of workItemIds) {
        const patchDocument = [
          {
            op: 'add',
            path: '/relations/-',
            value: {
              rel: 'System.LinkTypes.Related',
              url: `${this.organization}/${this.project}/_apis/wit/workItems/${workItemId}`,
              attributes: {
                comment: 'Related to release',
              },
            },
          },
        ];

        await witApi.updateWorkItem(
          {},
          patchDocument,
          epicId,
          this.project
        );

        console.log(`[linkWorkItemsToRelease] Linked work item ${workItemId} to release/epic ${epicId}`);
      }
    });
  }

  /**
   * Link work items to an epic as children (kept for backward compatibility)
   */
  async linkWorkItemsToEpic(epicId: number, workItemIds: number[]): Promise<void> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();

      for (const workItemId of workItemIds) {
        const patchDocument = [
          {
            op: 'add',
            path: '/relations/-',
            value: {
              rel: 'System.LinkTypes.Hierarchy-Forward',
              url: `${this.organization}/${this.project}/_apis/wit/workItems/${workItemId}`,
              attributes: {
                comment: 'Linked to release epic',
              },
            },
          },
        ];

        await witApi.updateWorkItem(
          {},
          patchDocument,
          epicId,
          this.project
        );
      }
    });
  }

  /**
   * Get related items linked to an epic/release via "Related" link type
   */
  async getRelatedItems(epicId: number): Promise<WorkItem[]> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();

      // Get the epic with all its relations
      const epic = await witApi.getWorkItem(
        epicId,
        undefined,
        undefined,
        WorkItemExpand.Relations,
        this.project
      );

      if (!epic || !epic.relations) {
        console.log(`[getRelatedItems] Epic ${epicId} has no relations`);
        return [];
      }

      console.log(`[getRelatedItems] Epic ${epicId} has ${epic.relations.length} total relations`);
      console.log(`[getRelatedItems] Relation types:`, epic.relations.map((r: any) => r.rel));

      // Filter for "Related" link type relations
      const relatedLinks = epic.relations.filter(
        (rel: any) => rel.rel === 'System.LinkTypes.Related'
      );

      console.log(`[getRelatedItems] Found ${relatedLinks.length} related links`);

      if (relatedLinks.length === 0) {
        console.log(`[getRelatedItems] Epic ${epicId} has no related items`);
        return [];
      }

      // Extract work item IDs from relation URLs
      const relatedIds = relatedLinks
        .map((rel: any) => {
          const match = rel.url?.match(/\/(\d+)$/);
          return match ? parseInt(match[1], 10) : null;
        })
        .filter((id: number | null) => id !== null) as number[];

      console.log(`[getRelatedItems] Extracted ${relatedIds.length} related IDs:`, relatedIds);

      if (relatedIds.length === 0) {
        return [];
      }

      // Fetch the related work items
      const fields = [
        'System.Id',
        'System.Title',
        'System.State',
        'System.AssignedTo',
        'System.WorkItemType',
        'System.ChangedDate',
        'System.CreatedDate',
        'Microsoft.VSTS.Common.ClosedDate',
        'System.AreaPath',
        'System.IterationPath',
        'System.Tags',
        'System.Description',
      ];

      const relatedItems = await witApi.getWorkItems(relatedIds, fields);

      return relatedItems.map((wi) => ({
        id: wi.id!,
        title: wi.fields?.['System.Title'] || '',
        state: wi.fields?.['System.State'] || '',
        assignedTo: wi.fields?.['System.AssignedTo']?.displayName,
        workItemType: wi.fields?.['System.WorkItemType'] || '',
        changedDate: wi.fields?.['System.ChangedDate'],
        createdDate: wi.fields?.['System.CreatedDate'],
        closedDate: wi.fields?.['Microsoft.VSTS.Common.ClosedDate'],
        areaPath: wi.fields?.['System.AreaPath'],
        iterationPath: wi.fields?.['System.IterationPath'],
        tags: wi.fields?.['System.Tags'],
        description: wi.fields?.['System.Description'],
      }));
    });
  }

  /**
   * Unlink work items from a release (remove related link)
   */
  async unlinkWorkItemsFromRelease(epicId: number, workItemIds: number[]): Promise<void> {
    console.log(`[unlinkWorkItemsFromRelease] STARTING - Epic: ${epicId}, Work Items: ${workItemIds}`);
    return retryWithBackoff(async () => {
      console.log(`[unlinkWorkItemsFromRelease] Inside retryWithBackoff`);
      const witApi = await this.connection.getWorkItemTrackingApi();
      console.log(`[unlinkWorkItemsFromRelease] Got work item tracking API`);

      for (const workItemId of workItemIds) {
        try {
          console.log(`[unlinkWorkItemsFromRelease] Processing work item ${workItemId}...`);
          
          // Fetch the work item with EXPAND to get all relations
          const workItem = await witApi.getWorkItem(workItemId, undefined, undefined, WorkItemExpand.Relations, this.project);
          console.log(`[unlinkWorkItemsFromRelease] Fetched work item ${workItemId}`);
          console.log(`[unlinkWorkItemsFromRelease] Work item fields:`, Object.keys(workItem.fields || {}));
          console.log(`[unlinkWorkItemsFromRelease] Work item _links:`, workItem._links);

          if (!workItem.relations || workItem.relations.length === 0) {
            console.log(`[unlinkWorkItemsFromRelease] Work item ${workItemId} has no relations`);
            console.log(`[unlinkWorkItemsFromRelease] Full work item object:`, JSON.stringify(workItem, null, 2));
            continue;
          }

          console.log(`[unlinkWorkItemsFromRelease] Work item ${workItemId} has ${workItem.relations.length} relations`);
          console.log(`[unlinkWorkItemsFromRelease] All relations with full details:`);
          workItem.relations.forEach((rel: any, idx: number) => {
            console.log(`  [${idx}] Type: ${rel.rel}, URL: ${rel.url}, Attributes:`, rel.attributes);
          });

          // Find the relation index for the epic (filter by "Related" link type)
          const relationIndex = workItem.relations.findIndex(
            (rel: any) => 
              rel.rel === 'System.LinkTypes.Related' &&
              rel.url?.includes(`/${epicId}`)
          );

          if (relationIndex === -1) {
            console.log(`[unlinkWorkItemsFromRelease] No 'System.LinkTypes.Related' link found between work item ${workItemId} and epic ${epicId}`);
            console.log(`[unlinkWorkItemsFromRelease] Looking for epic ${epicId} in any relation type...`);
            const anyRelationIndex = workItem.relations.findIndex(
              (rel: any) => rel.url?.includes(`/${epicId}`)
            );
            if (anyRelationIndex !== -1) {
              console.log(`[unlinkWorkItemsFromRelease] Found epic ${epicId} in relation type: ${workItem.relations[anyRelationIndex].rel}`);
            }
            continue;
          }

          console.log(`[unlinkWorkItemsFromRelease] Found related link at index ${relationIndex} from work item ${workItemId} to epic ${epicId}`);
          console.log(`[unlinkWorkItemsFromRelease] Relation to remove:`, JSON.stringify(workItem.relations[relationIndex], null, 2));

          const patchDocument = [
            {
              op: 'remove',
              path: `/relations/${relationIndex}`,
            },
          ];

          console.log(`[unlinkWorkItemsFromRelease] Sending patch to work item ${workItemId}:`, JSON.stringify(patchDocument, null, 2));

          await witApi.updateWorkItem(
            {},
            patchDocument,
            workItemId,
            this.project
          );

          console.log(`[unlinkWorkItemsFromRelease] Successfully removed related link from work item ${workItemId} to epic ${epicId}`);
        } catch (error) {
          console.error(`[unlinkWorkItemsFromRelease] Error unlinking work item ${workItemId} from epic ${epicId}:`, error);
          throw error; // Re-throw to fail the whole operation
        }
      }
      console.log(`[unlinkWorkItemsFromRelease] COMPLETED - All work items processed`);
    });
  }

  /**
   * Unlink work items from an epic (remove hierarchical relationship)
   */
  async unlinkWorkItemsFromEpic(epicId: number, workItemIds: number[]): Promise<void> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();

      // First, get the epic to find the relation indices
      const epicWorkItem = await witApi.getWorkItem(epicId, undefined, undefined, undefined, this.project);

      if (!epicWorkItem || !epicWorkItem.relations) {
        console.log(`[unlinkWorkItemsFromEpic] Epic ${epicId} has no relations`);
        return;
      }

      for (const workItemId of workItemIds) {
        // Find the relation index for this work item
        const relationIndex = epicWorkItem.relations.findIndex(
          (rel: any) => 
            rel.rel === 'System.LinkTypes.Hierarchy-Forward' &&
            rel.url?.includes(`/${workItemId}`)
        );

        if (relationIndex === -1) {
          console.log(`[unlinkWorkItemsFromEpic] No relation found between epic ${epicId} and work item ${workItemId}`);
          continue;
        }

        const patchDocument = [
          {
            op: 'remove',
            path: `/relations/${relationIndex}`,
          },
        ];

        await witApi.updateWorkItem(
          {},
          patchDocument,
          epicId,
          this.project
        );

        console.log(`[unlinkWorkItemsFromEpic] Removed link between epic ${epicId} and work item ${workItemId}`);
      }
    });
  }

  /**
   * Delete a work item (soft delete)
   */
  async deleteWorkItem(workItemId: number): Promise<void> {
    return retryWithBackoff(async () => {
      try {
        const witApi = await this.connection.getWorkItemTrackingApi();
        
        console.log(`[deleteWorkItem] Deleting work item ${workItemId}`);
        
        // Azure DevOps performs a soft delete by default
        await witApi.deleteWorkItem(workItemId, this.project);
        
        console.log(`[deleteWorkItem] Successfully deleted work item ${workItemId}`);
      } catch (error) {
        console.error(`[deleteWorkItem] Error deleting work item ${workItemId}:`, error);
        throw error;
      }
    });
  }

  async getPullRequestTimeStats(from?: string, to?: string, developerFilter?: string): Promise<any[]> {
    try {
      console.log('=== AzureDevOpsService.getPullRequestTimeStats START ===');
      console.log('Fetching Git pull requests...', {
        project: this.project,
        areaPath: this.areaPath,
        from,
        to,
        developerFilter
      });

      const gitApi = await this.connection.getGitApi();

      // When an area path is selected, preload all work item IDs under that path with a
      // single WIQL query. This set is used to filter PRs to only those linked to work
      // items that belong to the selected team — no per-PR extra API calls needed.
      let areaPathWorkItemIds: Set<number> | null = null;
      if (this.areaPath) {
        try {
          const witApi = await this.connection.getWorkItemTrackingApi();
          const wiql = `SELECT [System.Id] FROM WorkItems `
            + `WHERE [System.TeamProject] = '${this.project}' `
            + `AND [System.AreaPath] UNDER '${this.areaPath}'`;
          const queryResult = await witApi.queryByWiql({ query: wiql }, { project: this.project });
          areaPathWorkItemIds = new Set(
            (queryResult.workItems ?? []).map(wi => wi.id!).filter(id => id != null)
          );
          console.log(`Area path "${this.areaPath}": preloaded ${areaPathWorkItemIds.size} work item IDs`);
        } catch (err) {
          console.error('Failed to preload work item IDs for area path filter:', err);
          // Fall through without area path filtering rather than returning nothing
          areaPathWorkItemIds = null;
        }
      }

      // Get all repositories in the project
      const repos = await gitApi.getRepositories(this.project);
      console.log(`Found ${repos.length} repositories in ${this.project}`);

      const developerMap = new Map<string, { items: any[], totalTime: number, activeCount: number, completedCount: number }>();
      let totalPRsProcessed = 0;
      let totalPRsSkipped = 0;
      const fromDate = from || '1900-01-01';
      const toDate = to || '2999-12-31';
      const now = new Date();

      // Build date bounds for the ADO search criteria so the API filters server-side.
      // queryTimeRangeType defaults to Created (0), which is exactly what we want.
      const minTime = from ? new Date(`${from}T00:00:00Z`) : undefined;
      const maxTime = to   ? new Date(`${to}T23:59:59Z`)   : undefined;

      for (const repo of repos) {
        if (!repo.id || !repo.name) continue;

        try {
          // Fetch completed PRs within the date range, and all active PRs
          // (active PRs have no close date so we include them regardless and
          //  filter by creation date below).
          const [completedPRs, activePRs] = await Promise.all([
            gitApi.getPullRequests(repo.id, { status: 3 as any, minTime, maxTime } as any, this.project, undefined, undefined, 1000),
            gitApi.getPullRequests(repo.id, { status: 1 as any, minTime } as any, this.project, undefined, undefined, 1000),
          ]);

          const pullRequests = [...completedPRs, ...activePRs];
          console.log(`Repository "${repo.name}": ${completedPRs.length} completed, ${activePRs.length} active PRs`);

          for (const pr of pullRequests) {
            if (!pr.createdBy?.displayName || !pr.creationDate) continue;

            const creator = pr.createdBy.displayName;

            // Handle dates — they might be Date objects or ISO strings
            const createdDateStr = typeof pr.creationDate === 'string' ? pr.creationDate : new Date(pr.creationDate).toISOString();
            const createdDateOnly = createdDateStr.split('T')[0];

            // Secondary guard: keep only PRs whose creation date is within the window
            if (createdDateOnly < fromDate || createdDateOnly > toDate) {
              continue;
            }

            // Apply developer filter
            if (developerFilter && creator !== developerFilter) {
              continue;
            }

            // If an area path is active, check that at least one linked work item
            // belongs to that area path. Uses the preloaded ID set — O(1) per check.
            if (areaPathWorkItemIds !== null && pr.pullRequestId) {
              try {
                const refs = await gitApi.getPullRequestWorkItemRefs(repo.id!, pr.pullRequestId, this.project);
                const hasMatchingWorkItem = (refs ?? []).some(ref => {
                  const id = parseInt(ref.id ?? '', 10);
                  return !isNaN(id) && areaPathWorkItemIds!.has(id);
                });
                if (!hasMatchingWorkItem) {
                  totalPRsSkipped++;
                  continue;
                }
              } catch (refErr) {
                console.warn(`Could not get work item refs for PR #${pr.pullRequestId}:`, refErr);
                // Skip on error to avoid polluting results with unconfirmed PRs
                totalPRsSkipped++;
                continue;
              }
            }

            const isActive = !pr.closedDate;
            const closedDate = isActive ? now : new Date(typeof pr.closedDate === 'string' ? pr.closedDate : new Date(pr.closedDate!).toISOString());
            const exitedDateOnly = isActive ? 'present' : closedDate.toISOString().split('T')[0];

            totalPRsProcessed++;

            // Calculate time in PR: from creation to close (or now for active)
            const timeInDays = (closedDate.getTime() - new Date(createdDateStr).getTime()) / (1000 * 60 * 60 * 24);

            const prUrl = `${this.organization}/${this.project}/_git/${repo.name}/pullrequest/${pr.pullRequestId}`;

            if (!developerMap.has(creator)) {
              developerMap.set(creator, { items: [], totalTime: 0, activeCount: 0, completedCount: 0 });
            }

            const devData = developerMap.get(creator)!;
            devData.items.push({
              id: pr.pullRequestId,
              title: pr.title || `PR #${pr.pullRequestId}`,
              timeInPullRequestDays: Math.round(timeInDays * 10) / 10,
              enteredPullRequestDate: createdDateOnly,
              exitedPullRequestDate: exitedDateOnly,
              prUrl,
              repositoryName: repo.name,
              isActive,
            });
            devData.totalTime += timeInDays;
            if (isActive) {
              devData.activeCount++;
            } else {
              devData.completedCount++;
            }
          }
        } catch (repoError) {
          console.error(`Error fetching PRs for repository ${repo.name}:`, repoError);
        }
      }

      console.log(`Area path filter "${this.areaPath || '(none)'}": included ${totalPRsProcessed}, skipped ${totalPRsSkipped} PRs`);

      console.log(`\nProcessed ${totalPRsProcessed} PRs in date range`);

      // Convert to result format
      const result = Array.from(developerMap.entries()).map(([developer, data]) => ({
        developer,
        totalItemsInPullRequest: data.items.length,
        totalActivePullRequests: data.activeCount,
        totalCompletedPullRequests: data.completedCount,
        averageTimeInPullRequest: data.items.length > 0
          ? Math.round((data.totalTime / data.items.length) * 10) / 10
          : 0,
        totalTimeInPullRequest: Math.round(data.totalTime * 10) / 10,
        workItemDetails: data.items.sort((a, b) => b.timeInPullRequestDays - a.timeInPullRequestDays),
      })).sort((a, b) => b.averageTimeInPullRequest - a.averageTimeInPullRequest);

      console.log('=== AzureDevOpsService.getPullRequestTimeStats RESULT ===');
      console.log(`Returning PR time stats for ${result.length} developers`);
      console.log('Developers:', result.map(r => r.developer));
      console.log('Details:', result.map(r => ({
        developer: r.developer,
        items: r.totalItemsInPullRequest,
        active: r.totalActivePullRequests,
        completed: r.totalCompletedPullRequests,
        avgTime: r.averageTimeInPullRequest
      })));
      return result;
    } catch (error) {
      console.error('Error in getPullRequestTimeStats:', error);
      return [];
    }
  }

  async getPullRequestFeedbackStats(from?: string, to?: string, developerFilter?: string): Promise<any[]> {
    try {
      console.log('=== AzureDevOpsService.getPullRequestFeedbackStats START ===', {
        project: this.project,
        areaPath: this.areaPath,
        from,
        to,
        developerFilter
      });

      const gitApi = await this.connection.getGitApi();

      // Preload work item IDs under the area path so we can filter PRs by team
      let areaPathWorkItemIds: Set<number> | null = null;
      if (this.areaPath) {
        try {
          const witApi = await this.connection.getWorkItemTrackingApi();
          const wiql = `SELECT [System.Id] FROM WorkItems `
            + `WHERE [System.TeamProject] = '${this.project}' `
            + `AND [System.AreaPath] UNDER '${this.areaPath}'`;
          const queryResult = await witApi.queryByWiql({ query: wiql }, { project: this.project });
          areaPathWorkItemIds = new Set(
            (queryResult.workItems ?? []).map(wi => wi.id!).filter(id => id != null)
          );
          console.log(`Area path "${this.areaPath}": preloaded ${areaPathWorkItemIds.size} work item IDs for feedback filter`);
        } catch (err) {
          console.error('Failed to preload work item IDs for area path filter (feedback):', err);
          areaPathWorkItemIds = null;
        }
      }

      const repos = await gitApi.getRepositories(this.project);
      console.log(`Found ${repos.length} repositories in ${this.project}`);

      const fromDate = from || '1900-01-01';
      const toDate = to || '2999-12-31';

      const fbMinTime = from ? new Date(`${from}T00:00:00Z`) : undefined;
      const fbMaxTime = to   ? new Date(`${to}T23:59:59Z`)   : undefined;

      // reviewer → { prDetails, total comments, approvals, rejections }
      type ReviewerData = {
        prDetails: Map<number, {
          prId: number; title: string; prUrl: string; creator: string;
          repositoryName: string; commentsGiven: number; vote: number; createdDate: string;
        }>;
        totalComments: number;
        totalApprovals: number;
        totalRejections: number;
      };
      const reviewerMap = new Map<string, ReviewerData>();

      const ensureReviewer = (name: string) => {
        if (!reviewerMap.has(name)) {
          reviewerMap.set(name, { prDetails: new Map(), totalComments: 0, totalApprovals: 0, totalRejections: 0 });
        }
        return reviewerMap.get(name)!;
      };

      for (const repo of repos) {
        if (!repo.id || !repo.name) continue;

        try {
          const [completedPRs, activePRs] = await Promise.all([
            gitApi.getPullRequests(repo.id, { status: 3 as any, minTime: fbMinTime, maxTime: fbMaxTime } as any, this.project, undefined, undefined, 1000),
            gitApi.getPullRequests(repo.id, { status: 1 as any, minTime: fbMinTime } as any, this.project, undefined, undefined, 1000),
          ]);
          const pullRequests = [...completedPRs, ...activePRs];

          for (const pr of pullRequests) {
            if (!pr.creationDate || !pr.pullRequestId) continue;

            const createdDateStr = typeof pr.creationDate === 'string'
              ? pr.creationDate
              : new Date(pr.creationDate).toISOString();
            const createdDateOnly = createdDateStr.split('T')[0];

            // Secondary guard in case the API returns slightly out-of-range results
            if (createdDateOnly < fromDate || createdDateOnly > toDate) continue;

            // Area path filter: skip PRs not linked to the selected team's work items
            if (areaPathWorkItemIds !== null) {
              try {
                const refs = await gitApi.getPullRequestWorkItemRefs(repo.id!, pr.pullRequestId, this.project);
                const hasMatch = (refs ?? []).some(ref => {
                  const id = parseInt(ref.id ?? '', 10);
                  return !isNaN(id) && areaPathWorkItemIds!.has(id);
                });
                if (!hasMatch) continue;
              } catch {
                continue;
              }
            }

            const prCreator = pr.createdBy?.displayName ?? 'Unknown';
            const prUrl = `${this.organization}/${this.project}/_git/${repo.name}/pullrequest/${pr.pullRequestId}`;

            // Fetch comment threads — count Text (1) and CodeChange (2) comments only.
            // System-generated comments (System = 3) are excluded.
            // Only the first comment in each thread is a top-level review comment;
            // replies are also counted since they represent actual engagement.
            try {
              const threads = await gitApi.getThreads(repo.id!, pr.pullRequestId, this.project);
              for (const thread of threads ?? []) {
                for (const comment of thread.comments ?? []) {
                  const author = comment.author?.displayName;
                  if (!author || author === prCreator) continue; // own-PR comments don't count
                  if (comment.commentType === 3 /* System */) continue; // skip auto-generated entries
                  if (!comment.content?.trim()) continue;
                  if (developerFilter && author !== developerFilter) continue;

                  const rd = ensureReviewer(author);
                  rd.totalComments++;

                  if (!rd.prDetails.has(pr.pullRequestId)) {
                    rd.prDetails.set(pr.pullRequestId, {
                      prId: pr.pullRequestId, title: pr.title ?? `PR #${pr.pullRequestId}`,
                      prUrl, creator: prCreator, repositoryName: repo.name!,
                      commentsGiven: 1, vote: 0, createdDate: createdDateOnly,
                    });
                  } else {
                    rd.prDetails.get(pr.pullRequestId)!.commentsGiven++;
                  }
                }
              }
            } catch { /* thread fetch is best-effort */ }

            // Fetch explicit votes (Approved = 10, Rejected = -10 only).
            // vote = 5 ("Approved with suggestions") is intentionally excluded from
            // the approvals counter because ADO sometimes auto-assigns it when a
            // reviewer leaves a comment, making it indistinguishable from a real vote.
            try {
              const reviewers = await gitApi.getPullRequestReviewers(repo.id!, pr.pullRequestId, this.project);
              for (const reviewer of reviewers ?? []) {
                const name = reviewer.displayName;
                if (!name || name === prCreator) continue;
                if (developerFilter && name !== developerFilter) continue;
                const vote = reviewer.vote ?? 0;
                // Only count definitive approve (10) or reject (-10) votes
                if (vote !== 10 && vote !== -10) continue;

                const rd = ensureReviewer(name);
                if (vote === 10) rd.totalApprovals++;
                if (vote === -10) rd.totalRejections++;

                if (!rd.prDetails.has(pr.pullRequestId)) {
                  rd.prDetails.set(pr.pullRequestId, {
                    prId: pr.pullRequestId, title: pr.title ?? `PR #${pr.pullRequestId}`,
                    prUrl, creator: prCreator, repositoryName: repo.name!,
                    commentsGiven: 0, vote, createdDate: createdDateOnly,
                  });
                } else {
                  rd.prDetails.get(pr.pullRequestId)!.vote = vote;
                }
              }
            } catch { /* vote fetch is best-effort */ }
          }
        } catch (repoError) {
          console.error(`Error fetching feedback stats for repo ${repo.name}:`, repoError);
        }
      }

      const result = Array.from(reviewerMap.entries())
        .map(([developer, data]) => ({
          developer,
          totalPRsReviewed: data.prDetails.size,
          totalCommentsGiven: data.totalComments,
          totalApprovalsGiven: data.totalApprovals,
          totalRejectionsGiven: data.totalRejections,
          prDetails: Array.from(data.prDetails.values())
            .sort((a, b) => b.commentsGiven - a.commentsGiven),
        }))
        .sort((a, b) => b.totalCommentsGiven - a.totalCommentsGiven);

      console.log(`=== getPullRequestFeedbackStats: ${result.length} reviewers found ===`);
      return result;
    } catch (error) {
      console.error('Error in getPullRequestFeedbackStats:', error);
      return [];
    }
  }

  /** PR author + link for correlating agent-evals metrics (project-scoped PR id). */
  async getPullRequestAuthorSnapshot(prId: number): Promise<{
    displayName: string;
    title: string;
    prUrl: string;
    repositoryName: string;
  } | null> {
    try {
      const gitApi = await this.connection.getGitApi();
      const pr = await gitApi.getPullRequestById(prId, this.project);
      if (!pr?.pullRequestId) return null;
      const displayName = pr.createdBy?.displayName;
      if (!displayName) return null;
      const repoName = pr.repository?.name;
      if (!repoName) return null;
      const orgUrl = this.organization.replace(/\/$/, '');
      const prUrl = `${orgUrl}/${encodeURIComponent(this.project)}/_git/${encodeURIComponent(repoName)}/pullrequest/${pr.pullRequestId}`;
      return {
        displayName,
        title: pr.title ?? `PR #${pr.pullRequestId}`,
        prUrl,
        repositoryName: repoName,
      };
    } catch {
      return null;
    }
  }

  async getQABugStats(from?: string, to?: string, developerFilter?: string): Promise<any[]> {
    try {
      console.log('=== AzureDevOpsService.getQABugStats START ===');
      console.log('Fetching PBIs and related bugs...', {
        project: this.project,
        areaPath: this.areaPath,
        from,
        to,
        developerFilter
      });

      const witApi = await this.connection.getWorkItemTrackingApi();

      // Query for PBIs that moved to Done or Ready for Release within the timeframe
      let wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${this.project}' AND [System.WorkItemType] = 'Product Backlog Item'`;

      if (this.areaPath) {
        wiql += ` AND [System.AreaPath] UNDER '${this.areaPath}'`;
      }

      // Filter by state - looking for completed work
      wiql += ` AND ([System.State] = 'Done' OR [System.State] = 'Ready for Release' OR [System.State] = 'Closed')`;

      // Apply date filter on when it was completed/changed
      if (from || to) {
        const fromDate = from || '1900-01-01';
        const toDate = to || '2999-12-31';
        wiql += ` AND [System.ChangedDate] >= '${fromDate}' AND [System.ChangedDate] <= '${toDate}'`;
      }

      wiql += ' ORDER BY [System.ChangedDate] DESC';

      console.log('WIQL Query:', wiql);

      const queryResult = await witApi.queryByWiql(
        { query: wiql },
        { project: this.project }
      );

      if (!queryResult.workItems || queryResult.workItems.length === 0) {
        console.log('No PBIs found');
        return [];
      }

      const ids = queryResult.workItems.map((wi) => wi.id!);
      const maxItems = 200;
      const limitedIds = ids.slice(0, maxItems);
      
      console.log(`Processing ${limitedIds.length} PBIs for bug analysis (out of ${ids.length} total)`);
      console.log(`Checking if work items 39752, 40371 are in the query results...`);
      console.log(`Work item 39752 in results: ${ids.includes(39752)}`);
      console.log(`Work item 39752 in limited batch: ${limitedIds.includes(39752)}`);
      console.log(`Work item 40371 in results: ${ids.includes(40371)}`);
      console.log(`Work item 40371 in limited batch: ${limitedIds.includes(40371)}`);
      if (ids.includes(39752) && !limitedIds.includes(39752)) {
        console.log(`WARNING: Work item 39752 found but excluded by maxItems limit (position ${ids.indexOf(39752) + 1} of ${ids.length})`);
      }
      if (ids.includes(40371) && !limitedIds.includes(40371)) {
        console.log(`WARNING: Work item 40371 found but excluded by maxItems limit (position ${ids.indexOf(40371) + 1} of ${ids.length})`);
      }

      const fields = [
        'System.Id',
        'System.Title',
        'System.CreatedBy',
        'System.AssignedTo',
        'System.CreatedDate',
        'System.State',
      ];

      const developerMap = new Map<string, { pbiCount: number, totalBugs: number, pbiDetails: any[] }>();

      // Process in batches
      const batchSize = 200;
      for (let i = 0; i < limitedIds.length; i += batchSize) {
        const batch = limitedIds.slice(i, i + batchSize);
        const workItems = await witApi.getWorkItems(batch, fields, undefined, undefined, undefined);

        for (const wi of workItems) {
          if (!wi.id || !wi.fields) continue;

          if (wi.id === 40371 || wi.id === 39752) {
            console.log(`=== Processing work item ${wi.id} ===`);
            console.log(`Title: ${wi.fields['System.Title']}`);
            console.log(`State: ${wi.fields['System.State']}`);
            console.log(`AssignedTo:`, wi.fields['System.AssignedTo']);
            console.log(`ChangedDate: ${wi.fields['System.ChangedDate']}`);
          }

          // Get revisions to find who was assigned during "In Progress"
          const revisions = await witApi.getRevisions(wi.id);
          
          let inProgressDeveloper: string | null = null;
          let inProgressDate: string | null = null;
          
          // Look through revisions to find when it was "In Progress" and who was assigned
          for (const revision of revisions) {
            const state = revision.fields?.['System.State'];
            const assignedToField = revision.fields?.['System.AssignedTo'];
            const assignedTo = assignedToField?.displayName || assignedToField;
            const changedDate = revision.fields?.['System.ChangedDate'];
            
            // Check for common in-progress state names
            if ((state === 'In Progress' || state === 'Active' || state === 'Committed') && assignedTo) {
              inProgressDeveloper = typeof assignedTo === 'string' ? assignedTo : assignedTo.displayName || assignedTo.name;
              inProgressDate = changedDate;
              
              if (wi.id === 40371 || wi.id === 39752) {
                console.log(`Found work item ${wi.id} in state ${state} assigned to ${inProgressDeveloper} on ${inProgressDate}`);
              }
              break; // Use the first time it entered an in-progress state
            }
          }
          
          // If we couldn't find from revisions, fall back to current assignedTo if work item is/was in progress
          if (!inProgressDeveloper) {
            const currentState = wi.fields['System.State'];
            const currentAssignedTo = wi.fields['System.AssignedTo']?.displayName;
            
            // Only use current assignedTo if the work item has been in an active state
            if ((currentState === 'In Progress' || currentState === 'Active' || currentState === 'Committed' || 
                 currentState === 'Done' || currentState === 'Closed' || currentState === 'Resolved') && currentAssignedTo) {
              inProgressDeveloper = currentAssignedTo;
              inProgressDate = wi.fields['System.ChangedDate'];
              console.log(`Using current assignedTo for work item ${wi.id}: ${currentAssignedTo} (state: ${currentState})`);
            }
          }
          
          // Skip if we still can't determine who worked on it
          if (!inProgressDeveloper) {
            console.log(`Skipping work item ${wi.id} - no developer found in progress state`);
            continue;
          }
          
          const developer = inProgressDeveloper;

          // Apply developer filter
          if (developerFilter && developer !== developerFilter) {
            if (wi.id === 40371 || wi.id === 39752) {
              console.log(`Work item ${wi.id} FILTERED OUT - developer filter: ${developerFilter}, actual developer: ${developer}`);
            }
            continue;
          }

          if (wi.id === 40371 || wi.id === 39752) {
            console.log(`Work item ${wi.id} - Developer: ${developer}, Date: ${inProgressDate}`);
            console.log(`Work item ${wi.id} passed all filters - proceeding to fetch bugs...`);
          }

          // Get work item relations to find linked bugs
          try {
            const fullWorkItem = await witApi.getWorkItem(wi.id, undefined, undefined, 1 /* WorkItemExpand.Relations */);
            
            if (wi.id === 40371 || wi.id === 39752) {
              console.log(`Work item ${wi.id} - fullWorkItem fetched:`, fullWorkItem ? 'SUCCESS' : 'NULL');
              if (fullWorkItem) {
                console.log(`Work item ${wi.id} - has relations:`, fullWorkItem.relations ? fullWorkItem.relations.length : 0);
              }
            }
            
            // Check if work item exists
            if (!fullWorkItem) {
              console.log(`Work item ${wi.id} not found or inaccessible`);
              continue;
            }
            
            const relations = fullWorkItem.relations || [];

            // Find all related/child bugs
            const bugIds: number[] = [];
            for (const relation of relations) {
              // Check for child or related links
              if (relation.rel === 'System.LinkTypes.Hierarchy-Forward' || 
                  relation.rel === 'System.LinkTypes.Related') {
                const url = relation.url;
                const match = url?.match(/\/workItems\/(\d+)$/);
                if (match) {
                  bugIds.push(parseInt(match[1], 10));
                }
              }
            }

            if (wi.id === 40371 || wi.id === 39752) {
              console.log(`Work item ${wi.id} - Found ${relations.length} relations`);
              console.log(`Work item ${wi.id} - Bug IDs found: ${bugIds.join(', ')}`);
            }

            if (bugIds.length > 0) {
              // Fetch linked work items to filter for bugs
              const linkedItems = await witApi.getWorkItems(bugIds, ['System.WorkItemType', 'System.Title', 'System.State', 'System.Tags']);
              const bugs = linkedItems.filter(item => item.fields?.['System.WorkItemType'] === 'Bug');

              if (wi.id === 40371 || wi.id === 39752) {
                console.log(`Work item ${wi.id} - Fetched ${linkedItems.length} linked items, ${bugs.length} are bugs`);
                console.log(`Work item ${wi.id} - Bug details:`, bugs.map(b => ({ id: b.id, title: b.fields?.['System.Title'] })));
              }

              if (!developerMap.has(developer)) {
                developerMap.set(developer, { pbiCount: 0, totalBugs: 0, pbiDetails: [] });
              }

              const devData = developerMap.get(developer)!;
              devData.pbiCount++;
              devData.totalBugs += bugs.length;
              
              if (bugs.length > 0) {
                devData.pbiDetails.push({
                  id: wi.id,
                  title: wi.fields['System.Title'],
                  bugCount: bugs.length,
                  bugs: bugs.map(bug => ({
                    id: bug.id,
                    title: bug.fields?.['System.Title'],
                    state: bug.fields?.['System.State'],
                  })),
                });
              }
            } else {
              // PBI with no bugs
              if (!developerMap.has(developer)) {
                developerMap.set(developer, { pbiCount: 0, totalBugs: 0, pbiDetails: [] });
              }
              developerMap.get(developer)!.pbiCount++;
            }
          } catch (error) {
            console.error(`Error fetching relations for PBI ${wi.id}:`, error);
          }
        }
      }

      // Convert to result format
      const result = Array.from(developerMap.entries()).map(([developer, data]) => ({
        developer,
        totalPBIs: data.pbiCount,
        totalBugs: data.totalBugs,
        averageBugsPerPBI: data.pbiCount > 0 ? Math.round((data.totalBugs / data.pbiCount) * 10) / 10 : 0,
        pbiDetails: data.pbiDetails.sort((a, b) => b.bugCount - a.bugCount),
      })).sort((a, b) => b.averageBugsPerPBI - a.averageBugsPerPBI);

      console.log('=== AzureDevOpsService.getQABugStats RESULT ===');
      console.log(`Returning QA bug stats for ${result.length} developers`);
      console.log('Developers:', result.map(r => r.developer));
      console.log('Details:', result.map(r => ({
        developer: r.developer,
        pbis: r.totalPBIs,
        bugs: r.totalBugs,
        avgBugs: r.averageBugsPerPBI
      })));
      
      return result;
    } catch (error) {
      console.error('Error in getQABugStats:', error);
      return [];
    }
  }

  async getInProgressTimeStats(from?: string, to?: string, developerFilter?: string): Promise<InProgressTimeStats[]> {
    try {
      console.log('=== AzureDevOpsService.getInProgressTimeStats START ===', { from, to, developerFilter });

      const witApi = await this.connection.getWorkItemTrackingApi();

      let wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${this.project}'`;
      wiql += ` AND [System.WorkItemType] IN ('Technical Backlog Item')`;

      if (this.areaPath) {
        wiql += ` AND [System.AreaPath] UNDER '${this.areaPath}'`;
      }

      if (developerFilter) {
        const escaped = developerFilter.replace(/'/g, "''");
        wiql += ` AND [System.AssignedTo] = '${escaped}'`;
      }

      wiql += ' ORDER BY [System.ChangedDate] DESC';

      const queryResult = await witApi.queryByWiql({ query: wiql }, { project: this.project });

      if (!queryResult.workItems || queryResult.workItems.length === 0) {
        return [];
      }

      const ids = queryResult.workItems.map(wi => wi.id!);
      const limitedIds = developerFilter ? ids : ids.slice(0, 400);
      console.log(`Processing ${limitedIds.length} work items for In Progress time stats`);

      const fromMs = from ? new Date(from).getTime() : 0;
      const toMs   = to   ? new Date(`${to}T23:59:59.999Z`).getTime() : Infinity;
      const now = new Date();

      const developerMap = new Map<string, InProgressTimeStats['workItemDetails']>();

      for (const workItemId of limitedIds) {
        try {
          const revisions = await witApi.getRevisions(workItemId);
          if (!revisions || revisions.length < 2) continue;

          const title = revisions[revisions.length - 1]?.fields?.['System.Title'] || `Work Item ${workItemId}`;
          const workItemType = revisions[revisions.length - 1]?.fields?.['System.WorkItemType'] || 'Unknown';
          const currentAssignee: string =
            (revisions[revisions.length - 1]?.fields?.['System.AssignedTo'] as any)?.displayName ||
            revisions[revisions.length - 1]?.fields?.['System.AssignedTo'] || '';

          // Accumulate all In Progress spans for this work item, then collapse into one entry
          let enteredInProgress: Date | null = null;
          let previousState = '';
          let totalDays = 0;
          let firstEntryDate: string | null = null;
          let lastExitDate: string | null = null;
          let isCurrentlyInProgress = false;
          let developer = developerFilter || currentAssignee || 'Unassigned';

          for (let i = 0; i < revisions.length; i++) {
            const fields = revisions[i].fields;
            if (!fields) continue;

            const state: string = fields['System.State'] || '';
            const changedDate = fields['System.ChangedDate'] ? new Date(fields['System.ChangedDate']) : null;

            const assignedToRaw = fields['System.AssignedTo'];
            const assignee: string =
              (assignedToRaw && typeof assignedToRaw === 'object' && (assignedToRaw as any).displayName)
                ? (assignedToRaw as any).displayName
                : (typeof assignedToRaw === 'string' ? assignedToRaw : currentAssignee);

            if (!changedDate) { previousState = state; continue; }

            if (state === 'In Progress' && previousState !== 'In Progress') {
              enteredInProgress = changedDate;
              if (!developerFilter) developer = assignee || 'Unassigned';
            } else if (state !== 'In Progress' && previousState === 'In Progress' && enteredInProgress) {
              const entered = enteredInProgress;
              const exited = changedDate;

              if (exited.getTime() >= fromMs && entered.getTime() <= toMs) {
                const effectiveEntry = new Date(Math.max(entered.getTime(), fromMs));
                const effectiveExit  = new Date(Math.min(exited.getTime(), toMs));
                const days = (effectiveExit.getTime() - effectiveEntry.getTime()) / (1000 * 60 * 60 * 24);
                totalDays += days;
                if (!firstEntryDate) firstEntryDate = entered.toISOString().split('T')[0];
                lastExitDate = exited.toISOString().split('T')[0];
              }
              enteredInProgress = null;
            }

            // Last revision and still In Progress
            if (i === revisions.length - 1 && state === 'In Progress' && enteredInProgress) {
              const entered = enteredInProgress;
              const effectiveEntry = new Date(Math.max(entered.getTime(), fromMs));
              const effectiveExit  = new Date(Math.min(now.getTime(), toMs));

              if (effectiveExit.getTime() >= fromMs && effectiveEntry.getTime() <= toMs) {
                const days = (effectiveExit.getTime() - effectiveEntry.getTime()) / (1000 * 60 * 60 * 24);
                totalDays += days;
                if (!firstEntryDate) firstEntryDate = entered.toISOString().split('T')[0];
                isCurrentlyInProgress = true;
              }
            }

            previousState = state;
          }

          // Only add the work item if it had any qualifying In Progress time
          if (totalDays > 0 || isCurrentlyInProgress) {
            if (!developerMap.has(developer)) developerMap.set(developer, []);
            developerMap.get(developer)!.push({
              id: workItemId,
              title,
              workItemType,
              daysInProgress: Math.round(totalDays * 10) / 10,
              enteredInProgressDate: firstEntryDate || '',
              exitedInProgressDate: isCurrentlyInProgress ? null : lastExitDate,
              isCurrentlyInProgress,
            });
          }
        } catch (err) {
          console.error(`Error processing work item ${workItemId} for in-progress stats:`, err);
        }
      }

      const result: InProgressTimeStats[] = Array.from(developerMap.entries()).map(([developer, items]) => {
        const totalDays = items.reduce((sum, i) => sum + i.daysInProgress, 0);
        return {
          developer,
          totalItemsInProgress: items.length,
          averageDaysInProgress: items.length > 0 ? Math.round((totalDays / items.length) * 10) / 10 : 0,
          totalDaysInProgress: Math.round(totalDays * 10) / 10,
          workItemDetails: items.sort((a, b) => b.daysInProgress - a.daysInProgress),
        };
      }).sort((a, b) => b.averageDaysInProgress - a.averageDaysInProgress);

      console.log(`Returning In Progress time stats for ${result.length} developers`);
      return result;
    } catch (error) {
      console.error('Error in getInProgressTimeStats:', error);
      return [];
    }
  }

  async getQACycleTimeStats(from?: string, to?: string, qaFilter?: string): Promise<QACycleTimeStats[]> {
    try {
      console.log('=== AzureDevOpsService.getQACycleTimeStats START ===', { from, to, qaFilter });

      const witApi = await this.connection.getWorkItemTrackingApi();

      let wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${this.project}'`;
      wiql += ` AND [System.WorkItemType] IN ('Product Backlog Item', 'Technical Backlog Item', 'Bug')`;

      if (this.areaPath) {
        wiql += ` AND [System.AreaPath] UNDER '${this.areaPath}'`;
      }

      wiql += ' ORDER BY [System.ChangedDate] DESC';

      const queryResult = await witApi.queryByWiql({ query: wiql }, { project: this.project });

      if (!queryResult.workItems || queryResult.workItems.length === 0) {
        return [];
      }

      const ids = queryResult.workItems.map(wi => wi.id!);
      const limitedIds = qaFilter ? ids : ids.slice(0, 500);
      console.log(`Processing ${limitedIds.length} work items for QA cycle time stats`);

      const fromMs = from ? new Date(from).getTime() : 0;
      const toMs   = to   ? new Date(`${to}T23:59:59.999Z`).getTime() : Infinity;

      const qaMap = new Map<string, QACycleTimeStats['workItemDetails']>();

      const IN_TEST_STATE = 'In Test';
      const EXIT_STATES = new Set(['Done', 'UAT - Ready For Test', 'Closed']);

      for (const workItemId of limitedIds) {
        try {
          const revisions = await witApi.getRevisions(workItemId);
          if (!revisions || revisions.length < 2) continue;

          const lastRevision = revisions[revisions.length - 1];
          const title: string = lastRevision?.fields?.['System.Title'] || `Work Item ${workItemId}`;
          const workItemType: string = lastRevision?.fields?.['System.WorkItemType'] || 'Unknown';

          // Walk revisions looking for In Test → Done/UAT transitions
          let enteredInTest: Date | null = null;
          let qaAssigneeAtInTest: string | null = null;
          let previousState = '';

          for (let i = 0; i < revisions.length; i++) {
            const fields = revisions[i].fields;
            if (!fields) { previousState = ''; continue; }

            const state: string = fields['System.State'] || '';
            const changedDate = fields['System.ChangedDate'] ? new Date(fields['System.ChangedDate']) : null;
            if (!changedDate) { previousState = state; continue; }

            const assignedToRaw = fields['System.AssignedTo'];
            const assignee: string =
              (assignedToRaw && typeof assignedToRaw === 'object' && (assignedToRaw as any).displayName)
                ? (assignedToRaw as any).displayName
                : (typeof assignedToRaw === 'string' ? assignedToRaw : '');

            // Entering In Test
            if (state === IN_TEST_STATE && previousState !== IN_TEST_STATE) {
              enteredInTest = changedDate;
              qaAssigneeAtInTest = assignee || null;
            }

            // Leaving In Test to an exit state
            if (previousState === IN_TEST_STATE && EXIT_STATES.has(state) && enteredInTest) {
              const entered = enteredInTest;
              const exited = changedDate;

              // Only include if the span overlaps with the requested date range
              if (exited.getTime() >= fromMs && entered.getTime() <= toMs) {
                const effectiveEntry = new Date(Math.max(entered.getTime(), fromMs));
                const effectiveExit  = new Date(Math.min(exited.getTime(), toMs));
                const days = Math.round(
                  ((effectiveExit.getTime() - effectiveEntry.getTime()) / (1000 * 60 * 60 * 24)) * 10
                ) / 10;

                const qaAssignee = qaAssigneeAtInTest || 'Unassigned';

                if (!qaFilter || qaAssignee === qaFilter) {
                  if (!qaMap.has(qaAssignee)) qaMap.set(qaAssignee, []);
                  qaMap.get(qaAssignee)!.push({
                    id: workItemId,
                    title,
                    workItemType,
                    cycleTimeDays: days,
                    enteredInTestDate: entered.toISOString().split('T')[0],
                    exitedInTestDate: exited.toISOString().split('T')[0],
                    exitState: state,
                  });
                }
              }

              enteredInTest = null;
              qaAssigneeAtInTest = null;
            }

            previousState = state;
          }
        } catch (err) {
          console.error(`Error processing work item ${workItemId} for QA cycle time:`, err);
        }
      }

      const result: QACycleTimeStats[] = Array.from(qaMap.entries()).map(([qaAssignee, items]) => {
        const totalDays = items.reduce((sum, i) => sum + i.cycleTimeDays, 0);
        return {
          qaAssignee,
          totalItems: items.length,
          averageCycleTimeDays: items.length > 0 ? Math.round((totalDays / items.length) * 10) / 10 : 0,
          totalCycleTimeDays: Math.round(totalDays * 10) / 10,
          workItemDetails: items.sort((a, b) => b.cycleTimeDays - a.cycleTimeDays),
        };
      }).sort((a, b) => b.averageCycleTimeDays - a.averageCycleTimeDays);

      console.log(`=== getQACycleTimeStats returning ${result.length} QA members ===`);
      return result;
    } catch (error) {
      console.error('Error in getQACycleTimeStats:', error);
      return [];
    }
  }

  async getUATCycleTimeStats(from?: string, to?: string, assigneeFilter?: string): Promise<UATCycleTimeStats[]> {
    try {
      console.log('=== AzureDevOpsService.getUATCycleTimeStats START ===', { from, to, assigneeFilter });

      const witApi = await this.connection.getWorkItemTrackingApi();

      let wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${this.project}'`;
      wiql += ` AND [System.WorkItemType] IN ('Product Backlog Item', 'Technical Backlog Item', 'Bug')`;
      if (this.areaPath) {
        wiql += ` AND [System.AreaPath] UNDER '${this.areaPath}'`;
      }
      wiql += ' ORDER BY [System.ChangedDate] DESC';

      const queryResult = await witApi.queryByWiql({ query: wiql }, { project: this.project });
      if (!queryResult.workItems || queryResult.workItems.length === 0) return [];

      const ids = queryResult.workItems.map(wi => wi.id!);
      const limitedIds = assigneeFilter ? ids : ids.slice(0, 500);
      console.log(`Processing ${limitedIds.length} work items for UAT cycle time stats`);

      const fromMs = from ? new Date(from).getTime() : 0;
      const toMs   = to   ? new Date(`${to}T23:59:59.999Z`).getTime() : Infinity;

      const uatMap = new Map<string, UATCycleTimeStats['workItemDetails']>();

      const UAT_ENTRY_STATE = 'UAT - Ready For Test';
      const UAT_EXIT_STATE  = 'UAT - Test Done';

      for (const workItemId of limitedIds) {
        try {
          const revisions = await witApi.getRevisions(workItemId);
          if (!revisions || revisions.length < 2) continue;

          const lastRevision = revisions[revisions.length - 1];
          const title: string = lastRevision?.fields?.['System.Title'] || `Work Item ${workItemId}`;
          const workItemType: string = lastRevision?.fields?.['System.WorkItemType'] || 'Unknown';

          let enteredUATReady: Date | null = null;
          // Captured when the item first enters UAT - Ready For Test; this is the grouping key
          let uatEntryAssignee: string = '';
          let previousState = '';

          for (let i = 0; i < revisions.length; i++) {
            const fields = revisions[i].fields;
            if (!fields) { previousState = ''; continue; }

            const state: string = fields['System.State'] || '';
            const changedDate = fields['System.ChangedDate'] ? new Date(fields['System.ChangedDate']) : null;
            if (!changedDate) { previousState = state; continue; }

            const assignedToRaw = fields['System.AssignedTo'];
            const revisionAssignee: string =
              (assignedToRaw && typeof assignedToRaw === 'object' && (assignedToRaw as any).displayName)
                ? (assignedToRaw as any).displayName
                : (typeof assignedToRaw === 'string' ? assignedToRaw : '');

            // Capture the assignee at the moment the item enters UAT - Ready For Test
            if (state === UAT_ENTRY_STATE && previousState !== UAT_ENTRY_STATE) {
              enteredUATReady = changedDate;
              uatEntryAssignee = revisionAssignee || 'Unassigned';
            }

            if (previousState === UAT_ENTRY_STATE && state === UAT_EXIT_STATE && enteredUATReady) {
              const entered = enteredUATReady;
              const exited  = changedDate;

              if (exited.getTime() >= fromMs && entered.getTime() <= toMs) {
                const effectiveEntry = new Date(Math.max(entered.getTime(), fromMs));
                const effectiveExit  = new Date(Math.min(exited.getTime(), toMs));
                const days = Math.round(
                  ((effectiveExit.getTime() - effectiveEntry.getTime()) / (1000 * 60 * 60 * 24)) * 10
                ) / 10;

                const groupKey = uatEntryAssignee || 'Unassigned';
                if (!assigneeFilter || groupKey === assigneeFilter) {
                  if (!uatMap.has(groupKey)) uatMap.set(groupKey, []);
                  uatMap.get(groupKey)!.push({
                    id: workItemId,
                    title,
                    workItemType,
                    cycleTimeDays: days,
                    enteredUATReadyDate: entered.toISOString().split('T')[0],
                    exitedUATReadyDate: exited.toISOString().split('T')[0],
                  });
                }
              }

              enteredUATReady = null;
              uatEntryAssignee = '';
            }

            previousState = state;
          }
        } catch (err) {
          console.error(`Error processing work item ${workItemId} for UAT cycle time:`, err);
        }
      }

      const result: UATCycleTimeStats[] = Array.from(uatMap.entries()).map(([assignee, items]) => {
        const totalDays = items.reduce((sum, i) => sum + i.cycleTimeDays, 0);
        return {
          assignee,
          totalItems: items.length,
          averageCycleTimeDays: items.length > 0 ? Math.round((totalDays / items.length) * 10) / 10 : 0,
          totalCycleTimeDays: Math.round(totalDays * 10) / 10,
          workItemDetails: items.sort((a, b) => b.cycleTimeDays - a.cycleTimeDays),
        };
      }).sort((a, b) => b.averageCycleTimeDays - a.averageCycleTimeDays);

      console.log(`=== getUATCycleTimeStats returning ${result.length} assignees ===`);
      return result;
    } catch (error) {
      console.error('Error in getUATCycleTimeStats:', error);
      return [];
    }
  }

  async getUATSittingStats(): Promise<UATSittingItem[]> {
    try {
      console.log('=== AzureDevOpsService.getUATSittingStats START ===');

      const witApi = await this.connection.getWorkItemTrackingApi();

      // Only items currently in UAT - Ready For Test
      let wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${this.project}'`;
      wiql += ` AND [System.State] = 'UAT - Ready For Test'`;
      wiql += ` AND [System.WorkItemType] IN ('Product Backlog Item', 'Technical Backlog Item', 'Bug')`;
      if (this.areaPath) {
        wiql += ` AND [System.AreaPath] UNDER '${this.areaPath}'`;
      }
      wiql += ' ORDER BY [System.ChangedDate] ASC';

      const queryResult = await witApi.queryByWiql({ query: wiql }, { project: this.project });
      if (!queryResult.workItems || queryResult.workItems.length === 0) return [];

      const ids = queryResult.workItems.map(wi => wi.id!);
      console.log(`Found ${ids.length} items currently in UAT - Ready For Test`);

      const now = new Date();
      const results: UATSittingItem[] = [];

      for (const workItemId of ids) {
        try {
          const revisions = await witApi.getRevisions(workItemId);
          if (!revisions || revisions.length === 0) continue;

          const lastRevision = revisions[revisions.length - 1];
          const title: string = lastRevision?.fields?.['System.Title'] || `Work Item ${workItemId}`;
          const workItemType: string = lastRevision?.fields?.['System.WorkItemType'] || 'Unknown';
          const assignedToRaw = lastRevision?.fields?.['System.AssignedTo'];
          const assignedTo: string =
            (assignedToRaw && typeof assignedToRaw === 'object' && (assignedToRaw as any).displayName)
              ? (assignedToRaw as any).displayName
              : (typeof assignedToRaw === 'string' ? assignedToRaw : 'Unassigned');

          // Find the most recent time it entered UAT - Ready For Test
          let lastEnteredUATReady: Date | null = null;
          let previousState = '';
          for (const revision of revisions) {
            const state: string = revision.fields?.['System.State'] || '';
            const changedDate = revision.fields?.['System.ChangedDate']
              ? new Date(revision.fields['System.ChangedDate'])
              : null;
            if (state === 'UAT - Ready For Test' && previousState !== 'UAT - Ready For Test' && changedDate) {
              lastEnteredUATReady = changedDate;
            }
            previousState = state;
          }

          if (lastEnteredUATReady) {
            const daysSitting = Math.round(
              ((now.getTime() - lastEnteredUATReady.getTime()) / (1000 * 60 * 60 * 24)) * 10
            ) / 10;
            results.push({
              id: workItemId,
              title,
              workItemType,
              assignedTo,
              enteredUATReadyDate: lastEnteredUATReady.toISOString().split('T')[0],
              daysSitting,
            });
          }
        } catch (err) {
          console.error(`Error processing work item ${workItemId} for UAT sitting stats:`, err);
        }
      }

      // Sort by longest sitting first
      results.sort((a, b) => b.daysSitting - a.daysSitting);
      console.log(`=== getUATSittingStats returning ${results.length} items ===`);
      return results;
    } catch (error) {
      console.error('Error in getUATSittingStats:', error);
      return [];
    }
  }

  async getAIWorkItemHealthMetrics(from?: string, to?: string): Promise<AIWorkItemHealthSummary> {
    const empty: AIWorkItemHealthSummary = {
      totalItems: 0,
      aggregateScore: 0,
      avgDevTimeDays: 0,
      medianDevTimeDays: 0,
      avgBugCount: 0,
      avgFullCycleTimeDays: 0,
      reworkRate: 0,
      firstPassRate: 0,
      itemsWithZeroBugs: 0,
      items: [],
    };

    try {
      console.log('=== AzureDevOpsService.getAIWorkItemHealthMetrics START ===', { from, to });

      const witApi = await this.connection.getWorkItemTrackingApi();

      let wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${this.project}'`;
      wiql += ` AND ([System.WorkItemType] = 'Product Backlog Item' OR [System.WorkItemType] = 'Technical Backlog Item' OR [System.WorkItemType] = 'Bug')`;
      wiql += ` AND [System.Tags] CONTAINS 'ai-code'`;
      wiql += ` AND [System.State] <> 'Removed'`;

      if (this.areaPath) {
        wiql += ` AND [System.AreaPath] UNDER '${this.areaPath}'`;
      }

      if (from || to) {
        const fromDate = from || '1900-01-01';
        const toDate = to || '2999-12-31';
        wiql += ` AND [System.ChangedDate] >= '${fromDate}' AND [System.ChangedDate] <= '${toDate}'`;
      }

      wiql += ' ORDER BY [System.ChangedDate] DESC';

      const queryResult = await witApi.queryByWiql({ query: wiql }, { project: this.project });

      if (!queryResult.workItems || queryResult.workItems.length === 0) {
        console.log('No ai-code tagged work items found');
        return empty;
      }

      const ids = queryResult.workItems.map(wi => wi.id!).slice(0, 300);
      console.log(`Processing ${ids.length} ai-code tagged work items`);

      // SDLC state ordering — used to detect rework (backward transitions)
      const STATE_RANK: Record<string, number> = {
        'New': 0,
        'Active': 1,
        'Committed': 1,
        'In Progress': 1,
        'In Pull Request': 2,
        'Ready For Test': 3,
        'Ready for Test': 3,
        'In Test': 4,
        'UAT - Ready For Test': 5,
        'UAT - Test Done': 6,
        'Ready For Release': 7,
        'Done': 8,
        'Closed': 8,
        'Resolved': 8,
      };

      /** First-pass % is only computed once an item is shipped / terminal (not still in dev or test). */
      const FIRST_PASS_ELIGIBLE_STATES = new Set<string>([
        'Ready For Release',
        'Done',
        'Closed',
        'Resolved', // common terminal state for Bugs
      ]);

      const items: AIWorkItemMetric[] = [];

      for (const workItemId of ids) {
        try {
          const revisions = await witApi.getRevisions(workItemId);
          if (!revisions || revisions.length < 2) continue;

          const lastRev = revisions[revisions.length - 1];
          const title: string = lastRev?.fields?.['System.Title'] || `Work Item ${workItemId}`;
          const workItemType: string = lastRev?.fields?.['System.WorkItemType'] || 'Unknown';
          const assignedToRaw = lastRev?.fields?.['System.AssignedTo'];
          const assignedTo: string =
            (assignedToRaw && typeof assignedToRaw === 'object' && (assignedToRaw as any).displayName)
              ? (assignedToRaw as any).displayName
              : (typeof assignedToRaw === 'string' ? assignedToRaw : 'Unassigned');

          // Walk revisions to gather state transition timestamps
          let inProgressDate: Date | null = null;
          let inPullRequestDate: Date | null = null;
          let uatReadyDate: Date | null = null;
          let highestRankSeen = -1;
          let hasRework = false;
          let previousState = '';

          for (const rev of revisions) {
            const fields = rev.fields;
            if (!fields) continue;

            const state: string = fields['System.State'] || '';
            const changedDate = fields['System.ChangedDate'] ? new Date(fields['System.ChangedDate']) : null;
            if (!changedDate) { previousState = state; continue; }

            const rank = STATE_RANK[state] ?? -1;

            // Detect rework: item reached In Test (rank 4) or later, then regressed back
            // to In Pull Request (rank 2) or earlier — meaning it failed testing and went back
            if (highestRankSeen >= 4 && rank >= 0 && rank <= 2) {
              hasRework = true;
            }
            if (rank > highestRankSeen) highestRankSeen = rank;

            if (state === 'In Progress' && previousState !== 'In Progress' && !inProgressDate) {
              inProgressDate = changedDate;
            }

            if (state === 'In Pull Request' && previousState !== 'In Pull Request' && !inPullRequestDate) {
              inPullRequestDate = changedDate;
            }

            if (
              (state === 'UAT - Ready For Test') &&
              previousState !== 'UAT - Ready For Test' &&
              !uatReadyDate
            ) {
              uatReadyDate = changedDate;
            }

            previousState = state;
          }

          // Compute timing metrics
          const devTimeDays =
            inProgressDate && inPullRequestDate
              ? Math.round(
                  ((inPullRequestDate.getTime() - inProgressDate.getTime()) / (1000 * 60 * 60 * 24)) * 10
                ) / 10
              : null;

          const fullCycleTimeDays =
            inProgressDate && uatReadyDate
              ? Math.round(
                  ((uatReadyDate.getTime() - inProgressDate.getTime()) / (1000 * 60 * 60 * 24)) * 10
                ) / 10
              : null;

          // Fetch linked bugs via relations
          let bugCount = 0;
          const bugList: Array<{ id: number; title: string; state: string }> = [];
          try {
            const fullItem = await witApi.getWorkItem(workItemId, undefined, undefined, WorkItemExpand.Relations);
            const relations = fullItem?.relations || [];
            const candidateIds: number[] = [];
            for (const rel of relations) {
              if (rel.rel === 'System.LinkTypes.Hierarchy-Forward') {
                const match = rel.url?.match(/\/workItems\/(\d+)$/);
                if (match) candidateIds.push(parseInt(match[1], 10));
              }
            }
            if (candidateIds.length > 0) {
              const linked = await witApi.getWorkItems(
                candidateIds,
                ['System.WorkItemType', 'System.Title', 'System.State', 'System.Tags']
              );
              for (const li of linked) {
                if (li.fields?.['System.WorkItemType'] === 'Bug') {
                  const bugState: string = li.fields?.['System.State'] || '';
                  const bugTags: string = li.fields?.['System.Tags'] || '';
                  const isDeferred =
                    bugState.toLowerCase() === 'deferred' ||
                    bugTags.toLowerCase().includes('deferred');
                  if (isDeferred) continue;
                  bugList.push({
                    id: li.id!,
                    title: li.fields?.['System.Title'] || '',
                    state: bugState,
                  });
                }
              }
              bugCount = bugList.length;
            }
          } catch (relErr) {
            console.error(`Error fetching relations for work item ${workItemId}:`, relErr);
          }

          const currentState: string = (lastRev.fields?.['System.State'] as string) || '';
          const isFirstPassEvaluated = FIRST_PASS_ELIGIBLE_STATES.has(currentState);
          const isFirstPassSuccess = isFirstPassEvaluated && bugCount === 0 && !hasRework;

          items.push({
            id: workItemId,
            title,
            workItemType,
            assignedTo,
            state: currentState,
            devTimeDays,
            bugCount,
            fullCycleTimeDays,
            hasRework,
            isFirstPassEvaluated,
            isFirstPassSuccess,
            inProgressDate: inProgressDate ? inProgressDate.toISOString().split('T')[0] : null,
            inPullRequestDate: inPullRequestDate ? inPullRequestDate.toISOString().split('T')[0] : null,
            uatReadyDate: uatReadyDate ? uatReadyDate.toISOString().split('T')[0] : null,
            bugs: bugList,
          });
        } catch (err) {
          console.error(`Error processing ai-code work item ${workItemId}:`, err);
        }
      }

      if (items.length === 0) return empty;

      // --- Aggregate metrics ---
      const devTimes = items.map(i => i.devTimeDays).filter((d): d is number => d !== null);
      const cycleTimes = items.map(i => i.fullCycleTimeDays).filter((d): d is number => d !== null);

      const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
      const median = (arr: number[]) => {
        if (!arr.length) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      };

      const avgDevTimeDays = Math.round(avg(devTimes) * 10) / 10;
      const medianDevTimeDays = Math.round(median(devTimes) * 10) / 10;
      const avgBugCount = Math.round(avg(items.map(i => i.bugCount)) * 10) / 10;
      const avgFullCycleTimeDays = Math.round(avg(cycleTimes) * 10) / 10;
      const reworkRate = Math.round((items.filter(i => i.hasRework).length / items.length) * 100) / 100;
      const firstPassEligible = items.filter(i => i.isFirstPassEvaluated);
      const firstPassRate =
        firstPassEligible.length > 0
          ? Math.round(
              (firstPassEligible.filter(i => i.isFirstPassSuccess).length / firstPassEligible.length) * 100
            ) / 100
          : 0;
      const itemsWithZeroBugs = items.filter(i => i.bugCount === 0).length;

      // --- Aggregate health score (0-100) ---
      // Weights: Dev Time 20%, Bugs 25%, Cycle Time 20%, Rework 15%, First-Pass 20%
      const scoreDevTime = devTimes.length
        ? Math.max(0, Math.min(100, 100 - Math.max(0, avgDevTimeDays - 2) * (100 / 13)))
        : 50; // neutral when no data
      const scoreBugs = Math.max(0, 100 - avgBugCount * 20);
      const scoreCycleTime = cycleTimes.length
        ? Math.max(0, Math.min(100, 100 - Math.max(0, avgFullCycleTimeDays - 5) * (100 / 25)))
        : 50;
      const scoreRework = Math.round((1 - reworkRate) * 100);
      const scoreFirstPass =
        firstPassEligible.length > 0 ? Math.round(firstPassRate * 100) : 50; // neutral until items ship

      const aggregateScore = Math.round(
        scoreDevTime * 0.20 +
        scoreBugs * 0.25 +
        scoreCycleTime * 0.20 +
        scoreRework * 0.15 +
        scoreFirstPass * 0.20
      );

      const summary: AIWorkItemHealthSummary = {
        totalItems: items.length,
        aggregateScore,
        avgDevTimeDays,
        medianDevTimeDays,
        avgBugCount,
        avgFullCycleTimeDays,
        reworkRate,
        firstPassRate,
        itemsWithZeroBugs,
        items,
      };

      console.log(`=== getAIWorkItemHealthMetrics RESULT: ${items.length} items, score=${aggregateScore} ===`);
      return summary;
    } catch (error) {
      console.error('Error in getAIWorkItemHealthMetrics:', error);
      return empty;
    }
  }

  async getAiCodeWorkItemAdoptionStats(
    from: string,
    to: string,
    teamMembers: string[] = [],
  ): Promise<AiCodeWorkItemAdoptionSummary> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();

      // Population mirrors the saved ADO query used for the 259 denominator:
      //   - WorkItemType NOT IN ('Epic', 'Feature', 'Task', 'Bug') → PBI + TBI only
      //   - ever [System.State] = 'In Progress'  → item was activated at some point
      //   - ChangedDate within the caller-supplied window
      // Numerator (ai-code): only Product Backlog Items with the ai-code tag are counted
      // (mirrors the saved ADO query for the 27 numerator).
      let wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${this.project}' AND [System.WorkItemType] NOT IN ('Epic', 'Feature', 'Task', 'Bug', 'Technical Backlog Item')`;
      if (this.areaPath) {
        wiql += ` AND [System.AreaPath] UNDER '${this.areaPath}'`;
      }
      wiql += ` AND [System.ChangedDate] >= '${from}' AND [System.ChangedDate] <= '${to}'`;
      wiql += ` AND EVER [System.State] = 'In Progress'`;
      wiql += ` ORDER BY [System.ChangedDate] DESC`;

      const queryResult = await witApi.queryByWiql({ query: wiql }, { project: this.project });
      const ids = (queryResult.workItems ?? []).map(wi => wi.id!).filter(Boolean);

      const memberSet = new Set(teamMembers.map(m => m.toLowerCase().trim()));
      const hasTeamFilter = memberSet.size > 0;

      const hasAiCodeTag = (tags: unknown): boolean =>
        String(tags ?? '').split(';').map(t => t.trim().toLowerCase()).includes('ai-code');

      const identityDisplayName = (identity: unknown): string | undefined => {
        if (!identity) return undefined;
        if (typeof identity === 'string') return identity;
        if (typeof identity === 'object') {
          const obj = identity as { displayName?: string; uniqueName?: string; name?: string };
          return obj.displayName ?? obj.uniqueName ?? obj.name;
        }
        return undefined;
      };

      const developerMap = new Map<string, { totalWorkItems: number; aiCodeWorkItems: number }>();
      let totalWorkItems = 0;
      let aiCodeWorkItems = 0;

      const batchSize = 200;
      for (let i = 0; i < ids.length; i += batchSize) {
        const batch = ids.slice(i, i + batchSize);
        const workItems = await witApi.getWorkItems(batch, [
          'System.Tags',
          'System.WorkItemType',
          'System.AssignedTo',
          'System.State',
        ]);

        for (const wi of workItems) {
          if (!wi?.id || !wi.fields) continue;

          // Numerator counts only PBIs with ai-code tag (mirrors the ADO numerator query).
          const isPbi = wi.fields['System.WorkItemType'] === 'Product Backlog Item';
          const itemHasAiCode = isPbi && hasAiCodeTag(wi.fields['System.Tags']);

          // Attribute to current assignee — mirrors EVER [System.AssignedTo] semantics used
          // in the per-developer ADO query (the current assignee is the one responsible for
          // tagging the item). This avoids an expensive per-item revision-history fetch.
          const developer = identityDisplayName(wi.fields['System.AssignedTo']);

          // Total counts include every item in the population (with or without ai-code tag)
          totalWorkItems += 1;
          if (itemHasAiCode) aiCodeWorkItems += 1;

          // Per-developer counts are scoped to team members only
          if (developer) {
            const normalized = developer.toLowerCase().trim();
            if (!hasTeamFilter || memberSet.has(normalized)) {
              const cur = developerMap.get(developer) ?? { totalWorkItems: 0, aiCodeWorkItems: 0 };
              cur.totalWorkItems += 1;
              if (itemHasAiCode) cur.aiCodeWorkItems += 1;
              developerMap.set(developer, cur);
            }
          }
        }
      }

      const developerAdoption = Array.from(developerMap.entries())
        .map(([developer, stats]) => ({
          developer,
          totalAssignedWorkItems: stats.totalWorkItems,
          aiCodeWorkItems: stats.aiCodeWorkItems,
          adoptionRate: stats.totalWorkItems > 0 ? stats.aiCodeWorkItems / stats.totalWorkItems : 0,
        }))
        .sort((a, b) => a.adoptionRate - b.adoptionRate || b.totalAssignedWorkItems - a.totalAssignedWorkItems);

      return {
        totalAssignedWorkItems: totalWorkItems,
        aiCodeWorkItems,
        adoptionRate: totalWorkItems > 0 ? aiCodeWorkItems / totalWorkItems : null,
        developerAdoption,
      };
    });
  }

  async getDesignDocKickoffStats(from?: string, to?: string, developerFilter?: string): Promise<DesignDocKickoffStats[]> {
    try {
      console.log('=== AzureDevOpsService.getDesignDocKickoffStats START ===', { from, to, developerFilter });

      const gitApi = await this.connection.getGitApi();
      const witApi = await this.connection.getWorkItemTrackingApi();

      const streamToString = (stream: NodeJS.ReadableStream): Promise<string> =>
        new Promise((resolve, reject) => {
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer | string) =>
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          );
          stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
          stream.on('error', reject);
        });

      // Find the MaxView repository
      const repos = await gitApi.getRepositories(this.project);
      console.log(`Found ${repos.length} repositories in project '${this.project}':`, repos.map(r => r.name));
      const maxViewRepo = repos.find(r => r.name === 'MaxView');
      if (!maxViewRepo?.id) {
        console.log('MaxView repository not found in project', this.project, '— available repos:', repos.map(r => r.name));
        return [];
      }
      console.log(`Using repo: ${maxViewRepo.name} (${maxViewRepo.id})`);
      const repoId = maxViewRepo.id;

      // List all items under /design-doc recursively (120 = Full recursion)
      let designDocItems: any[] = [];
      try {
        designDocItems = await gitApi.getItems(
          repoId,
          this.project,
          '/design-doc',
          120 as any, // VersionControlRecursionType.Full
          true,
          false,
        ) || [];
      } catch (err) {
        console.log('Could not list design-doc/ items (folder may not exist):', (err as Error).message);
        return [];
      }

      console.log(`getItems returned ${designDocItems.length} items under /design-doc`);
      if (designDocItems.length > 0) {
        console.log('Sample item (first):', JSON.stringify(designDocItems[0]));
      }

      // gitObjectType may be the enum number (3 = blob) OR the string 'blob' depending on
      // the azure-devops-node-api version — filter by isFolder=false and path ending in .md
      // to avoid relying on the gitObjectType representation.
      const mdFiles = designDocItems.filter(
        (item: any) =>
          typeof item.path === 'string' &&
          item.path.toLowerCase().endsWith('.md') &&
          item.isFolder !== true
      );
      console.log(`Found ${mdFiles.length} markdown files in /design-doc (total items: ${designDocItems.length})`);

      // For each .md file: read content and get latest commit date
      const wiIdToFile = new Map<number, { filePath: string; commitDate: string }>();
      const CONCURRENCY = 5;

      for (let i = 0; i < mdFiles.length; i += CONCURRENCY) {
        const batch = mdFiles.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (item: any) => {
          try {
            console.log(`Processing design-doc file: ${item.path}`);

            const [contentStream, commits] = await Promise.all([
              gitApi.getItemContent(repoId, item.path, this.project),
              gitApi.getCommits(repoId, { itemPath: item.path, $top: 1 }, this.project),
            ]);
            const content = await streamToString(contentStream as any);
            const commitDate = commits?.[0]?.author?.date
              ? new Date(commits[0].author!.date!).toISOString().split('T')[0]
              : new Date().toISOString().split('T')[0];

            console.log(`  commitDate=${commitDate}, contentLength=${content.length}`);

            // Extract work item ID from the markdown table: [45681](https://.../_workitems/edit/45681)
            const match = content.match(/_workitems\/edit\/(\d+)/i);
            if (!match) {
              console.log(`  No WI ID found in ${item.path}`);
              return;
            }
            const wiId = parseInt(match[1], 10);
            if (!isNaN(wiId)) {
              console.log(`  Mapped WI #${wiId} → ${item.path} (${commitDate})`);
              wiIdToFile.set(wiId, { filePath: item.path, commitDate });
            }
          } catch (err) {
            console.log(`Error processing design-doc file ${item.path}:`, (err as Error).message);
          }
        }));
      }

      console.log(`Extracted ${wiIdToFile.size} unique work item IDs from design-doc files`);
      if (wiIdToFile.size === 0) return [];

      // Apply time-frame filter on commit date
      const fromDate = from || '1900-01-01';
      const toDate = to || '2999-12-31';

      const filteredWiIds: number[] = [];
      for (const [wiId, { commitDate }] of wiIdToFile.entries()) {
        if (commitDate >= fromDate && commitDate <= toDate) {
          filteredWiIds.push(wiId);
        }
      }
      console.log(`${filteredWiIds.length} kickoff events within the date window`);
      if (filteredWiIds.length === 0) return [];

      // Fetch the referenced work items with relations to find linked PRs.
      // ADO rejects requests that have BOTH a fields list and an expand parameter —
      // pass undefined for fields so Relations expand is honoured.
      let kickoffItems: any[] = [];
      const batchSize = 200;
      for (let i = 0; i < filteredWiIds.length; i += batchSize) {
        const batch = filteredWiIds.slice(i, i + batchSize);
        const items = await witApi.getWorkItems(
          batch,
          undefined,          // cannot combine fields with expand
          undefined,
          WorkItemExpand.Relations,
        );
        kickoffItems.push(...items.filter(wi => wi != null));
      }

      // Restrict to PBI/TBI/Bug
      const allowedTypes = new Set(['Product Backlog Item', 'Technical Backlog Item', 'Bug']);
      kickoffItems = kickoffItems.filter(wi =>
        allowedTypes.has(wi.fields?.['System.WorkItemType'])
      );

      // Parse PR artifact links from each work item's relations
      const wiToPrId = new Map<number, number>();
      for (const wi of kickoffItems) {
        if (!wi.id || !wi.relations) continue;
        for (const rel of wi.relations) {
          if (rel.rel !== 'ArtifactLink') continue;
          const relName: string = rel.attributes?.name ?? '';
          if (!relName.toLowerCase().includes('pull request')) continue;
          // URL: vstfs:///Git/PullRequestId/org%2Fproject%2Frepo%2F{prId}
          try {
            const decoded = decodeURIComponent(rel.url ?? '');
            const parts = decoded.split('/');
            const prId = parseInt(parts[parts.length - 1], 10);
            if (!isNaN(prId) && prId > 0) {
              wiToPrId.set(wi.id, prId);
            }
          } catch { /* ignore */ }
          break; // first PR link only
        }
      }

      // Fetch PR creators
      const prIdToCreator = new Map<number, string>();
      const uniquePrIds = Array.from(new Set(wiToPrId.values()));
      for (let i = 0; i < uniquePrIds.length; i += CONCURRENCY) {
        const batch = uniquePrIds.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (prId) => {
          try {
            const pr = await gitApi.getPullRequestById(prId, this.project);
            if (pr?.createdBy?.displayName) {
              prIdToCreator.set(prId, pr.createdBy.displayName);
            }
          } catch { /* ignore */ }
        }));
      }

      // Compute denominator: all PBI/TBI/Bug changed within the time window, grouped by developer
      let wiqlDenominator = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${this.project}' AND ([System.WorkItemType] = 'Product Backlog Item' OR [System.WorkItemType] = 'Technical Backlog Item' OR [System.WorkItemType] = 'Bug')`;
      if (this.areaPath) {
        wiqlDenominator += ` AND [System.AreaPath] UNDER '${this.areaPath}'`;
      }
      wiqlDenominator += ` AND [System.ChangedDate] >= '${fromDate}' AND [System.ChangedDate] <= '${toDate}'`;

      const denomQueryResult = await witApi.queryByWiql({ query: wiqlDenominator }, { project: this.project });
      const denomIds = (denomQueryResult.workItems ?? []).map(wi => wi.id!);
      const denomDevMap = new Map<string, number>();

      for (let i = 0; i < denomIds.length; i += batchSize) {
        const batch = denomIds.slice(i, i + batchSize);
        const denomItems = await witApi.getWorkItems(batch, ['System.AssignedTo']);
        for (const wi of denomItems) {
          if (!wi?.fields) continue;
          const assignedTo = wi.fields['System.AssignedTo'];
          const dev: string | undefined = typeof assignedTo === 'object' ? assignedTo?.displayName : assignedTo;
          if (dev) denomDevMap.set(dev, (denomDevMap.get(dev) ?? 0) + 1);
        }
      }

      // Build per-developer kickoff map
      const devKickoffMap = new Map<string, DesignDocKickoffStats['kickoffDetails']>();

      for (const wi of kickoffItems) {
        if (!wi.id || !wi.fields) continue;
        const fileInfo = wiIdToFile.get(wi.id);
        if (!fileInfo) continue;

        // Prefer PR creator, fall back to Assigned To
        const prId = wiToPrId.get(wi.id);
        let developer: string | undefined = prId !== undefined ? prIdToCreator.get(prId) : undefined;
        if (!developer) {
          const assignedTo = wi.fields['System.AssignedTo'];
          developer = typeof assignedTo === 'object' ? assignedTo?.displayName : assignedTo;
        }
        if (!developer) continue;
        if (developerFilter && developer !== developerFilter) continue;

        if (!devKickoffMap.has(developer)) devKickoffMap.set(developer, []);
        const workItemType = wi.fields['System.WorkItemType'] as 'Product Backlog Item' | 'Technical Backlog Item' | 'Bug';
        devKickoffMap.get(developer)!.push({
          workItemId: wi.id,
          title: wi.fields['System.Title'] ?? '',
          workItemType,
          filePath: fileInfo.filePath,
          commitDate: fileInfo.commitDate,
          prId,
        });
      }

      // Assemble final results (only developers with at least one kickoff)
      const result: DesignDocKickoffStats[] = [];
      for (const [developer, kickoffDetails] of devKickoffMap.entries()) {
        if (developerFilter && developer !== developerFilter) continue;
        const totalWorkItems = denomDevMap.get(developer) ?? 0;
        const kickoffCount = kickoffDetails.length;
        const adoptionRate = totalWorkItems > 0
          ? Math.round((kickoffCount / totalWorkItems) * 1000) / 10
          : 0;

        result.push({
          developer,
          totalWorkItems,
          kickoffCount,
          adoptionRate,
          kickoffDetails: kickoffDetails.sort((a, b) => b.commitDate.localeCompare(a.commitDate)),
        });
      }

      result.sort((a, b) => b.kickoffCount - a.kickoffCount || a.developer.localeCompare(b.developer));
      console.log(`=== getDesignDocKickoffStats RESULT: ${result.length} developers ===`);
      return result;
    } catch (error) {
      console.error('Error in getDesignDocKickoffStats:', error);
      return [];
    }
  }

  /**
   * Fetch wiki subpages under the requirement-drafts root, parse embedded JSON
   * code blocks, and return only documents whose Epic layer contains a Draft item.
   *
   * Strategy:
   *  1. GET root page with recursionLevel=Full to collect all subpage paths (no content yet).
   *  2. For each path, GET the page individually with includeContent=true.
   *     (The bulk recursion endpoint does NOT include content for subpages.)
   *  3. Extract the first ```json block, parse — all items are returned regardless of status.
   */
  async getDraftBacklogDocs(): Promise<import('../types/workitem').BacklogDocument[]> {
    const wikiId = process.env.ADO_WIKI_ID || 'MaxView.wiki';
    // Comma-separated list of wiki paths — each may be a folder (scanned recursively)
    // or a direct page path (fetched as-is when it has no subpages).
    const rootPathsRaw = process.env.ADO_WIKI_ROOT_PATH || '/requirement-drafts';
    const rootPaths = rootPathsRaw.split(',').map(p => p.trim()).filter(Boolean);
    const orgUrl = this.organization.replace(/\/$/, '');
    const project = this.project;
    const auth = `Basic ${Buffer.from(':' + process.env.ADO_PAT).toString('base64')}`;

    const baseWikiUrl = `${orgUrl}/${encodeURIComponent(project)}/_apis/wiki/wikis/${encodeURIComponent(wikiId)}/pages`;

    console.log(`[BacklogDocs] Fetching wiki pages from ${baseWikiUrl} roots=${rootPaths.join(' | ')}`);

    // Collect all candidate page refs across every configured root path
    const pagePaths: Array<{ id: number; path: string }> = [];
    const seenPaths = new Set<string>();

    for (const rootPath of rootPaths) {
      const listUrl = `${baseWikiUrl}?path=${encodeURIComponent(rootPath)}&recursionLevel=Full&api-version=7.0`;
      const listRes = await fetch(listUrl, { headers: { Authorization: auth } });

      if (!listRes.ok) {
        const body = await listRes.text();
        console.error(`[BacklogDocs] List pages failed for "${rootPath}" ${listRes.status}: ${body}`);
        // Skip this root instead of aborting — other roots may still succeed
        continue;
      }

      const listData = await listRes.json() as any;

      // Collect the root page AND all descendants — JSON parsing later will
      // silently skip any page that has no valid ```json block.
      const collected: Array<{ id: number; path: string }> = [];
      const collectPaths = (page: any) => {
        collected.push({ id: page.id, path: page.path });
        if (Array.isArray(page.subPages)) {
          page.subPages.forEach((sub: any) => collectPaths(sub));
        }
      };
      collectPaths(listData);

      for (const ref of collected) {
        if (!seenPaths.has(ref.path)) {
          seenPaths.add(ref.path);
          pagePaths.push(ref);
        }
      }
    }

    console.log(`[BacklogDocs] Found ${pagePaths.length} page(s): ${pagePaths.map(p => p.path).join(', ')}`);

    const results: import('../types/workitem').BacklogDocument[] = [];

    // Step 2: fetch each page individually with content
    for (const pageRef of pagePaths) {
      const pageUrl = `${baseWikiUrl}?path=${encodeURIComponent(pageRef.path)}&includeContent=true&api-version=7.0`;
      const pageRes = await fetch(pageUrl, { headers: { Authorization: auth } });

      if (!pageRes.ok) {
        console.warn(`[BacklogDocs] Failed to fetch page ${pageRef.path}: ${pageRes.status}`);
        continue;
      }

      const pageData = await pageRes.json() as any;
      const content: string = pageData.content || '';

      console.log(`[BacklogDocs] Page ${pageRef.path} content length=${content.length}`);

      if (!content) continue;

      // Extract first ```json fenced block — handle both LF and CRLF line endings.
      // ADO wiki often inserts a zero-width space (U+200B) or BOM after "json",
      // so we match any non-newline characters between "json" and the line break.
      const normalised = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const match = normalised.match(/```json[^\n]*\n([\s\S]*?)\n```/);

      if (!match) {
        console.log(`[BacklogDocs] No \`\`\`json block found in page ${pageRef.path}`);
        continue;
      }

      let parsed: any;
      // ADO wiki uses non-breaking spaces (U+00A0) and zero-width characters for indentation.
      // Node.js JSON.parse only accepts \t \n \r and space as whitespace — replace all
      // non-standard Unicode spaces with regular spaces so parsing succeeds.
      const rawJson = match[1]
        .replace(/\u00A0/g, ' ')
        .replace(/[\u0000\u00AD\u200B-\u200F\u2028\u2029\uFEFF]/g, '');
      try {
        parsed = JSON.parse(rawJson);
      } catch (firstErr) {
        // Wiki pages often have a missing closing `]` or `]}` when the content is
        // long (truncation, editor bugs). Try progressively repairing the tail.
        const repairs = [']', ']}', ']]', ']]}', ']]}', ']]]}}'];
        let repaired = false;
        for (const suffix of repairs) {
          try {
            parsed = JSON.parse(rawJson + suffix);
            console.warn(`[BacklogDocs] Repaired JSON for page ${pageRef.path} by appending "${suffix}"`);
            repaired = true;
            break;
          } catch { /* try next */ }
        }
        if (!repaired) {
          console.warn(`[BacklogDocs] JSON parse failed for page ${pageRef.path}: ${firstErr}`);
          continue;
        }
      }

      const epics: any[] = Array.isArray(parsed.epics) ? parsed.epics : [];
      console.log(`[BacklogDocs] Page ${pageRef.path} has ${epics.length} epics`);

      if (epics.length === 0) continue;

      const pathLeaf = pageRef.path.split('/').filter(Boolean).pop() || pageRef.path;
      const title = epics[0]?.title || pathLeaf;

      results.push({
        id: pageRef.id,
        title,
        path: pageRef.path,
        url: `${orgUrl}/${encodeURIComponent(project)}/_wiki/wikis/${encodeURIComponent(wikiId)}?pagePath=${encodeURIComponent(pageRef.path)}`,
        document: {
          epics,
          features: Array.isArray(parsed.features) ? parsed.features : [],
          pbis: Array.isArray(parsed.pbis) ? parsed.pbis : [],
        },
      });
    }

    console.log(`[BacklogDocs] Returning ${results.length} draft document(s)`);
    return results;
  }

  /**
   * Update a wiki page's embedded JSON block with the supplied BacklogDocumentPayload,
   * preserving all other markdown content on the page.
   *
   * Strategy:
   *  1. GET the page with includeContent=true — capture content AND the ETag header.
   *  2. Replace the first ```json … ``` block with the serialised newDocument.
   *     If no block exists one is appended.
   *  3. PUT the page back using If-Match: <etag> to guard against concurrent edits.
   *  4. Parse the updated content and return a fresh BacklogDocument.
   */
  async updateDraftBacklogDoc(
    pagePath: string,
    newDocument: import('../../shared/types/backlog').BacklogDocumentPayload
  ): Promise<import('../types/workitem').BacklogDocument> {
    const wikiId = process.env.ADO_WIKI_ID || 'MaxView.wiki';
    const orgUrl = this.organization.replace(/\/$/, '');
    const project = this.project;
    const auth = `Basic ${Buffer.from(':' + process.env.ADO_PAT).toString('base64')}`;
    const baseWikiUrl = `${orgUrl}/${encodeURIComponent(project)}/_apis/wiki/wikis/${encodeURIComponent(wikiId)}/pages`;

    // Step 1: GET current content + ETag
    const getUrl = `${baseWikiUrl}?path=${encodeURIComponent(pagePath)}&includeContent=true&api-version=7.0`;
    console.log(`[BacklogDocs] updateDraftBacklogDoc GET ${pagePath}`);
    const getRes = await fetch(getUrl, { headers: { Authorization: auth } });

    if (!getRes.ok) {
      const body = await getRes.text();
      console.error(`[BacklogDocs] GET page failed ${getRes.status}: ${body}`);
      throw new Error(`Wiki GET failed ${getRes.status}: ${body}`);
    }

    const etag = getRes.headers.get('etag') || '*';
    const pageData = await getRes.json() as any;
    const originalContent: string = pageData.content || '';
    const pageId: number = pageData.id;

    console.log(`[BacklogDocs] Got page id=${pageId} etag=${etag} contentLen=${originalContent.length}`);

    // Step 2: Replace (or append) the first ```json block
    const jsonBlock = '```json\n' + JSON.stringify(newDocument, null, 4) + '\n```';
    const normalised = originalContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let newContent: string;

    if (/```json\s*\n[\s\S]*?\n```/.test(normalised)) {
      newContent = normalised.replace(/```json\s*\n[\s\S]*?\n```/, jsonBlock);
    } else {
      newContent = normalised + '\n\n' + jsonBlock;
    }

    // Step 3: PUT updated content back
    const putUrl = `${baseWikiUrl}?path=${encodeURIComponent(pagePath)}&api-version=7.0`;
    console.log(`[BacklogDocs] updateDraftBacklogDoc PUT ${pagePath}`);
    const putRes = await fetch(putUrl, {
      method: 'PUT',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
        'If-Match': etag,
      },
      body: JSON.stringify({ content: newContent }),
    });

    if (!putRes.ok) {
      const body = await putRes.text();
      console.error(`[BacklogDocs] PUT page failed ${putRes.status}: ${body}`);
      if (putRes.status === 412) {
        throw new Error('WIKI_CONFLICT: The wiki page was updated by someone else. Please refresh and try again.');
      }
      throw new Error(`Wiki PUT failed ${putRes.status}: ${body}`);
    }

    // Step 4: Return a fresh BacklogDocument from the saved document
    const pathLeaf = pagePath.split('/').filter(Boolean).pop() || pagePath;
    const title = newDocument.epics[0]?.title || pathLeaf;

    console.log(`[BacklogDocs] updateDraftBacklogDoc success for ${pagePath}`);

    return {
      id: pageId,
      title,
      path: pagePath,
      url: `${orgUrl}/${encodeURIComponent(project)}/_wiki/wikis/${encodeURIComponent(wikiId)}?pagePath=${encodeURIComponent(pagePath)}`,
      document: newDocument,
    };
  }

  /**
   * Appends a Figma design link to an existing ADO work item's System.Description.
   * No-ops if the URL is already present in the description (idempotent).
   */
  async appendFigmaLinkToDescription(workItemId: number, figmaUrl: string): Promise<void> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();
      const workItem = await witApi.getWorkItem(workItemId, ['System.Description'], undefined, undefined, this.project);
      const currentDesc: string = workItem.fields?.['System.Description'] ?? '';
      if (currentDesc.includes(figmaUrl)) return;
      const figmaHtml = `<p><strong>Figma Design:</strong> <a href="${figmaUrl}" target="_blank">View in Figma ↗</a></p>`;
      const newDesc = currentDesc + figmaHtml;
      await witApi.updateWorkItem(
        {},
        [{ op: 'add', path: '/fields/System.Description', value: newDesc }],
        workItemId,
        this.project
      );
    });
  }

  /**
   * Creates a single Feature in ADO and any of its child PBIs that are
   * Approved/Merged and do not yet have an ADO work item ID.
   * Optionally links the Feature to its parent Epic.
   */
  async createSingleFeatureInADO(
    feature: { id: string; title: string; description?: string; priority?: string; tags?: string[]; figmaUrl?: string },
    eligiblePBIs: Array<{ id: string; title: string; description?: string; priority?: string; tags?: string[]; acceptanceCriteria?: string[]; figmaUrl?: string }>,
    parentEpicAdoId?: number
  ): Promise<{ featureAdoId: number; featureAdoUrl: string; pbiMap: Record<string, number> }> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();

      const esc = (s: string) =>
        s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      const toHtml = (raw: string): string => {
        if (!raw) return '';
        const fmtItem = (s: string): string =>
          esc(s).replace(/^((?:BR|NFR|AC)-\d+:|[A-Z][A-Za-z/\s]{1,30}:)\s*/, '<strong>$1</strong>&nbsp;');
        const fmtAC = (s: string): string =>
          esc(s)
            .replace(/\b(Given)\b/g, '<strong>Given</strong>')
            .replace(/\b(When)\b/g, '<strong>When</strong>')
            .replace(/\b(Then)\b/g, '<strong>Then</strong>');
        const isHeader = (l: string) => /^[A-Z][^:\n]{1,50}:$/.test(l);
        const isList = (l: string) => l.startsWith('- ');
        let html = '';
        for (const block of raw.split(/\n{2,}/)) {
          const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
          if (!lines.length) continue;
          let i = 0;
          if (isHeader(lines[i])) { html += `<p><strong>${esc(lines[i])}</strong></p>`; i++; }
          const rest = lines.slice(i);
          const listLines = rest.filter(isList);
          const textLines = rest.filter(l => !isList(l));
          if (textLines.length) html += `<p>${textLines.map(fmtAC).join('<br/>')}</p>`;
          if (listLines.length) html += `<ul>${listLines.map(l => `<li>${fmtItem(l.slice(2))}</li>`).join('')}</ul>`;
        }
        return html;
      };

      const buildDescField = (description?: string, figmaUrl?: string): string => {
        const descHtml = description ? toHtml(description) : '';
        const figmaHtml = figmaUrl
          ? `<p><strong>Figma Design:</strong> <a href="${figmaUrl}" target="_blank">View in Figma ↗</a></p>`
          : '';
        return descHtml + figmaHtml;
      };

      const buildParentRelation = (parentAdoId: number): any => ({
        op: 'add',
        path: '/relations/-',
        value: {
          rel: 'System.LinkTypes.Hierarchy-Reverse',
          url: `${this.organization}/${this.project}/_apis/wit/workItems/${parentAdoId}`,
          attributes: { comment: 'Created from AI Pilot backlog draft' },
        },
      });

      const orgUrl = this.organization.replace(/\/$/, '');

      // 1. Create the Feature
      const featureFields: any[] = [{ op: 'add', path: '/fields/System.Title', value: feature.title }];
      const featureDescHtml = buildDescField(feature.description, feature.figmaUrl);
      if (featureDescHtml) featureFields.push({ op: 'add', path: '/fields/System.Description', value: featureDescHtml });
      if (feature.priority) {
        const priorityMap: Record<string, number> = { Critical: 1, High: 2, Medium: 3, Low: 4 };
        const num = priorityMap[feature.priority];
        if (num) featureFields.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: num });
      }
      if (feature.tags && feature.tags.length > 0) featureFields.push({ op: 'add', path: '/fields/System.Tags', value: feature.tags.join('; ') });
      if (this.areaPath) featureFields.push({ op: 'add', path: '/fields/System.AreaPath', value: this.areaPath });
      if (parentEpicAdoId) featureFields.push(buildParentRelation(parentEpicAdoId));

      const featureItem = await witApi.createWorkItem({}, featureFields, this.project, 'Feature');
      if (!featureItem?.id) throw new Error(`Failed to create Feature "${feature.title}" in ADO`);
      const featureAdoId = featureItem.id;
      const featureAdoUrl = `${orgUrl}/${encodeURIComponent(this.project)}/_workitems/edit/${featureAdoId}`;
      console.log(`[BacklogADO] Created Feature "${feature.title}" → ADO #${featureAdoId}${feature.figmaUrl ? ' (with Figma link)' : ''}`);

      // 2. Create eligible child PBIs
      const pbiMap: Record<string, number> = {};
      for (const pbi of eligiblePBIs) {
        const pbiFields: any[] = [{ op: 'add', path: '/fields/System.Title', value: pbi.title }];
        const pbiDescHtml = buildDescField(pbi.description, pbi.figmaUrl);
        if (pbiDescHtml) pbiFields.push({ op: 'add', path: '/fields/System.Description', value: pbiDescHtml });
        if (pbi.priority) {
          const priorityMap: Record<string, number> = { Critical: 1, High: 2, Medium: 3, Low: 4 };
          const num = priorityMap[pbi.priority];
          if (num) pbiFields.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: num });
        }
        if (pbi.tags && pbi.tags.length > 0) pbiFields.push({ op: 'add', path: '/fields/System.Tags', value: pbi.tags.join('; ') });
        if (this.areaPath) pbiFields.push({ op: 'add', path: '/fields/System.AreaPath', value: this.areaPath });
        pbiFields.push(buildParentRelation(featureAdoId));
        if (pbi.acceptanceCriteria && pbi.acceptanceCriteria.length > 0) {
          const acHtml = `<ul>${pbi.acceptanceCriteria.map(ac => {
            const escaped = ac.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return `<li>${escaped
              .replace(/\b(Given)\b/g, '<strong>Given</strong>')
              .replace(/\b(When)\b/g, '<strong>When</strong>')
              .replace(/\b(Then)\b/g, '<strong>Then</strong>')
            }</li>`;
          }).join('')}</ul>`;
          pbiFields.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria', value: acHtml });
        }
        const pbiItem = await witApi.createWorkItem({}, pbiFields, this.project, 'Product Backlog Item');
        if (!pbiItem?.id) throw new Error(`Failed to create PBI "${pbi.title}" in ADO`);
        pbiMap[pbi.id] = pbiItem.id;
        console.log(`[BacklogADO] Created PBI "${pbi.title}" → ADO #${pbiItem.id}${pbi.figmaUrl ? ' (with Figma link)' : ''}`);
      }

      return { featureAdoId, featureAdoUrl, pbiMap };
    });
  }

  /**
   * Create ADO work items from an approved backlog Epic and its Accepted children.
   * Returns the ADO IDs for the created Epic, Features, and PBIs.
   */
  async createBacklogItemsInADO(
    epic: { id: string; title: string; description?: string; priority?: string; tags?: string[] },
    acceptedFeatures: Array<{ id: string; title: string; description?: string; priority?: string; tags?: string[]; figmaUrl?: string }>,
    acceptedPBIs: Array<{ id: string; parentId: string; title: string; description?: string; acceptanceCriteria?: string[]; figmaUrl?: string }>
  ): Promise<{ epicAdoId: number; epicAdoUrl: string; featureMap: Record<string, number>; pbiMap: Record<string, number> }> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();

      // Convert plain-text backlog descriptions to ADO-friendly HTML.
      // Handles: section headers ending with ':', bullet lists starting with '- ',
      // rule prefixes (BR-NNN:, NFR-NNN:), labelled items (Word:), and
      // Given/When/Then acceptance-criteria sentences.
      const toHtml = (raw: string): string => {
        if (!raw) return '';

        const esc = (s: string) =>
          s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        // Bold "BR-001:", "NFR-001:", or "Label:" prefixes inside list items
        const fmtItem = (s: string): string =>
          esc(s).replace(
            /^((?:BR|NFR|AC)-\d+:|[A-Z][A-Za-z/\s]{1,30}:)\s*/,
            '<strong>$1</strong>&nbsp;'
          );

        // Bold Given / When / Then keywords in AC sentences
        const fmtAC = (s: string): string =>
          esc(s)
            .replace(/\b(Given)\b/g, '<strong>Given</strong>')
            .replace(/\b(When)\b/g, '<strong>When</strong>')
            .replace(/\b(Then)\b/g, '<strong>Then</strong>');

        const isHeader = (l: string) => /^[A-Z][^:\n]{1,50}:$/.test(l);
        const isList   = (l: string) => l.startsWith('- ');

        let html = '';
        for (const block of raw.split(/\n{2,}/)) {
          const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
          if (!lines.length) continue;

          let i = 0;
          if (isHeader(lines[i])) {
            html += `<p><strong>${esc(lines[i])}</strong></p>`;
            i++;
          }

          const rest       = lines.slice(i);
          const listLines  = rest.filter(isList);
          const textLines  = rest.filter(l => !isList(l));

          if (textLines.length) {
            html += `<p>${textLines.map(fmtAC).join('<br/>')}</p>`;
          }
          if (listLines.length) {
            html += `<ul>${listLines.map(l => `<li>${fmtItem(l.slice(2))}</li>`).join('')}</ul>`;
          }
        }
        return html;
      };

      const buildBaseFields = (title: string, description?: string, priority?: string, tags?: string[], figmaUrl?: string): any[] => {
        const fields: any[] = [
          { op: 'add', path: '/fields/System.Title', value: title },
        ];
        if (description || figmaUrl) {
          const descHtml = description ? toHtml(description) : '';
          const figmaHtml = figmaUrl
            ? `<p><strong>Figma Design:</strong> <a href="${figmaUrl}" target="_blank">View in Figma ↗</a></p>`
            : '';
          fields.push({ op: 'add', path: '/fields/System.Description', value: descHtml + figmaHtml });
        }
        if (priority) {
          const priorityMap: Record<string, number> = { Critical: 1, High: 2, Medium: 3, Low: 4 };
          const numericPriority = priorityMap[priority];
          if (numericPriority) {
            fields.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: numericPriority });
          }
        }
        if (tags && tags.length > 0) {
          fields.push({ op: 'add', path: '/fields/System.Tags', value: tags.join('; ') });
        }
        if (this.areaPath) {
          fields.push({ op: 'add', path: '/fields/System.AreaPath', value: this.areaPath });
        }
        return fields;
      };

      const buildParentRelation = (parentAdoId: number): any => ({
        op: 'add',
        path: '/relations/-',
        value: {
          rel: 'System.LinkTypes.Hierarchy-Reverse',
          url: `${this.organization}/${this.project}/_apis/wit/workItems/${parentAdoId}`,
          attributes: { comment: 'Created from AI Pilot backlog draft' },
        },
      });

      // 1. Create the Epic
      const epicFields = buildBaseFields(epic.title, epic.description, epic.priority, epic.tags);
      const epicItem = await witApi.createWorkItem({}, epicFields, this.project, 'Epic');
      if (!epicItem?.id) throw new Error('Failed to create Epic in ADO');
      const epicAdoId = epicItem.id;
      const orgUrl = this.organization.replace(/\/$/, '');
      const epicAdoUrl = `${orgUrl}/${encodeURIComponent(this.project)}/_workitems/edit/${epicAdoId}`;
      console.log(`[BacklogADO] Created Epic "${epic.title}" → ADO #${epicAdoId}`);

      // 2. Create Features as children of the Epic
      const featureMap: Record<string, number> = {};
      for (const feature of acceptedFeatures) {
        const featureFields = [
          ...buildBaseFields(feature.title, feature.description, feature.priority, feature.tags, feature.figmaUrl),
          buildParentRelation(epicAdoId),
        ];
        const featureItem = await witApi.createWorkItem({}, featureFields, this.project, 'Feature');
        if (!featureItem?.id) throw new Error(`Failed to create Feature "${feature.title}" in ADO`);
        featureMap[feature.id] = featureItem.id;
        console.log(`[BacklogADO] Created Feature "${feature.title}" → ADO #${featureItem.id}${feature.figmaUrl ? ' (with Figma link)' : ''}`);
      }

      // 3. Create PBIs as children of their respective Features
      const pbiMap: Record<string, number> = {};
      for (const pbi of acceptedPBIs) {
        const parentAdoId = featureMap[pbi.parentId];
        if (!parentAdoId) {
          console.warn(`[BacklogADO] Skipping PBI "${pbi.title}": parent feature ${pbi.parentId} was not created (not Accepted)`);
          continue;
        }
        const acHtml = pbi.acceptanceCriteria && pbi.acceptanceCriteria.length > 0
          ? `<ul>${pbi.acceptanceCriteria.map(ac => {
              const escaped = ac
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
              return `<li>${escaped
                .replace(/\b(Given)\b/g, '<strong>Given</strong>')
                .replace(/\b(When)\b/g, '<strong>When</strong>')
                .replace(/\b(Then)\b/g, '<strong>Then</strong>')
              }</li>`;
            }).join('')}</ul>`
          : undefined;
        const pbiFields = [
          ...buildBaseFields(pbi.title, pbi.description, undefined, undefined, pbi.figmaUrl),
          buildParentRelation(parentAdoId),
        ];
        if (acHtml) {
          pbiFields.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria', value: acHtml });
        }
        const pbiItem = await witApi.createWorkItem({}, pbiFields, this.project, 'Product Backlog Item');
        if (!pbiItem?.id) throw new Error(`Failed to create PBI "${pbi.title}" in ADO`);
        pbiMap[pbi.id] = pbiItem.id;
        console.log(`[BacklogADO] Created PBI "${pbi.title}" → ADO #${pbiItem.id}${pbi.figmaUrl ? ' (with Figma link)' : ''}`);
      }

      return { epicAdoId, epicAdoUrl, featureMap, pbiMap };
    });
  }

  /**
   * Creates a single PBI in ADO, linked to the given parent Feature ADO item.
   * If the Feature does not yet have an ADO work item ID, pass `parentEpicAdoId`
   * and the Feature will be created first (linked to the Epic if provided).
   */
  async createSinglePbiInADO(
    feature: { id: string; title: string; description?: string; priority?: string; tags?: string[]; adoWorkItemId?: number; figmaUrl?: string },
    pbi: { id: string; title: string; description?: string; priority?: string; tags?: string[]; acceptanceCriteria?: string[]; figmaUrl?: string },
    parentEpicAdoId?: number
  ): Promise<{ featureAdoId?: number; featureAdoUrl?: string; pbiAdoId: number; pbiAdoUrl: string }> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();

      const esc = (s: string) =>
        s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      const toHtml = (raw: string): string => {
        if (!raw) return '';
        const fmtItem = (s: string): string =>
          esc(s).replace(/^((?:BR|NFR|AC)-\d+:|[A-Z][A-Za-z/\s]{1,30}:)\s*/, '<strong>$1</strong>&nbsp;');
        const fmtAC = (s: string): string =>
          esc(s)
            .replace(/\b(Given)\b/g, '<strong>Given</strong>')
            .replace(/\b(When)\b/g, '<strong>When</strong>')
            .replace(/\b(Then)\b/g, '<strong>Then</strong>');
        const isHeader = (l: string) => /^[A-Z][^:\n]{1,50}:$/.test(l);
        const isList   = (l: string) => l.startsWith('- ');
        let html = '';
        for (const block of raw.split(/\n{2,}/)) {
          const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
          if (!lines.length) continue;
          let i = 0;
          if (isHeader(lines[i])) { html += `<p><strong>${esc(lines[i])}</strong></p>`; i++; }
          const rest      = lines.slice(i);
          const listLines = rest.filter(isList);
          const textLines = rest.filter(l => !isList(l));
          if (textLines.length) html += `<p>${textLines.map(fmtAC).join('<br/>')}</p>`;
          if (listLines.length) html += `<ul>${listLines.map(l => `<li>${fmtItem(l.slice(2))}</li>`).join('')}</ul>`;
        }
        return html;
      };

      const buildBaseFields = (title: string, description?: string, priority?: string, tags?: string[], figmaUrl?: string): any[] => {
        const fields: any[] = [{ op: 'add', path: '/fields/System.Title', value: title }];
        if (description || figmaUrl) {
          const descHtml = description ? toHtml(description) : '';
          const figmaHtml = figmaUrl
            ? `<p><strong>Figma Design:</strong> <a href="${figmaUrl}" target="_blank">View in Figma ↗</a></p>`
            : '';
          fields.push({ op: 'add', path: '/fields/System.Description', value: descHtml + figmaHtml });
        }
        if (priority) {
          const priorityMap: Record<string, number> = { Critical: 1, High: 2, Medium: 3, Low: 4 };
          const num = priorityMap[priority];
          if (num) fields.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: num });
        }
        if (tags && tags.length > 0) fields.push({ op: 'add', path: '/fields/System.Tags', value: tags.join('; ') });
        if (this.areaPath) fields.push({ op: 'add', path: '/fields/System.AreaPath', value: this.areaPath });
        return fields;
      };

      const buildParentRelation = (parentAdoId: number): any => ({
        op: 'add',
        path: '/relations/-',
        value: {
          rel: 'System.LinkTypes.Hierarchy-Reverse',
          url: `${this.organization}/${this.project}/_apis/wit/workItems/${parentAdoId}`,
          attributes: { comment: 'Created from AI Pilot backlog draft' },
        },
      });

      const orgUrl = this.organization.replace(/\/$/, '');

      // 1. Resolve or create the Feature
      let featureAdoId: number | undefined = feature.adoWorkItemId;
      let featureAdoUrl: string | undefined;
      if (!featureAdoId) {
        const featureFields = [
          ...buildBaseFields(feature.title, feature.description, feature.priority, feature.tags, feature.figmaUrl),
          ...(parentEpicAdoId ? [buildParentRelation(parentEpicAdoId)] : []),
        ];
        const featureItem = await witApi.createWorkItem({}, featureFields, this.project, 'Feature');
        if (!featureItem?.id) throw new Error(`Failed to create Feature "${feature.title}" in ADO`);
        featureAdoId = featureItem.id;
        featureAdoUrl = `${orgUrl}/${encodeURIComponent(this.project)}/_workitems/edit/${featureAdoId}`;
        console.log(`[BacklogADO] Created Feature "${feature.title}" → ADO #${featureAdoId}${feature.figmaUrl ? ' (with Figma link)' : ''}`);
      }

      // 2. Create the PBI under the Feature
      const acHtml = pbi.acceptanceCriteria && pbi.acceptanceCriteria.length > 0
        ? `<ul>${pbi.acceptanceCriteria.map(ac => {
            const escaped = ac.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return `<li>${escaped
              .replace(/\b(Given)\b/g, '<strong>Given</strong>')
              .replace(/\b(When)\b/g, '<strong>When</strong>')
              .replace(/\b(Then)\b/g, '<strong>Then</strong>')
            }</li>`;
          }).join('')}</ul>`
        : undefined;

      const pbiFields = [
        ...buildBaseFields(pbi.title, pbi.description, pbi.priority, pbi.tags, pbi.figmaUrl),
        buildParentRelation(featureAdoId),
      ];
      if (acHtml) pbiFields.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria', value: acHtml });

      const pbiItem = await witApi.createWorkItem({}, pbiFields, this.project, 'Product Backlog Item');
      if (!pbiItem?.id) throw new Error(`Failed to create PBI "${pbi.title}" in ADO`);
      const pbiAdoId = pbiItem.id;
      const pbiAdoUrl = `${orgUrl}/${encodeURIComponent(this.project)}/_workitems/edit/${pbiAdoId}`;
      console.log(`[BacklogADO] Created PBI "${pbi.title}" → ADO #${pbiAdoId}`);

      return { featureAdoId: featureAdoUrl ? featureAdoId : undefined, featureAdoUrl, pbiAdoId, pbiAdoUrl };
    });
  }

  /**
   * Create a single work item from a PRD-generated spec.
   * Optionally links to a parent work item and/or a PRD wiki page URL.
   */
  async createWorkItemForPrd(spec: {
    type: string;
    title: string;
    description?: string;
    acceptanceCriteriaHtml?: string;
    priority?: string;
    parentId?: number;
    predecessorIds?: number[];
    prdUrl?: string;
    tags?: string[];
  }): Promise<{ id: number; url: string }> {
    return retryWithBackoff(async () => {
      const witApi = await this.connection.getWorkItemTrackingApi();
      const orgUrl = this.organization.replace(/\/$/, '');

      const patch: any[] = [
        { op: 'add', path: '/fields/System.Title', value: spec.title },
      ];

      if (this.areaPath) {
        patch.push({ op: 'add', path: '/fields/System.AreaPath', value: this.areaPath });
      }

      if (spec.description) {
        patch.push({ op: 'add', path: '/fields/System.Description', value: spec.description });
      }

      if (spec.acceptanceCriteriaHtml) {
        patch.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria', value: spec.acceptanceCriteriaHtml });
      }

      if (spec.priority) {
        const priorityMap: Record<string, number> = { Critical: 1, High: 2, Medium: 3, Low: 4, 'Must Have': 1, 'Should Have': 2, 'Could Have': 3, "Won't Have": 4 };
        const numericPriority = priorityMap[spec.priority];
        if (numericPriority) {
          patch.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: numericPriority });
        }
      }

      if (spec.tags && spec.tags.length > 0) {
        patch.push({ op: 'add', path: '/fields/System.Tags', value: spec.tags.join('; ') });
      }

      if (spec.parentId) {
        patch.push({
          op: 'add',
          path: '/relations/-',
          value: {
            rel: 'System.LinkTypes.Hierarchy-Reverse',
            url: `${orgUrl}/_apis/wit/workItems/${spec.parentId}`,
          },
        });
      }

      if (spec.predecessorIds && spec.predecessorIds.length > 0) {
        const orgUrl = this.organization.replace(/\/$/, '');
        for (const predId of spec.predecessorIds) {
          patch.push({
            op: 'add',
            path: '/relations/-',
            value: {
              rel: 'System.LinkTypes.Dependency-Reverse',
              url: `${orgUrl}/_apis/wit/workItems/${predId}`,
              attributes: { comment: 'Predecessor' },
            },
          });
        }
      }

      if (spec.prdUrl) {
        patch.push({
          op: 'add',
          path: '/relations/-',
          value: {
            rel: 'Hyperlink',
            url: spec.prdUrl,
            attributes: { comment: 'PRD' },
          },
        });
      }

      const wi = await witApi.createWorkItem({}, patch, this.project, spec.type);

      if (!wi?.id) throw new Error(`Failed to create ${spec.type} "${spec.title}"`);

      return {
        id: wi.id,
        url: `${orgUrl}/${encodeURIComponent(this.project)}/_workitems/edit/${wi.id}`,
      };
    });
  }

  /**
   * Check which of the provided ADO work item IDs still exist.
   * Returns the subset that are confirmed deleted/missing in ADO.
   */
  async findDeletedWorkItemIds(ids: number[]): Promise<number[]> {
    if (ids.length === 0) return [];
    const witApi = await this.connection.getWorkItemTrackingApi();
    const deleted: number[] = [];
    await Promise.all(
      ids.map(async (id) => {
        try {
          const item = await witApi.getWorkItem(id);
          if (!item) deleted.push(id);
        } catch {
          deleted.push(id);
        }
      }),
    );
    return deleted;
  }
}
