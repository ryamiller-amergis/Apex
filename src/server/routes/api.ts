import express, { Request, Response } from 'express';
import { AzureDevOpsService } from '../services/azureDevOps';
import { generateBacklogId } from '../../shared/utils/backlogId';
import { signAgentToken, type AgentTokenClaims } from '../utils/agentTokens';
// figmaExportService intentionally unused — Figma design creation is handled
// by the .cursor/hooks.json sessionStart hook running inside Cursor Desktop.
import { WorkItemsQuery, UpdateDueDateRequest, DeveloperDueDateStats, DueDateHitRateStats, PullRequestTimeStats, InProgressTimeStats, QACycleTimeStats, UATCycleTimeStats, UATSittingItem, CreateDeploymentRequest, AIWorkItemHealthSummary } from '../types/workitem';
// DesignDocKickoffStats is returned directly by the service - no import needed here
import { getFeatureAutoCompleteService } from '../services/featureAutoComplete';
import { DeploymentTrackingService } from '../services/deploymentTracking';
import { getPrResolutionMetricsStats } from '../services/agentEvalsPrResolutionService';
import pool from '../db';

const router = express.Router();

// GET /api/projects - List ADO projects accessible to the configured PAT,
// filtered to the allowlist in ADO_ALLOWED_PROJECTS (comma-separated).
router.get('/projects', async (_req: Request, res: Response) => {
  try {
    const adoService = new AzureDevOpsService();
    let projects = await adoService.getProjects();

    const allowList = (process.env.ADO_ALLOWED_PROJECTS || '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);

    if (allowList.length > 0) {
      const allowed = new Set(allowList.map((p) => p.toLowerCase()));
      projects = projects.filter((p) => allowed.has(p.name.toLowerCase()));
      // Preserve the order defined in ADO_ALLOWED_PROJECTS
      projects.sort((a, b) => allowList.findIndex((p) => p.toLowerCase() === a.name.toLowerCase()) - allowList.findIndex((p) => p.toLowerCase() === b.name.toLowerCase()));
    }

    res.json(projects);
  } catch (error: any) {
    console.error('Error fetching ADO projects:', error);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

// GET /api/projects/:project/teams - List teams for a given ADO project
router.get('/projects/:project/teams', async (req: Request, res: Response) => {
  try {
    const { project } = req.params;
    const adoService = new AzureDevOpsService();
    const teams = await adoService.getProjectTeams(project);
    res.json(teams);
  } catch (error: any) {
    console.error('Error fetching ADO teams:', error);
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
});

// GET /api/workitems - Fetch work items for date range
router.get('/workitems', async (req: Request, res: Response) => {
  try {
    const { from, to, project, areaPath } = req.query as WorkItemsQuery & { project?: string; areaPath?: string };
    const adoService = new AzureDevOpsService(project, areaPath);
    const workItems = await adoService.getWorkItems(from, to);
    res.json(workItems);
  } catch (error: any) {
    console.error('Error fetching work items:', error);
    res.status(500).json({ error: 'Failed to fetch work items' });
  }
});

// GET /api/workitems/search - Search for work items by query
router.get('/workitems/search', async (req: Request, res: Response) => {
  try {
    const { query, type, project, areaPath } = req.query as { query?: string; type?: string; project?: string; areaPath?: string };
    
    if (!query) {
      return res.status(400).json({ error: 'Query parameter is required' });
    }

    const adoService = new AzureDevOpsService(project, areaPath);
    const workItems = await adoService.searchWorkItems(query, type);
    res.json(workItems);
  } catch (error: any) {
    console.error('Error searching work items:', error);
    res.status(500).json({ error: 'Failed to search work items' });
  }
});

// PATCH /api/workitems/:id/due-date - Update due date for a work item
router.patch('/workitems/:id/due-date', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { dueDate, reason, project, areaPath } = req.body as UpdateDueDateRequest & { project?: string; areaPath?: string };

    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid work item ID' });
    }

    // Validate date format if not null
    if (dueDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      return res
        .status(400)
        .json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }

    const adoService = new AzureDevOpsService(project, areaPath);
    await adoService.updateDueDate(id, dueDate, reason);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error updating due date:', error);
    res.status(500).json({ error: 'Failed to update due date' });
  }
});

// PATCH /api/workitems/:id/field - Update a specific field for a work item
router.patch('/workitems/:id/field', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { field, value, project, areaPath } = req.body;

    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid work item ID' });
    }

    if (!field) {
      return res.status(400).json({ error: 'Field name is required' });
    }

    const adoService = new AzureDevOpsService(project, areaPath);
    await adoService.updateWorkItemField(id, field, value);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error updating work item field:', error);
    res.status(500).json({ error: 'Failed to update work item field' });
  }
});

// POST /api/cycle-time - Calculate cycle time for specific work items
router.post('/cycle-time', async (req: Request, res: Response) => {
  try {
    const { workItemIds, project, areaPath } = req.body as { workItemIds: number[]; project?: string; areaPath?: string };

    if (!Array.isArray(workItemIds) || workItemIds.length === 0) {
      return res.status(400).json({ error: 'workItemIds array is required' });
    }

    console.log(`Calculating cycle time for ${workItemIds.length} work items`);
    const adoService = new AzureDevOpsService(project, areaPath);
    const cycleTimeData = await adoService.calculateCycleTimeForItems(workItemIds);
    res.json(cycleTimeData);
  } catch (error: any) {
    console.error('Error calculating cycle time:', error);
    res.status(500).json({ error: 'Failed to calculate cycle time' });
  }
});

// GET /api/health - Health check endpoint
router.get('/health', async (req: Request, res: Response) => {
  try {
    // Health check uses default project from env
    const adoService = new AzureDevOpsService();
    const healthy = await adoService.healthCheck();
    res.json({ healthy, timestamp: new Date().toISOString() });
  } catch (error: any) {
    console.error('Health check error:', error);
    res.status(503).json({ healthy: false, error: 'Service unavailable' });
  }
});

// GET /api/health/db - Database connectivity check
router.get('/health/db', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query<{ now: string }>('SELECT NOW() AS now');
    res.json({ healthy: true, timestamp: result.rows[0].now });
  } catch (error: any) {
    console.error('[db] Health check failed:', error);
    res.status(503).json({ healthy: false, error: 'Database unavailable' });
  }
});

// GET /api/due-date-stats - Get due date change statistics by developer
router.get('/due-date-stats', async (req: Request, res: Response) => {
  try {
    const { from, to, developer, project, areaPath: areaPathParam } = req.query as WorkItemsQuery & { developer?: string; project?: string; areaPath?: string };
    
    // Define specific teams to query for developer statistics
    const devStatsTeams = [
      { project: 'MaxView', areaPath: areaPathParam || '' }
    ];
    
    // Fetch stats from all teams and aggregate
    const allStats: DeveloperDueDateStats[] = [];
    
    for (const team of devStatsTeams) {
      try {
        const adoService = new AzureDevOpsService(team.project, team.areaPath);
        const teamStats = await adoService.getDueDateStatsByDeveloper(from, to, developer);
        allStats.push(...teamStats);
      } catch (error) {
        console.error(`Error fetching stats for ${team.project}/${team.areaPath}:`, error);
        // Continue with other teams even if one fails
      }
    }
    
    // Aggregate stats by developer
    const aggregatedStats = new Map<string, DeveloperDueDateStats>();
    
    for (const stat of allStats) {
      if (aggregatedStats.has(stat.developer)) {
        const existing = aggregatedStats.get(stat.developer)!;
        existing.totalChanges += stat.totalChanges;
        
        // Merge reason breakdown
        for (const [reason, count] of Object.entries(stat.reasonBreakdown)) {
          existing.reasonBreakdown[reason] = (existing.reasonBreakdown[reason] || 0) + count;
        }
      } else {
        aggregatedStats.set(stat.developer, {
          developer: stat.developer,
          totalChanges: stat.totalChanges,
          reasonBreakdown: { ...stat.reasonBreakdown }
        });
      }
    }
    
    const stats = Array.from(aggregatedStats.values());
    console.log(`Returning ${stats.length} developer stats:`, stats.map(s => s.developer));
    res.json(stats);
  } catch (error: any) {
    console.error('Error fetching due date stats:', error);
    res.status(500).json({ error: 'Failed to fetch due date statistics' });
  }
});

// GET /api/due-date-hit-rate - Get statistics on whether developers hit their due dates
router.get('/due-date-hit-rate', async (req: Request, res: Response) => {
  try {
    const { from, to, developer, areaPath: areaPathParam } = req.query as WorkItemsQuery & { developer?: string; areaPath?: string };
    
    // Define specific teams to query
    const devStatsTeams = [
      { project: 'MaxView', areaPath: areaPathParam || '' }
    ];
    const allStats: DueDateHitRateStats[] = [];
    
    for (const team of devStatsTeams) {
      try {
        const adoService = new AzureDevOpsService(team.project, team.areaPath);
        const teamStats = await adoService.getDueDateHitRate(from, to, developer);
        allStats.push(...teamStats);
      } catch (error) {
        console.error(`Error fetching hit rate stats for ${team.project}/${team.areaPath}:`, error);
        // Continue with other teams even if one fails
      }
    }
    
    // Aggregate stats by developer
    const aggregatedStats = new Map<string, DueDateHitRateStats>();
    
    for (const stat of allStats) {
      if (aggregatedStats.has(stat.developer)) {
        const existing = aggregatedStats.get(stat.developer)!;
        existing.totalWorkItems += stat.totalWorkItems;
        existing.hitDueDate += stat.hitDueDate;
        existing.missedDueDate += stat.missedDueDate;
        existing.workItemDetails.push(...stat.workItemDetails);
      } else {
        aggregatedStats.set(stat.developer, {
          developer: stat.developer,
          totalWorkItems: stat.totalWorkItems,
          hitDueDate: stat.hitDueDate,
          missedDueDate: stat.missedDueDate,
          hitRate: 0, // Will recalculate
          workItemDetails: [...stat.workItemDetails]
        });
      }
    }
    
    // Recalculate hit rates
    const stats = Array.from(aggregatedStats.values()).map(stat => ({
      ...stat,
      hitRate: stat.totalWorkItems > 0 ? (stat.hitDueDate / stat.totalWorkItems) * 100 : 0
    }));
    
    console.log(`Returning ${stats.length} developer hit rate stats`);
    res.json(stats);
  } catch (error: any) {
    console.error('Error fetching due date hit rate:', error);
    res.status(500).json({ error: 'Failed to fetch due date hit rate statistics' });
  }
});

// GET /api/pull-request-time-stats - Get statistics on time spent in "In Pull Request" state
router.get('/pull-request-time-stats', async (req: Request, res: Response) => {
  try {
    console.log('=== API: /pull-request-time-stats called ===');
    const { from, to, developer, areaPath: areaPathParam } = req.query as WorkItemsQuery & { developer?: string; areaPath?: string };
    console.log('Query params:', { from, to, developer, areaPath: areaPathParam });
    
    // Define specific teams to query
    const devStatsTeams = [
      { project: 'MaxView', areaPath: areaPathParam || '' }
    ];
    const allStats: any[] = [];
    
    for (const team of devStatsTeams) {
      try {
        console.log(`Fetching PR time stats for ${team.project}/${team.areaPath || '(all)'}`);
        const adoService = new AzureDevOpsService(team.project, team.areaPath);
        const teamStats = await adoService.getPullRequestTimeStats(from, to, developer);
        console.log(`Got ${teamStats.length} developer stats from ${team.project}`);
        allStats.push(...teamStats);
      } catch (error) {
        console.error(`Error fetching PR time stats for ${team.project}/${team.areaPath}:`, error);
        // Continue with other teams even if one fails
      }
    }
    
    console.log(`Total stats before aggregation: ${allStats.length}`);
    
    // Aggregate stats by developer
    const aggregatedStats = new Map<string, any>();
    
    for (const stat of allStats) {
      if (aggregatedStats.has(stat.developer)) {
        const existing = aggregatedStats.get(stat.developer)!;
        existing.totalItemsInPullRequest += stat.totalItemsInPullRequest;
        existing.totalActivePullRequests += stat.totalActivePullRequests ?? 0;
        existing.totalCompletedPullRequests += stat.totalCompletedPullRequests ?? 0;
        existing.totalTimeInPullRequest += stat.totalTimeInPullRequest;
        existing.workItemDetails.push(...stat.workItemDetails);
      } else {
        aggregatedStats.set(stat.developer, {
          developer: stat.developer,
          totalItemsInPullRequest: stat.totalItemsInPullRequest,
          totalActivePullRequests: stat.totalActivePullRequests ?? 0,
          totalCompletedPullRequests: stat.totalCompletedPullRequests ?? 0,
          averageTimeInPullRequest: 0, // Will recalculate
          totalTimeInPullRequest: stat.totalTimeInPullRequest,
          workItemDetails: [...stat.workItemDetails]
        });
      }
    }
    
    // Recalculate averages
    const stats = Array.from(aggregatedStats.values()).map(stat => ({
      ...stat,
      averageTimeInPullRequest: stat.totalItemsInPullRequest > 0 
        ? Math.round((stat.totalTimeInPullRequest / stat.totalItemsInPullRequest) * 10) / 10
        : 0
    })).sort((a, b) => b.averageTimeInPullRequest - a.averageTimeInPullRequest);
    
    console.log(`=== API: Returning ${stats.length} developer PR time stats ===`);
    console.log('Developers:', stats.map(s => s.developer));
    console.log('Response data:', JSON.stringify(stats, null, 2));
    res.json(stats);
  } catch (error: any) {
    console.error('Error fetching pull request time stats:', error);
    res.status(500).json({ error: 'Failed to fetch pull request time statistics' });
  }
});

// GET /api/pull-request-feedback-stats - Get PR review feedback (comments + votes) per developer
router.get('/pull-request-feedback-stats', async (req: Request, res: Response) => {
  try {
    const { from, to, developer, areaPath: areaPathParam } = req.query as { from?: string; to?: string; developer?: string; areaPath?: string };
    console.log('=== API: /pull-request-feedback-stats called ===', { from, to, developer, areaPath: areaPathParam });

    const adoService = new AzureDevOpsService('MaxView', areaPathParam || '');
    const stats = await adoService.getPullRequestFeedbackStats(from, to, developer);

    console.log(`=== API: Returning ${stats.length} reviewer feedback stats ===`);
    res.json(stats);
  } catch (error: any) {
    console.error('Error fetching pull request feedback stats:', error);
    res.status(500).json({ error: 'Failed to fetch pull request feedback statistics' });
  }
});

// GET /api/pr-resolution-metrics-stats — PR comment resolution metrics from agent-evals JSON, grouped by PR author
router.get('/pr-resolution-metrics-stats', async (req: Request, res: Response) => {
  try {
    const { from, to, developer, areaPath: areaPathParam } = req.query as {
      from?: string;
      to?: string;
      developer?: string;
      areaPath?: string;
    };
    console.log('=== API: /pr-resolution-metrics-stats called ===', { from, to, developer, areaPath: areaPathParam });

    const adoService = new AzureDevOpsService('MaxView', areaPathParam || '');
    const stats = await getPrResolutionMetricsStats(adoService, from, to, developer);

    console.log(`=== API: Returning ${stats.length} PR resolution metric stat rows ===`);
    res.json(stats);
  } catch (error: any) {
    console.error('Error fetching PR resolution metrics stats:', error);
    res.status(500).json({ error: 'Failed to fetch PR resolution metrics statistics' });
  }
});

// GET /api/qa-bug-stats - Get QA bug statistics for PBIs created by developers
router.get('/qa-bug-stats', async (req: Request, res: Response) => {
  try {
    console.log('=== API: /qa-bug-stats called ===');
    const { from, to, developer, areaPath: areaPathParam } = req.query as WorkItemsQuery & { developer?: string; areaPath?: string };
    console.log('Query params:', { from, to, developer, areaPath: areaPathParam });
    
    // Define specific teams to query
    const devStatsTeams = [
      { project: 'MaxView', areaPath: areaPathParam || '' }
    ];
    const allStats: any[] = [];
    
    for (const team of devStatsTeams) {
      try {
        console.log(`Fetching QA bug stats for ${team.project}/${team.areaPath || '(all)'}`);
        const adoService = new AzureDevOpsService(team.project, team.areaPath);
        const teamStats = await adoService.getQABugStats(from, to, developer);
        console.log(`Got ${teamStats.length} developer QA bug stats from ${team.project}`);
        allStats.push(...teamStats);
      } catch (error) {
        console.error(`Error fetching QA bug stats for ${team.project}/${team.areaPath}:`, error);
        // Continue with other teams even if one fails
      }
    }
    
    console.log(`Total QA bug stats before aggregation: ${allStats.length}`);
    
    // Aggregate stats by developer
    const aggregatedStats = new Map<string, any>();
    
    for (const stat of allStats) {
      if (aggregatedStats.has(stat.developer)) {
        const existing = aggregatedStats.get(stat.developer)!;
        existing.totalPBIs += stat.totalPBIs;
        existing.totalBugs += stat.totalBugs;
        existing.pbiDetails.push(...stat.pbiDetails);
      } else {
        aggregatedStats.set(stat.developer, {
          developer: stat.developer,
          totalPBIs: stat.totalPBIs,
          totalBugs: stat.totalBugs,
          averageBugsPerPBI: 0, // Will recalculate
          pbiDetails: [...stat.pbiDetails]
        });
      }
    }
    
    // Recalculate averages
    const stats = Array.from(aggregatedStats.values()).map(stat => ({
      ...stat,
      averageBugsPerPBI: stat.totalPBIs > 0 
        ? Math.round((stat.totalBugs / stat.totalPBIs) * 10) / 10
        : 0
    })).sort((a, b) => b.averageBugsPerPBI - a.averageBugsPerPBI);
    
    console.log(`=== API: Returning ${stats.length} developer QA bug stats ===`);
    console.log('Developers:', stats.map(s => s.developer));
    res.json(stats);
  } catch (error: any) {
    console.error('Error fetching QA bug stats:', error);
    res.status(500).json({ error: 'Failed to fetch QA bug statistics' });
  }
});

// GET /api/in-progress-stats - Get time spent In Progress grouped by developer
router.get('/in-progress-stats', async (req: Request, res: Response) => {
  try {
    const { from, to, developer, areaPath: areaPathParam } = req.query as { from?: string; to?: string; developer?: string; areaPath?: string };

    const devTeams = [
      { project: 'MaxView', areaPath: areaPathParam || '' }
    ];

    const allStats: InProgressTimeStats[] = [];

    for (const team of devTeams) {
      try {
        const adoService = new AzureDevOpsService(team.project, team.areaPath);
        const teamStats = await adoService.getInProgressTimeStats(from, to, developer);
        allStats.push(...teamStats);
      } catch (err) {
        console.error(`Error fetching in-progress stats for ${team.project}:`, err);
      }
    }

    // Aggregate by developer
    const aggregatedStats = new Map<string, InProgressTimeStats>();
    for (const stat of allStats) {
      if (aggregatedStats.has(stat.developer)) {
        const existing = aggregatedStats.get(stat.developer)!;
        existing.workItemDetails.push(...stat.workItemDetails);
        existing.totalItemsInProgress = existing.workItemDetails.length;
        const total = existing.workItemDetails.reduce((s, i) => s + i.daysInProgress, 0);
        existing.totalDaysInProgress = Math.round(total * 10) / 10;
        existing.averageDaysInProgress = Math.round((total / existing.workItemDetails.length) * 10) / 10;
      } else {
        aggregatedStats.set(stat.developer, { ...stat, workItemDetails: [...stat.workItemDetails] });
      }
    }

    const result = Array.from(aggregatedStats.values())
      .sort((a, b) => b.averageDaysInProgress - a.averageDaysInProgress);

    console.log(`Returning in-progress stats for ${result.length} developers`);
    res.json(result);
  } catch (error: any) {
    console.error('Error fetching in-progress stats:', error);
    res.status(500).json({ error: 'Failed to fetch in-progress statistics' });
  }
});

// GET /api/design-doc-kickoff-stats - Get design-doc kickoff usage stats per developer
router.get('/design-doc-kickoff-stats', async (req: Request, res: Response) => {
  try {
    console.log('=== API: /design-doc-kickoff-stats called ===');
    const { from, to, developer, areaPath: areaPathParam } = req.query as {
      from?: string; to?: string; developer?: string; areaPath?: string;
    };

    // Always query the MaxView project where the design-doc folder lives
    const adoService = new AzureDevOpsService('MaxView', areaPathParam || '');
    const stats = await adoService.getDesignDocKickoffStats(from, to, developer);

    console.log(`=== API: Returning design-doc kickoff stats for ${stats.length} developers ===`);
    res.json(stats);
  } catch (error: any) {
    console.error('Error fetching design-doc kickoff stats:', error);
    res.status(500).json({ error: 'Failed to fetch design-doc kickoff statistics' });
  }
});

// GET /api/qa-cycle-time-stats - Time a QA member spends moving items from In Test to Done/UAT Ready
router.get('/qa-cycle-time-stats', async (req: Request, res: Response) => {
  try {
    console.log('=== API: /qa-cycle-time-stats called ===');
    const { from, to, qaAssignee, areaPath: areaPathParam } = req.query as {
      from?: string; to?: string; qaAssignee?: string; areaPath?: string;
    };
    console.log('Query params:', { from, to, qaAssignee, areaPath: areaPathParam });

    const teams = [
      { project: 'MaxView', areaPath: areaPathParam || '' }
    ];

    const allStats: QACycleTimeStats[] = [];

    for (const team of teams) {
      try {
        const adoService = new AzureDevOpsService(team.project, team.areaPath);
        const teamStats = await adoService.getQACycleTimeStats(from, to, qaAssignee);
        allStats.push(...teamStats);
      } catch (err) {
        console.error(`Error fetching QA cycle time stats for ${team.project}:`, err);
      }
    }

    // Aggregate by qaAssignee across teams
    const aggregated = new Map<string, QACycleTimeStats>();
    for (const stat of allStats) {
      if (aggregated.has(stat.qaAssignee)) {
        const existing = aggregated.get(stat.qaAssignee)!;
        existing.workItemDetails.push(...stat.workItemDetails);
        existing.totalItems = existing.workItemDetails.length;
        const total = existing.workItemDetails.reduce((s, i) => s + i.cycleTimeDays, 0);
        existing.totalCycleTimeDays = Math.round(total * 10) / 10;
        existing.averageCycleTimeDays = Math.round((total / existing.workItemDetails.length) * 10) / 10;
      } else {
        aggregated.set(stat.qaAssignee, { ...stat, workItemDetails: [...stat.workItemDetails] });
      }
    }

    const result = Array.from(aggregated.values())
      .sort((a, b) => b.averageCycleTimeDays - a.averageCycleTimeDays);

    console.log(`=== API: Returning QA cycle time stats for ${result.length} QA members ===`);
    res.json(result);
  } catch (error: any) {
    console.error('Error fetching QA cycle time stats:', error);
    res.status(500).json({ error: 'Failed to fetch QA cycle time statistics' });
  }
});

// GET /api/uat-cycle-time-stats - Time an assignee spends moving items from UAT - Ready For Test to UAT - Test Done
router.get('/uat-cycle-time-stats', async (req: Request, res: Response) => {
  try {
    console.log('=== API: /uat-cycle-time-stats called ===');
    const { from, to, assignee, areaPath: areaPathParam } = req.query as {
      from?: string; to?: string; assignee?: string; areaPath?: string;
    };

    const teams = [{ project: 'MaxView', areaPath: areaPathParam || '' }];
    const allStats: UATCycleTimeStats[] = [];

    for (const team of teams) {
      try {
        const adoService = new AzureDevOpsService(team.project, team.areaPath);
        const teamStats = await adoService.getUATCycleTimeStats(from, to, assignee);
        allStats.push(...teamStats);
      } catch (err) {
        console.error(`Error fetching UAT cycle time stats for ${team.project}:`, err);
      }
    }

    // Aggregate by assignee
    const aggregated = new Map<string, UATCycleTimeStats>();
    for (const stat of allStats) {
      if (aggregated.has(stat.assignee)) {
        const existing = aggregated.get(stat.assignee)!;
        existing.workItemDetails.push(...stat.workItemDetails);
        existing.totalItems = existing.workItemDetails.length;
        const total = existing.workItemDetails.reduce((s, i) => s + i.cycleTimeDays, 0);
        existing.totalCycleTimeDays = Math.round(total * 10) / 10;
        existing.averageCycleTimeDays = Math.round((total / existing.workItemDetails.length) * 10) / 10;
      } else {
        aggregated.set(stat.assignee, { ...stat, workItemDetails: [...stat.workItemDetails] });
      }
    }

    const result = Array.from(aggregated.values())
      .sort((a, b) => b.averageCycleTimeDays - a.averageCycleTimeDays);

    console.log(`=== API: Returning UAT cycle time stats for ${result.length} assignees ===`);
    res.json(result);
  } catch (error: any) {
    console.error('Error fetching UAT cycle time stats:', error);
    res.status(500).json({ error: 'Failed to fetch UAT cycle time statistics' });
  }
});

// GET /api/uat-sitting-stats - Items currently sitting in UAT - Ready For Test and how long
router.get('/uat-sitting-stats', async (req: Request, res: Response) => {
  try {
    console.log('=== API: /uat-sitting-stats called ===');
    const { areaPath: areaPathParam } = req.query as { areaPath?: string };

    const teams = [{ project: 'MaxView', areaPath: areaPathParam || '' }];
    const allItems: UATSittingItem[] = [];

    for (const team of teams) {
      try {
        const adoService = new AzureDevOpsService(team.project, team.areaPath);
        const items = await adoService.getUATSittingStats();
        allItems.push(...items);
      } catch (err) {
        console.error(`Error fetching UAT sitting stats for ${team.project}:`, err);
      }
    }

    // Dedup by id in case of overlapping area paths, keep longest sitting
    const deduped = new Map<number, UATSittingItem>();
    for (const item of allItems) {
      if (!deduped.has(item.id) || item.daysSitting > deduped.get(item.id)!.daysSitting) {
        deduped.set(item.id, item);
      }
    }

    const result = Array.from(deduped.values()).sort((a, b) => b.daysSitting - a.daysSitting);
    console.log(`=== API: Returning ${result.length} UAT sitting items ===`);
    res.json(result);
  } catch (error: any) {
    console.error('Error fetching UAT sitting stats:', error);
    res.status(500).json({ error: 'Failed to fetch UAT sitting statistics' });
  }
});

// GET /api/workitems/:id/due-date-changes - Get due date change history for a work item
router.get('/workitems/:id/due-date-changes', async (req: Request, res: Response) => {
  try {
    const workItemId = parseInt(req.params.id);
    const { project } = req.query as { project?: string };

    if (!project) {
      return res.status(400).json({ error: 'project parameter is required' });
    }

    const adoService = new AzureDevOpsService(project);
    const changes = await adoService.getDueDateChangeHistoryForItem(workItemId);
    
    res.json(changes);
  } catch (error: any) {
    console.error(`Error fetching due date changes for work item ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to fetch due date change history' });
  }
});

// GET /api/workitems/:id/discussions - Get discussions/comments for a work item
router.get('/workitems/:id/discussions', async (req: Request, res: Response) => {
  try {
    const workItemId = parseInt(req.params.id);
    const { project } = req.query as { project?: string };

    if (!project) {
      return res.status(400).json({ error: 'project parameter is required' });
    }

    const adoService = new AzureDevOpsService(project);
    const discussions = await adoService.getWorkItemComments(workItemId);
    
    res.json({ discussions });
  } catch (error: any) {
    console.error(`Error fetching discussions for work item ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to fetch discussions' });
  }
});

// GET /api/team-members - Get list of members from a specific team
router.get('/team-members', async (req: Request, res: Response) => {
  try {
    const { project, teamName } = req.query as { project?: string; teamName?: string };
    
    if (!project || !teamName) {
      return res.status(400).json({ error: 'project and teamName are required' });
    }
    
    const adoService = new AzureDevOpsService(project);
    const members = await adoService.getTeamMembers(teamName);
    
    console.log(`Returning ${members.length} members for ${project}/${teamName}`);
    res.json(members);
  } catch (error: any) {
    console.error('Error fetching team members:', error);
    res.status(500).json({ error: 'Failed to fetch team members' });
  }
});

// GET /api/dev-team-members - Get list of developers from dev teams
router.get('/dev-team-members', async (req: Request, res: Response) => {
  try {
    // Define specific teams to query for developer list
    const devTeams = [
      { project: 'MaxView', teamName: 'MaxView - Dev' },
      { project: 'MaxView', teamName: 'MaxView Infra Team' },
      { project: 'MaxView', teamName: 'Mobile - Dev' }
    ];
    
    const allMembers = new Set<string>();
    
    for (const team of devTeams) {
      try {
        const adoService = new AzureDevOpsService(team.project);
        const members = await adoService.getTeamMembers(team.teamName);
        members.forEach(member => allMembers.add(member));
      } catch (error) {
        console.error(`Error fetching members for ${team.project}/${team.teamName}:`, error);
        // Continue with other teams even if one fails
      }
    }
    
    const membersList = Array.from(allMembers).sort();
    console.log(`Returning ${membersList.length} team members from dev teams`);
    res.json(membersList);
  } catch (error: any) {
    console.error('Error fetching team members:', error);
    res.status(500).json({ error: 'Failed to fetch team members' });
  }
});

// GET /api/epics/:id/children - Get child work items for an Epic
router.get('/epics/:id/children', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { project, areaPath } = req.query as { project?: string; areaPath?: string };

    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid Epic ID' });
    }

    const adoService = new AzureDevOpsService(project, areaPath);
    const children = await adoService.getEpicChildren(id);
    res.json(children);
  } catch (error: any) {
    console.error('Error fetching Epic children:', error);
    res.status(500).json({ error: 'Failed to fetch Epic children' });
  }
});

// GET /api/features/:id/children - Get child work items for a Feature
router.get('/features/:id/children', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { project, areaPath } = req.query as { project?: string; areaPath?: string };

    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid Feature ID' });
    }

    const adoService = new AzureDevOpsService(project, areaPath);
    const children = await adoService.getFeatureChildren(id);
    res.json(children);
  } catch (error: any) {
    console.error('Error fetching Feature children:', error);
    res.status(500).json({ error: 'Failed to fetch Feature children' });
  }
});

// GET /api/workitems/:id/relations - Get related/child work items for a PBI or TBI
router.get('/workitems/:id/relations', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { project, areaPath } = req.query as { project?: string; areaPath?: string };

    console.log(`Fetching relations for work item ${id}, project: ${project}, areaPath: ${areaPath}`);

    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid work item ID' });
    }

    const adoService = new AzureDevOpsService(project, areaPath);
    const relatedItems = await adoService.getWorkItemRelations(id);
    
    console.log(`Returning ${relatedItems.length} related items for work item ${id}`);
    res.json(relatedItems);
  } catch (error: any) {
    console.error('Error fetching work item relations:', error);
    console.error('Stack trace:', error.stack);
    res.status(500).json({ error: 'Failed to fetch work item relations' });
  }
});

// GET /api/workitems/:id/parent-epic - Get parent epic for a work item
router.get('/workitems/:id/parent-epic', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { project, areaPath } = req.query as { project?: string; areaPath?: string };

    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid work item ID' });
    }

    console.log(`[API] Fetching parent epic for work item ${id}`);
    const adoService = new AzureDevOpsService(project, areaPath);
    const parentEpic = await adoService.getParentReleaseEpic(id);
    
    if (parentEpic) {
      console.log(`[API] Found parent epic:`, parentEpic);
      res.json(parentEpic);
    } else {
      console.log(`[API] No parent epic found for work item ${id}`);
      res.json(null);
    }
  } catch (error: any) {
    console.error('[API] Error fetching parent epic:', error);
    res.status(500).json({ error: 'Failed to fetch parent epic' });
  }
});

// POST /api/admin/trigger-feature-check - Manually trigger feature auto-complete check
router.post('/admin/trigger-feature-check', async (req: Request, res: Response) => {
  try {
    console.log('[API] Manual trigger of feature auto-complete check requested');
    const service = getFeatureAutoCompleteService();
    
    // Run the check asynchronously
    service.triggerCheck().catch(error => {
      console.error('[API] Error during manual feature check:', error);
    });
    
    res.json({ 
      success: true, 
      message: 'Feature auto-complete check triggered. Check server logs for results.' 
    });
  } catch (error: any) {
    console.error('Error triggering feature check:', error);
    res.status(500).json({ error: 'Failed to trigger feature check' });
  }
});

// ============= RELEASE MANAGEMENT ROUTES =============

// GET /api/releases/epics - Get all release Epics with progress
router.get('/releases/epics', async (req: Request, res: Response) => {
  try {
    const { project, areaPath } = req.query as { project?: string; areaPath?: string };
    const adoService = new AzureDevOpsService(project, areaPath);
    const epics = await adoService.getReleaseEpics();
    res.json(epics);
  } catch (error: any) {
    console.error('Error fetching release epics:', error);
    res.status(500).json({ error: 'Failed to fetch release epics' });
  }
});

// PATCH /api/releases/:epicId - Update a release Epic
router.patch('/releases/:epicId', async (req: Request, res: Response) => {
  try {
    const epicId = parseInt(req.params.epicId, 10);
    const { title, startDate, targetDate, description, status, project, areaPath } = req.body as {
      title?: string;
      startDate?: string;
      targetDate?: string;
      description?: string;
      status?: string;
      project?: string;
      areaPath?: string;
    };

    if (isNaN(epicId)) {
      return res.status(400).json({ error: 'Invalid epic ID' });
    }

    const adoService = new AzureDevOpsService(project, areaPath);
    await adoService.updateReleaseEpic(epicId, title, startDate, targetDate, description, status);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error updating release epic:', error);
    res.status(500).json({ error: 'Failed to update release epic' });
  }
});

// POST /api/releases/:epicId/link - Link work items to release epic
router.post('/releases/:epicId/link', async (req: Request, res: Response) => {
  try {
    const epicId = parseInt(req.params.epicId, 10);
    const { workItemIds, project, areaPath } = req.body as { workItemIds: number[]; project?: string; areaPath?: string };

    if (isNaN(epicId)) {
      return res.status(400).json({ error: 'Invalid epic ID' });
    }

    if (!workItemIds || !Array.isArray(workItemIds) || workItemIds.length === 0) {
      return res.status(400).json({ error: 'workItemIds array is required' });
    }

    const adoService = new AzureDevOpsService(project, areaPath);
    await adoService.linkWorkItemsToEpic(epicId, workItemIds);
    res.json({ success: true, linkedCount: workItemIds.length });
  } catch (error: any) {
    console.error('Error linking work items:', error);
    res.status(500).json({ error: 'Failed to link work items' });
  }
});

// POST /api/releases/:epicId/unlink - Unlink work items from release epic
router.post('/api/releases/:epicId/unlink', async (req: Request, res: Response) => {
  try {
    const epicId = parseInt(req.params.epicId, 10);
    const { workItemIds, project, areaPath } = req.body as { workItemIds: number[]; project?: string; areaPath?: string };

    if (isNaN(epicId)) {
      return res.status(400).json({ error: 'Invalid epic ID' });
    }

    if (!workItemIds || !Array.isArray(workItemIds) || workItemIds.length === 0) {
      return res.status(400).json({ error: 'workItemIds array is required' });
    }

    const adoService = new AzureDevOpsService(project, areaPath);
    await adoService.unlinkWorkItemsFromEpic(epicId, workItemIds);
    res.json({ success: true, unlinkedCount: workItemIds.length });
  } catch (error: any) {
    console.error('Error unlinking work items:', error);
    res.status(500).json({ error: 'Failed to unlink work items' });
  }
});

// POST /api/releases/:epicId/link-related - Link work items as related items to release
router.post('/releases/:epicId/link-related', async (req: Request, res: Response) => {
  try {
    const epicId = parseInt(req.params.epicId, 10);
    const { workItemIds, project, areaPath } = req.body as { workItemIds: number[]; project?: string; areaPath?: string };

    if (isNaN(epicId)) {
      return res.status(400).json({ error: 'Invalid epic ID' });
    }

    if (!workItemIds || !Array.isArray(workItemIds) || workItemIds.length === 0) {
      return res.status(400).json({ error: 'workItemIds array is required' });
    }

    const adoService = new AzureDevOpsService(project, areaPath);
    await adoService.linkWorkItemsToRelease(epicId, workItemIds);
    res.json({ success: true, linkedCount: workItemIds.length });
  } catch (error: any) {
    console.error('Error linking related items:', error);
    res.status(500).json({ error: 'Failed to link related items' });
  }
});

// POST /api/releases/:epicId/unlink-related - Unlink related items from release
router.post('/releases/:epicId/unlink-related', async (req: Request, res: Response) => {
  console.log(`[unlink-related] ====== ROUTE HIT ====== Epic: ${req.params.epicId}, Body:`, req.body);
  try {
    const epicId = parseInt(req.params.epicId, 10);
    const { workItemIds, project, areaPath } = req.body as { workItemIds: number[]; project?: string; areaPath?: string };

    console.log(`[unlink-related] Request to unlink items ${workItemIds} from epic ${epicId}`);

    if (isNaN(epicId)) {
      console.log(`[unlink-related] Invalid epic ID: ${req.params.epicId}`);
      return res.status(400).json({ error: 'Invalid epic ID' });
    }

    if (!workItemIds || !Array.isArray(workItemIds) || workItemIds.length === 0) {
      console.log(`[unlink-related] Invalid workItemIds:`, workItemIds);
      return res.status(400).json({ error: 'workItemIds array is required' });
    }

    console.log(`[unlink-related] Creating AzureDevOpsService with project: ${project}, areaPath: ${areaPath}`);
    const adoService = new AzureDevOpsService(project, areaPath);
    
    console.log(`[unlink-related] Calling unlinkWorkItemsFromRelease...`);
    await adoService.unlinkWorkItemsFromRelease(epicId, workItemIds);
    
    console.log(`[unlink-related] Successfully unlinked ${workItemIds.length} items from epic ${epicId}`);
    res.json({ success: true, unlinkedCount: workItemIds.length });
  } catch (error: any) {
    console.error('[unlink-related] Error unlinking related items:', error);
    console.error('[unlink-related] Error stack:', error.stack);
    res.status(500).json({ error: 'Failed to unlink related items', details: error.message });
  }
});

// GET /api/releases/:epicId/related-items - Get related items linked to a release
router.get('/releases/:epicId/related-items', async (req: Request, res: Response) => {
  try {
    const epicId = parseInt(req.params.epicId, 10);
    const { project, areaPath } = req.query as { project?: string; areaPath?: string };

    if (isNaN(epicId)) {
      return res.status(400).json({ error: 'Invalid epic ID' });
    }

    const adoService = new AzureDevOpsService(project, areaPath);
    const relatedItems = await adoService.getRelatedItems(epicId);
    res.json(relatedItems);
  } catch (error: any) {
    console.error('Error fetching related items:', error);
    res.status(500).json({ error: 'Failed to fetch related items' });
  }
});

// DELETE /api/releases/:epicId - Delete a release epic
router.delete('/releases/:epicId', async (req: Request, res: Response) => {
  try {
    const epicId = parseInt(req.params.epicId, 10);
    const { project, areaPath } = req.query as { project?: string; areaPath?: string };

    if (isNaN(epicId)) {
      return res.status(400).json({ error: 'Invalid epic ID' });
    }

    const adoService = new AzureDevOpsService(project, areaPath);
    await adoService.deleteWorkItem(epicId);
    res.json({ success: true, deletedEpicId: epicId });
  } catch (error: any) {
    console.error('Error deleting release epic:', error);
    res.status(500).json({ error: 'Failed to delete release epic' });
  }
});

// GET /api/releases - Get all release versions
router.get('/releases', async (req: Request, res: Response) => {
  try {
    const { project, areaPath } = req.query as { project?: string; areaPath?: string };
    console.log(`[GET /releases] Fetching releases for project: ${project}, areaPath: ${areaPath}`);
    const adoService = new AzureDevOpsService(project, areaPath);
    const versions = await adoService.getReleaseVersions();
    console.log(`[GET /releases] Found ${versions.length} release versions`);
    res.json(versions);
  } catch (error: any) {
    console.error('[GET /releases] Error fetching release versions:', error);
    console.error('[GET /releases] Error stack:', error.stack);
    res.status(500).json({ error: 'Failed to fetch release versions', details: error.message });
  }
});

// GET /api/releases/:version/workitems - Get work items for a specific release
router.get('/releases/:version/workitems', async (req: Request, res: Response) => {
  try {
    const version = req.params.version;
    const { project, areaPath } = req.query as { project?: string; areaPath?: string };
    const adoService = new AzureDevOpsService(project, areaPath);
    const workItems = await adoService.getWorkItemsByRelease(version);
    res.json(workItems);
  } catch (error: any) {
    console.error('Error fetching release work items:', error);
    res.status(500).json({ error: 'Failed to fetch release work items' });
  }
});

// GET /api/releases/:version/metrics - Get metrics for a specific release
router.get('/releases/:version/metrics', async (req: Request, res: Response) => {
  try {
    const version = req.params.version;
    const { project, areaPath } = req.query as { project?: string; areaPath?: string };
    const adoService = new AzureDevOpsService(project, areaPath);
    const deploymentService = new DeploymentTrackingService();
    
    const metrics = await adoService.getReleaseMetrics(version);
    
    // Add deployment history from tracking service
    metrics.deploymentHistory = await deploymentService.getDeploymentsByRelease(version);
    
    res.json(metrics);
  } catch (error: any) {
    console.error('Error fetching release metrics:', error);
    res.status(500).json({ error: 'Failed to fetch release metrics' });
  }
});

// POST /api/releases/:version/tag - Add release tag to work items
router.post('/releases/:version/tag', async (req: Request, res: Response) => {
  try {
    const version = req.params.version;
    const { workItemIds, project, areaPath, startDate, targetDate, description } = req.body as { 
      workItemIds?: number[]; 
      project?: string; 
      areaPath?: string;
      startDate?: string;
      targetDate?: string;
      description?: string;
    };
    
    const adoService = new AzureDevOpsService(project, areaPath);
    
    // Create release Epic
    const epicId = await adoService.createReleaseEpic(version, startDate, targetDate, description);
    
    // If workItemIds were provided, add release tag to each work item
    if (workItemIds && Array.isArray(workItemIds) && workItemIds.length > 0) {
      await Promise.all(
        workItemIds.map(id => adoService.addReleaseTag(id, version))
      );
    }
    
    res.json({ success: true, epicId, taggedCount: workItemIds?.length || 0 });
  } catch (error: any) {
    console.error('Error creating release:', error);
    res.status(500).json({ error: 'Failed to create release' });
  }
});

// DELETE /api/releases/:version/tag/:workItemId - Remove release tag from work item
router.delete('/releases/:version/tag/:workItemId', async (req: Request, res: Response) => {
  try {
    const version = req.params.version;
    const workItemId = parseInt(req.params.workItemId, 10);
    const { project, areaPath } = req.query as { project?: string; areaPath?: string };
    
    if (isNaN(workItemId)) {
      return res.status(400).json({ error: 'Invalid work item ID' });
    }
    
    const adoService = new AzureDevOpsService(project, areaPath);
    await adoService.removeReleaseTag(workItemId, version);
    
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error removing release tag:', error);
    res.status(500).json({ error: 'Failed to remove release tag' });
  }
});

// ============= DEPLOYMENT TRACKING ROUTES =============

// POST /api/deployments - Create a new deployment record
router.post('/deployments', async (req: Request, res: Response) => {
  try {
    const { releaseVersion, environment, workItemIds, notes } = req.body as CreateDeploymentRequest;
    
    if (!releaseVersion || !environment || !workItemIds || !Array.isArray(workItemIds)) {
      return res.status(400).json({ error: 'releaseVersion, environment, and workItemIds are required' });
    }
    
    const deploymentService = new DeploymentTrackingService();
    
    // Get user from session or use a default
    const deployedBy = (req.user as any)?.displayName || 'Unknown User';
    
    const deployment = await deploymentService.createDeployment(
      releaseVersion,
      environment,
      workItemIds,
      deployedBy,
      notes
    );
    
    res.json(deployment);
  } catch (error: any) {
    console.error('Error creating deployment:', error);
    res.status(500).json({ error: 'Failed to create deployment' });
  }
});

// GET /api/deployments - Get all deployments (or filter by release/environment)
router.get('/deployments', async (req: Request, res: Response) => {
  try {
    const { releaseVersion, environment, limit } = req.query as { 
      releaseVersion?: string; 
      environment?: string;
      limit?: string;
    };
    
    const deploymentService = new DeploymentTrackingService();
    
    let deployments;
    
    if (releaseVersion) {
      deployments = await deploymentService.getDeploymentsByRelease(releaseVersion);
    } else if (environment) {
      deployments = await deploymentService.getDeploymentsByEnvironment(environment as any);
    } else if (limit) {
      deployments = await deploymentService.getDeploymentHistory(parseInt(limit, 10));
    } else {
      deployments = await deploymentService.getAllDeployments();
    }
    
    res.json(deployments);
  } catch (error: any) {
    console.error('Error fetching deployments:', error);
    res.status(500).json({ error: 'Failed to fetch deployments' });
  }
});

// GET /api/deployments/:releaseVersion/latest - Get latest deployments by environment for a release
router.get('/deployments/:releaseVersion/latest', async (req: Request, res: Response) => {
  try {
    const releaseVersion = req.params.releaseVersion;
    const deploymentService = new DeploymentTrackingService();
    const latest = await deploymentService.getLatestDeploymentsByRelease(releaseVersion);
    res.json(latest);
  } catch (error: any) {
    console.error('Error fetching latest deployments:', error);
    res.status(500).json({ error: 'Failed to fetch latest deployments' });
  }
});

// GET /api/releases/:epicId/children - Get child work items for a release Epic
router.get('/releases/:epicId/children', async (req: Request, res: Response) => {
  try {
    const epicId = parseInt(req.params.epicId, 10);
    const { project, areaPath } = req.query as { project?: string; areaPath?: string };

    if (isNaN(epicId)) {
      return res.status(400).json({ error: 'Invalid Epic ID' });
    }

    console.log(`Fetching children for release Epic ${epicId}`);
    const adoService = new AzureDevOpsService(project, areaPath);
    const children = await adoService.getReleaseEpicChildren(epicId);
    console.log(`Returning ${children.length} children for release Epic ${epicId}`);
    res.json(children);
  } catch (error: any) {
    console.error('Error fetching release Epic children:', error);
    res.status(500).json({ error: 'Failed to fetch release Epic children' });
  }
});

// GET /api/releases/:version/notes - Generate release notes
router.get('/releases/:version/notes', async (req: Request, res: Response) => {
  try {
    const version = req.params.version;
    const { project, areaPath, format = 'json' } = req.query as { project?: string; areaPath?: string; format?: string };
    
    const adoService = new AzureDevOpsService(project, areaPath);
    const workItems = await adoService.getWorkItemsByRelease(version);
    
    // Group by work item type
    const features = workItems.filter(wi => wi.workItemType === 'Feature');
    const epics = workItems.filter(wi => wi.workItemType === 'Epic');
    const bugs = workItems.filter(wi => wi.workItemType === 'Bug');
    
    if (format === 'markdown') {
      // Generate markdown format
      let markdown = `# Release ${version}\n\n`;
      
      if (features.length > 0) {
        markdown += `## Features\n\n`;
        features.forEach(f => {
          markdown += `- **[${f.id}]** ${f.title} - ${f.state}\n`;
        });
        markdown += '\n';
      }
      
      if (epics.length > 0) {
        markdown += `## Epics\n\n`;
        epics.forEach(e => {
          markdown += `- **[${e.id}]** ${e.title} - ${e.state}\n`;
        });
        markdown += '\n';
      }
      
      if (bugs.length > 0) {
        markdown += `## Bug Fixes\n\n`;
        bugs.forEach(b => {
          markdown += `- **[${b.id}]** ${b.title} - ${b.state}\n`;
        });
        markdown += '\n';
      }
      
      res.setHeader('Content-Type', 'text/markdown');
      res.send(markdown);
    } else {
      // Return JSON format
      res.json({
        version,
        generatedAt: new Date().toISOString(),
        features: features.map(f => ({ id: f.id, title: f.title, state: f.state })),
        epics: epics.map(e => ({ id: e.id, title: e.title, state: e.state })),
        bugs: bugs.map(b => ({ id: b.id, title: b.title, state: b.state })),
      });
    }
  } catch (error: any) {
    console.error('Error generating release notes:', error);
    res.status(500).json({ error: 'Failed to generate release notes' });
  }
});

// GET /api/ai-analysis-summary - Lightweight aggregate health score for ai-code items
router.get('/ai-analysis-summary', async (req: Request, res: Response) => {
  try {
    const { from, to, project, areaPath } = req.query as { from?: string; to?: string; project?: string; areaPath?: string };
    const adoService = new AzureDevOpsService(project, areaPath);
    const summary = await adoService.getAIWorkItemHealthMetrics(from, to);
    // Return only the aggregate fields — no per-item detail
    const { items: _items, ...aggregate } = summary;
    res.json({ ...aggregate, totalItems: summary.totalItems });
  } catch (error: any) {
    console.error('Error fetching AI analysis summary:', error);
    res.status(500).json({ error: 'Failed to fetch AI analysis summary' });
  }
});

// GET /api/ai-work-item-health - Full health metrics including per-item breakdown
router.get('/ai-work-item-health', async (req: Request, res: Response) => {
  try {
    const { from, to, project, areaPath } = req.query as { from?: string; to?: string; project?: string; areaPath?: string };
    const adoService = new AzureDevOpsService(project, areaPath);
    const summary: AIWorkItemHealthSummary = await adoService.getAIWorkItemHealthMetrics(from, to);
    res.json(summary);
  } catch (error: any) {
    console.error('Error fetching AI work item health:', error);
    res.status(500).json({ error: 'Failed to fetch AI work item health metrics' });
  }
});

// GET /api/ai-work-item-details - Per-item detail list for drill-down views
router.get('/ai-work-item-details', async (req: Request, res: Response) => {
  try {
    const { from, to, project, areaPath } = req.query as { from?: string; to?: string; project?: string; areaPath?: string };
    const adoService = new AzureDevOpsService(project, areaPath);
    const summary = await adoService.getAIWorkItemHealthMetrics(from, to);
    res.json(summary.items);
  } catch (error: any) {
    console.error('Error fetching AI work item details:', error);
    res.status(500).json({ error: 'Failed to fetch AI work item details' });
  }
});

// GET /api/backlog/drafts - Fetch wiki draft backlog documents
// GET /api/backlog/ado-work-item-tags?workItemId=X&project=Y - Fetch System.Tags from a single ADO work item
router.get('/backlog/ado-work-item-tags', async (req: Request, res: Response) => {
  try {
    const { workItemId, project, areaPath } = req.query as { workItemId?: string; project?: string; areaPath?: string };
    if (!workItemId || isNaN(Number(workItemId))) {
      return res.status(400).json({ error: 'workItemId is required and must be a number' });
    }
    const adoService = new AzureDevOpsService(project, areaPath);
    const witApi = await (adoService as any).connection.getWorkItemTrackingApi();
    const workItem = await witApi.getWorkItem(Number(workItemId), ['System.Tags'], undefined, undefined, project);
    const raw: string = workItem.fields?.['System.Tags'] ?? '';
    const tags = raw ? raw.split(';').map((t: string) => t.trim()).filter(Boolean) : [];
    res.json({ tags });
  } catch (error: any) {
    console.error('Error fetching ADO work item tags:', error);
    res.status(500).json({ error: 'Failed to fetch work item tags', details: error.message });
  }
});

router.get('/backlog/drafts', async (req: Request, res: Response) => {
  try {
    const { project, areaPath } = req.query as { project?: string; areaPath?: string };
    const adoService = new AzureDevOpsService(project, areaPath);
    const docs = await adoService.getDraftBacklogDocs();
    res.json(docs);
  } catch (error: any) {
    console.error('Error fetching draft backlog docs:', error);
    res.status(500).json({ error: 'Failed to fetch draft backlog documents' });
  }
});

// POST /api/backlog/create-ado-items - Create ADO work items from an approved Epic and its Accepted children
router.post('/backlog/create-ado-items', async (req: Request, res: Response) => {
  try {
    const { epicId, document, project, areaPath } = req.body as {
      epicId?: string;
      document?: any;
      project?: string;
      areaPath?: string;
    };

    if (!epicId || typeof epicId !== 'string') {
      return res.status(400).json({ error: 'epicId is required' });
    }
    if (!document || typeof document !== 'object') {
      return res.status(400).json({ error: 'document is required' });
    }

    const epic = (document.epics ?? []).find((e: any) => e.id === epicId);
    if (!epic) {
      return res.status(404).json({ error: `Epic ${epicId} not found in document` });
    }
    if (epic.status !== 'Approved') {
      return res.status(422).json({ error: 'Epic must be Approved before creating ADO backlog items' });
    }

    const isReady = (s: string) => s === 'Approved' || s === 'Accepted';

    const acceptedFeatures = (document.features ?? []).filter(
      (f: any) => f.parentId === epicId && isReady(f.status)
    );
    const acceptedFeatureIds = new Set(acceptedFeatures.map((f: any) => f.id));
    const acceptedPBIs = (document.pbis ?? []).filter(
      (p: any) => acceptedFeatureIds.has(p.parentId) && isReady(p.status)
    );

    // Resolve each feature's Figma URL (design-ready mocks only) and each
    // PBI's Figma URL from its parent feature's uiMock views.
    const featuresWithFigma = acceptedFeatures.map((f: any) => ({
      ...f,
      figmaUrl: f.uiMock?.designReady && f.uiMock?.figmaUrl ? f.uiMock.figmaUrl : undefined,
    }));
    const featureUiMockMap = new Map<string, any>(acceptedFeatures.map((f: any) => [f.id, f.uiMock]));
    const pbisWithFigma = acceptedPBIs.map((p: any) => {
      const featureMock = featureUiMockMap.get(p.parentId) as any;
      const view = ((featureMock?.views ?? []) as any[]).find((v: any) => v.pbiId === p.id);
      return {
        ...p,
        figmaUrl: view?.designReady && view?.figmaUrl ? view.figmaUrl : undefined,
      };
    });

    const adoService = new AzureDevOpsService(project, areaPath);
    const result = await adoService.createBacklogItemsInADO(epic, featuresWithFigma, pbisWithFigma);

    // Tag any newly-created feature ADO items that have an approved AI-generated UI mock
    for (const feature of acceptedFeatures) {
      if (feature.uiMock?.status === 'approved') {
        const newAdoId = result.featureMap[feature.id];
        if (newAdoId) {
          try {
            await adoService.addTagToWorkItem(newAdoId, 'ai-generated-ui');
          } catch (tagErr) {
            console.warn(`Could not add ai-generated-ui tag to new ADO item ${newAdoId}:`, tagErr);
          }
        }
      }
    }

    res.json({
      success: true,
      epicAdoId: result.epicAdoId,
      epicAdoUrl: result.epicAdoUrl,
      featuresCreated: Object.keys(result.featureMap).length,
      pbisCreated: Object.keys(result.pbiMap).length,
      featureMap: result.featureMap,
      pbiMap: result.pbiMap,
    });
  } catch (error: any) {
    console.error('Error creating ADO backlog items:', error);
    res.status(500).json({ error: 'Failed to create ADO backlog items', details: error.message });
  }
});

// POST /api/backlog/create-pbi-ado-item - Create a single ADO PBI (and its Feature if needed) from an approved Feature
router.post('/backlog/create-pbi-ado-item', async (req: Request, res: Response) => {
  try {
    const { pbiId, document, project, areaPath } = req.body as {
      pbiId?: string;
      document?: any;
      project?: string;
      areaPath?: string;
    };

    if (!pbiId || typeof pbiId !== 'string') {
      return res.status(400).json({ error: 'pbiId is required' });
    }
    if (!document || typeof document !== 'object') {
      return res.status(400).json({ error: 'document is required' });
    }

    const pbi = (document.pbis ?? []).find((p: any) => p.id === pbiId);
    if (!pbi) return res.status(404).json({ error: `PBI ${pbiId} not found in document` });
    if (pbi.adoWorkItemId) return res.status(422).json({ error: 'PBI already has an ADO work item' });

    const isReady = (s: string) => s === 'Approved' || s === 'Merged';
    if (!isReady(pbi.status)) {
      return res.status(422).json({ error: 'PBI must be Approved or Merged before creating in ADO' });
    }

    const feature = (document.features ?? []).find((f: any) => f.id === pbi.parentId);
    if (!feature) return res.status(404).json({ error: `Parent feature ${pbi.parentId} not found in document` });
    if (!isReady(feature.status)) {
      return res.status(422).json({ error: 'Parent Feature must be Approved or Merged before creating ADO PBI' });
    }

    // Resolve the parent Epic's ADO ID if the Feature needs to be created
    let parentEpicAdoId: number | undefined;
    if (!feature.adoWorkItemId) {
      const parentEpic = (document.epics ?? []).find((e: any) => e.id === feature.parentId);
      if (parentEpic?.adoWorkItemId) parentEpicAdoId = parentEpic.adoWorkItemId;
    }

    // Resolve Figma URLs for the feature and the specific PBI view (design-ready only)
    const featureFigmaUrl = feature.uiMock?.designReady && feature.uiMock?.figmaUrl
      ? feature.uiMock.figmaUrl as string
      : undefined;
    const pbiView = (feature.uiMock?.views ?? []).find((v: any) => v.pbiId === pbi.id);
    const pbiFigmaUrl = pbiView?.designReady && pbiView?.figmaUrl
      ? pbiView.figmaUrl as string
      : undefined;

    const featureWithFigma = { ...feature, figmaUrl: featureFigmaUrl };
    const pbiWithFigma = { ...pbi, figmaUrl: pbiFigmaUrl };

    const adoService = new AzureDevOpsService(project, areaPath);
    const result = await adoService.createSinglePbiInADO(featureWithFigma, pbiWithFigma, parentEpicAdoId);

    // Tag the feature ADO item if it has an approved AI-generated UI mock
    if (feature.uiMock?.status === 'approved') {
      const featureAdoId = result.featureAdoId ?? (feature.adoWorkItemId as number | undefined);
      if (featureAdoId) {
        try {
          await adoService.addTagToWorkItem(featureAdoId, 'ai-generated-ui');
        } catch (tagErr) {
          console.warn(`Could not add ai-generated-ui tag to ADO item ${featureAdoId}:`, tagErr);
        }
      }
    }

    res.json({
      success: true,
      pbiAdoId: result.pbiAdoId,
      pbiAdoUrl: result.pbiAdoUrl,
      featureAdoId: result.featureAdoId,
      featureAdoUrl: result.featureAdoUrl,
    });
  } catch (error: any) {
    console.error('Error creating ADO PBI:', error);
    res.status(500).json({ error: 'Failed to create ADO PBI', details: error.message });
  }
});

// POST /api/backlog/create-feature-ado-item - Create a single Feature in ADO (and its approved child PBIs without an ADO link)
router.post('/backlog/create-feature-ado-item', async (req: Request, res: Response) => {
  try {
    const { featureId, document, project, areaPath } = req.body as {
      featureId?: string;
      document?: any;
      project?: string;
      areaPath?: string;
    };

    if (!featureId || typeof featureId !== 'string') {
      return res.status(400).json({ error: 'featureId is required' });
    }
    if (!document || typeof document !== 'object') {
      return res.status(400).json({ error: 'document is required' });
    }

    const feature = (document.features ?? []).find((f: any) => f.id === featureId);
    if (!feature) return res.status(404).json({ error: `Feature ${featureId} not found in document` });
    if (feature.adoWorkItemId) return res.status(422).json({ error: 'Feature already has an ADO work item' });

    const isReady = (s: string) => s === 'Approved' || s === 'Merged';
    if (!isReady(feature.status)) {
      return res.status(422).json({ error: 'Feature must be Approved or Merged before creating in ADO' });
    }

    // Resolve parent Epic's ADO ID so the Feature can be linked
    const parentEpic = (document.epics ?? []).find((e: any) => e.id === feature.parentId);
    const parentEpicAdoId = parentEpic?.adoWorkItemId as number | undefined;

    // Only push child PBIs that are Approved/Merged and not yet in ADO
    const eligiblePBIs = ((document.pbis ?? []) as any[]).filter(
      (p: any) => p.parentId === featureId && isReady(p.status) && !p.adoWorkItemId
    );

    // Resolve Figma URLs (design-ready mocks only)
    const featureFigmaUrl = feature.uiMock?.designReady && feature.uiMock?.figmaUrl
      ? feature.uiMock.figmaUrl as string
      : undefined;
    const eligiblePBIsWithFigma = eligiblePBIs.map((p: any) => {
      const view = ((feature.uiMock?.views ?? []) as any[]).find((v: any) => v.pbiId === p.id);
      return {
        ...p,
        figmaUrl: view?.designReady && view?.figmaUrl ? view.figmaUrl as string : undefined,
      };
    });

    const adoService = new AzureDevOpsService(project, areaPath);
    const result = await adoService.createSingleFeatureInADO(
      { ...feature, figmaUrl: featureFigmaUrl },
      eligiblePBIsWithFigma,
      parentEpicAdoId
    );

    // Tag the feature if it has an approved AI-generated UI mock
    if (feature.uiMock?.status === 'approved') {
      try {
        await adoService.addTagToWorkItem(result.featureAdoId, 'ai-generated-ui');
      } catch (tagErr) {
        console.warn(`Could not add ai-generated-ui tag to ADO item ${result.featureAdoId}:`, tagErr);
      }
    }

    res.json({
      success: true,
      featureAdoId: result.featureAdoId,
      featureAdoUrl: result.featureAdoUrl,
      pbiMap: result.pbiMap,
    });
  } catch (error: any) {
    console.error('Error creating ADO Feature:', error);
    res.status(500).json({ error: 'Failed to create ADO Feature', details: error.message });
  }
});

// POST /api/backlog/generate-feature - Generate a Feature + PBIs via Bedrock AI
router.post('/backlog/generate-feature', async (req: Request, res: Response) => {
  try {
    const { epicId, document, userRequest } = req.body as {
      epicId?: string;
      document?: any;
      userRequest?: string;
    };

    if (!epicId || typeof epicId !== 'string') {
      return res.status(400).json({ error: 'epicId is required' });
    }
    if (!document || typeof document !== 'object') {
      return res.status(400).json({ error: 'document is required' });
    }
    if (!userRequest || typeof userRequest !== 'string' || !userRequest.trim()) {
      return res.status(400).json({ error: 'userRequest is required' });
    }

    const epic = (document.epics ?? []).find((e: any) => e.id === epicId);
    if (!epic) {
      return res.status(404).json({ error: `Epic ${epicId} not found in document` });
    }

    const existingFeatures = (document.features ?? []).filter((f: any) => f.parentId === epicId);

    const { generateFeatureFromBedrock } = await import('../services/bedrockService');
    const generated = await generateFeatureFromBedrock({
      epicTitle: epic.title,
      epicDescription: epic.description,
      epicTags: epic.tags,
      existingFeatures,
      userRequest: userRequest.trim(),
    });

    res.json(generated);
  } catch (error: any) {
    if (error.name === 'BedrockModelRefusalError') {
      return res.status(422).json({ error: error.message });
    }
    console.error('Error generating Feature via Bedrock:', error);
    res.status(500).json({
      error: 'Failed to generate Feature',
      details: error.message,
      code: error.name ?? error.Code,
    });
  }
});

// POST /api/backlog/generate-pbi - Generate a PBI via Bedrock AI
router.post('/backlog/generate-pbi', async (req: Request, res: Response) => {
  try {
    const { featureId, document, userRequest } = req.body as {
      featureId?: string;
      document?: any;
      userRequest?: string;
    };

    if (!featureId || typeof featureId !== 'string') {
      return res.status(400).json({ error: 'featureId is required' });
    }
    if (!document || typeof document !== 'object') {
      return res.status(400).json({ error: 'document is required' });
    }
    if (!userRequest || typeof userRequest !== 'string' || !userRequest.trim()) {
      return res.status(400).json({ error: 'userRequest is required' });
    }

    const feature = (document.features ?? []).find((f: any) => f.id === featureId);
    if (!feature) {
      return res.status(404).json({ error: `Feature ${featureId} not found in document` });
    }

    const existingPBIs = (document.pbis ?? []).filter((p: any) => p.parentId === featureId);

    const { generatePBIFromBedrock } = await import('../services/bedrockService');
    const generated = await generatePBIFromBedrock({
      featureTitle: feature.title,
      featureDescription: feature.description,
      featureTags: feature.tags,
      existingPBIs,
      userRequest: userRequest.trim(),
    });

    res.json(generated);
  } catch (error: any) {
    if (error.name === 'BedrockModelRefusalError') {
      return res.status(422).json({ error: error.message });
    }
    console.error('Error generating PBI via Bedrock:', error);
    res.status(500).json({
      error: 'Failed to generate PBI',
      details: error.message,
      code: error.name ?? error.Code,
    });
  }
});

// POST /api/backlog/resolve-clarification - Answer a clarification question via Bedrock AI
router.post('/backlog/resolve-clarification', async (req: Request, res: Response) => {
  try {
    const {
      nodeId,
      workItemType,
      pagePath,
      document,
      project,
      areaPath,
      clarificationResponses,
      // Legacy fallback fields
      clarificationQuestion,
      userAnswer,
    } = req.body as {
      nodeId?: string;
      workItemType?: 'Epic' | 'Feature' | 'PBI';
      pagePath?: string;
      document?: any;
      project?: string;
      areaPath?: string;
      clarificationResponses?: { businessClarifications?: any[]; uiUxClarifications?: any[] };
      clarificationQuestion?: string;
      userAnswer?: string;
    };

    if (!nodeId || !workItemType || !pagePath || !document) {
      return res.status(400).json({ error: 'nodeId, workItemType, pagePath, and document are required' });
    }

    // Accept either new structured responses or legacy single-question answer
    const hasStructuredResponses =
      clarificationResponses &&
      ((clarificationResponses.businessClarifications?.length ?? 0) > 0 ||
        (clarificationResponses.uiUxClarifications?.length ?? 0) > 0);
    const hasLegacyAnswer = clarificationQuestion && userAnswer?.trim();

    if (!hasStructuredResponses && !hasLegacyAnswer) {
      return res.status(400).json({
        error: 'clarificationResponses (with at least one answer) or clarificationQuestion + userAnswer are required',
      });
    }

    // ── Locate the node and build context for Bedrock ──────────────
    let node: any;
    let parentType: string | undefined;
    let parentTitle: string | undefined;
    let existingChildren: Array<{ id: string; title: string; workItemType: string }> = [];

    if (workItemType === 'Epic') {
      node = (document.epics ?? []).find((e: any) => e.id === nodeId);
      existingChildren = (document.features ?? [])
        .filter((f: any) => f.parentId === nodeId)
        .map((f: any) => ({ id: f.id, title: f.title, workItemType: 'Feature' }));
    } else if (workItemType === 'Feature') {
      node = (document.features ?? []).find((f: any) => f.id === nodeId);
      const parentEpic = (document.epics ?? []).find((e: any) => e.id === node?.parentId);
      if (parentEpic) { parentType = 'Epic'; parentTitle = parentEpic.title; }
      existingChildren = (document.pbis ?? [])
        .filter((p: any) => p.parentId === nodeId)
        .map((p: any) => ({ id: p.id, title: p.title, workItemType: 'PBI' }));
    } else {
      // PBI — pass sibling PBIs so Bedrock understands the landscape
      node = (document.pbis ?? []).find((p: any) => p.id === nodeId);
      const parentFeature = (document.features ?? []).find((f: any) => f.id === node?.parentId);
      if (parentFeature) { parentType = 'Feature'; parentTitle = parentFeature.title; }
      existingChildren = (document.pbis ?? [])
        .filter((p: any) => p.parentId === node?.parentId && p.id !== nodeId)
        .map((p: any) => ({ id: p.id, title: p.title, workItemType: 'PBI' }));
    }

    if (!node) {
      return res.status(404).json({ error: `${workItemType} ${nodeId} not found in document` });
    }

    // ── Call Bedrock ───────────────────────────────────────────────
    const { resolveClarificationWithBedrock } = await import('../services/bedrockService');
    const result = await resolveClarificationWithBedrock({
      workItemType,
      title: node.title,
      description: node.description,
      clarificationResponses: hasStructuredResponses ? clarificationResponses : undefined,
      clarificationQuestion: hasLegacyAnswer ? clarificationQuestion : undefined,
      userAnswer: hasLegacyAnswer ? (userAnswer as string).trim() : undefined,
      parentType,
      parentTitle,
      existingChildren,
    });

    // ── Helpers ────────────────────────────────────────────────────
    const nextFeatId = (): string =>
      generateBacklogId('FEAT', (document.features ?? []).map((f: any) => f.id));

    const nextPBIId = (existingPBIs: any[]): string =>
      generateBacklogId('PBI', existingPBIs.map((p: any) => p.id));

    const clearClarification = (n: any) => ({
      ...n,
      clarificationNeeded: undefined,
      businessClarifications: undefined,
      uiUxClarifications: undefined,
    });

    // ── Apply result ───────────────────────────────────────────────
    let updatedDoc = { ...document };
    let responsePayload: any = { success: true, action: result.action, reasoning: result.reasoning };

    // ── update ──────────────────────────────────────────────────────
    if (result.action === 'update' && result.updatedFields) {
      const f = result.updatedFields;
      const updatedNode = {
        ...node,
        ...(f.description !== undefined && { description: f.description }),
        // Always clear all clarification forms when Bedrock accepts the answer
        clarificationNeeded: f.clarificationNeeded || undefined,
        businessClarifications: undefined,
        uiUxClarifications: undefined,
        ...(f.priority !== undefined && { priority: f.priority }),
        ...(f.confidence !== undefined && { confidence: f.confidence }),
        ...(f.tags !== undefined && { tags: f.tags }),
        ...(f.acceptanceCriteria !== undefined && workItemType === 'PBI' && {
          acceptanceCriteria: f.acceptanceCriteria.length > 0 ? f.acceptanceCriteria : undefined,
        }),
      };

      if (workItemType === 'Epic') {
        updatedDoc = { ...document, epics: document.epics.map((e: any) => e.id === nodeId ? updatedNode : e) };
      } else if (workItemType === 'Feature') {
        updatedDoc = { ...document, features: document.features.map((f2: any) => f2.id === nodeId ? updatedNode : f2) };
      } else {
        updatedDoc = { ...document, pbis: document.pbis.map((p: any) => p.id === nodeId ? updatedNode : p) };
      }

      // Build human-readable list of which fields actually changed
      const changedFields: string[] = [];
      if (f.description !== undefined) changedFields.push('Description');
      if (f.priority !== undefined) changedFields.push('Priority');
      if (f.confidence !== undefined) changedFields.push('Confidence');
      if (f.tags !== undefined) changedFields.push('Tags');
      if (f.acceptanceCriteria !== undefined && workItemType === 'PBI') changedFields.push('Acceptance Criteria');

      responsePayload = {
        ...responsePayload,
        updatedItemType: workItemType,
        updatedItemTitle: node.title,
        changedFields,
      };
    }

    // ── create-feature (Epic only) ───────────────────────────────────
    else if (result.action === 'create-feature' && result.newFeature) {
      const feat = result.newFeature;
      const newFeatId = nextFeatId();

      const newFeature = {
        id: newFeatId,
        parentId: nodeId,
        workItemType: 'Feature',
        status: 'Draft',
        title: feat.title,
        description: feat.description || undefined,
        priority: feat.priority || undefined,
        confidence: feat.confidence || undefined,
        tags: feat.tags?.length > 0 ? feat.tags : undefined,
        clarificationNeeded: feat.clarificationNeeded || undefined,
      };

      // Build PBIs that come bundled with the new feature
      const bundledPBIs: any[] = [];
      if (feat.pbis && feat.pbis.length > 0) {
        let runningPBIs = [...(document.pbis ?? [])];
        for (const pbiDef of feat.pbis) {
          const newPBIId = nextPBIId(runningPBIs);
          const newPBI = {
            id: newPBIId,
            parentId: newFeatId,
            workItemType: 'PBI',
            status: 'Draft',
            title: pbiDef.title,
            description: pbiDef.description || undefined,
            acceptanceCriteria: pbiDef.acceptanceCriteria?.length ? pbiDef.acceptanceCriteria : undefined,
            priority: pbiDef.priority || undefined,
            confidence: pbiDef.confidence || undefined,
            tags: pbiDef.tags?.length > 0 ? pbiDef.tags : undefined,
          };
          bundledPBIs.push(newPBI);
          runningPBIs = [...runningPBIs, newPBI];
        }
      }

      // Clear clarification on the epic
      const clearedEpic = clearClarification(node);
      updatedDoc = {
        ...document,
        epics: document.epics.map((e: any) => e.id === nodeId ? clearedEpic : e),
        features: [...(document.features ?? []), newFeature],
        pbis: [...(document.pbis ?? []), ...bundledPBIs],
      };

      responsePayload = {
        ...responsePayload,
        featureTitle: newFeature.title,
        featureId: newFeatId,
        featurePriority: newFeature.priority,
        pbisCreated: bundledPBIs.length,
        bundledPbiTitles: bundledPBIs.map((p: any) => p.title),
        clearedItemType: workItemType,
        clearedItemTitle: node.title,
      };
    }

    // ── create-pbi ───────────────────────────────────────────────────
    else if (result.action === 'create-pbi' && result.newPBI) {
      const pbiDef = result.newPBI;

      // Determine the parent Feature ID:
      //   Epic level  → targetFeatureId from Bedrock (falls back to first feature under this epic)
      //   Feature level → current node (nodeId)
      //   PBI level   → the PBI's own parentId (sibling under same feature)
      let pbiParentId: string;
      if (workItemType === 'Epic') {
        pbiParentId = pbiDef.targetFeatureId
          ?? (document.features ?? []).find((f: any) => f.parentId === nodeId)?.id
          ?? nodeId;
      } else if (workItemType === 'Feature') {
        pbiParentId = nodeId;
      } else {
        // PBI-level: sibling
        pbiParentId = node.parentId ?? nodeId;
      }

      const newPBIId = nextPBIId(document.pbis ?? []);
      const newPBI = {
        id: newPBIId,
        parentId: pbiParentId,
        workItemType: 'PBI',
        status: 'Draft',
        title: pbiDef.title,
        description: pbiDef.description || undefined,
        acceptanceCriteria: pbiDef.acceptanceCriteria?.length ? pbiDef.acceptanceCriteria : undefined,
        priority: pbiDef.priority || undefined,
        confidence: pbiDef.confidence || undefined,
        tags: pbiDef.tags?.length > 0 ? pbiDef.tags : undefined,
      };

      // Clear clarification on the current node
      const clearedNode = clearClarification(node);
      let updatedEpics = document.epics;
      let updatedFeatures = document.features ?? [];
      let updatedPBIs = [...(document.pbis ?? []), newPBI];

      if (workItemType === 'Epic') {
        updatedEpics = document.epics.map((e: any) => e.id === nodeId ? clearedNode : e);
      } else if (workItemType === 'Feature') {
        updatedFeatures = updatedFeatures.map((f: any) => f.id === nodeId ? clearedNode : f);
      } else {
        updatedPBIs = updatedPBIs.map((p: any) => p.id === nodeId ? clearedNode : p);
      }

      updatedDoc = { ...document, epics: updatedEpics, features: updatedFeatures, pbis: updatedPBIs };

      // Find the parent feature title for the response
      const parentFeat = (document.features ?? []).find((f: any) => f.id === pbiParentId);
      responsePayload = {
        ...responsePayload,
        pbiTitle: newPBI.title,
        pbiId: newPBIId,
        pbiPriority: newPBI.priority,
        parentFeatureTitle: parentFeat?.title,
        clearedItemType: workItemType,
        clearedItemTitle: node.title,
      };
    }

    // ── Save to wiki ───────────────────────────────────────────────
    const adoService = new AzureDevOpsService(project, areaPath);
    await adoService.updateDraftBacklogDoc(pagePath, updatedDoc);

    res.json(responsePayload);
  } catch (error: any) {
    console.error('Error resolving clarification via Bedrock:', error);
    if (error.message?.startsWith('WIKI_CONFLICT')) {
      return res.status(409).json({ error: error.message });
    }
    if (error.name === 'BedrockModelRefusalError') {
      return res.status(422).json({ error: error.message });
    }
    res.status(500).json({
      error: 'Failed to resolve clarification',
      details: error.message,
      code: error.name ?? error.Code,
    });
  }
});

// POST /api/backlog/generate-ui-mock - Generate a UI mock for a Feature via Bedrock AI
router.post('/backlog/generate-ui-mock', async (req: Request, res: Response) => {
  try {
    const { featureId, document, project, areaPath, additionalContext } = req.body as {
      featureId?: string;
      document?: any;
      project?: string;
      areaPath?: string;
      additionalContext?: string;
    };

    if (!featureId || !document) {
      return res.status(400).json({ error: 'featureId and document are required' });
    }

    const feature = (document.features ?? []).find((f: any) => f.id === featureId);
    if (!feature) {
      return res.status(404).json({ error: `Feature ${featureId} not found in document` });
    }

    const parentEpic = (document.epics ?? []).find((e: any) => e.id === feature.parentId);
    const childPBIs = (document.pbis ?? []).filter((p: any) => p.parentId === featureId);
    const allAC: string[] = childPBIs.flatMap((p: any) => p.acceptanceCriteria ?? []);

    const { getDesignSystemCatalog } = await import('../services/designSystemService');
    const { generateUiMockFromBedrock } = await import('../services/bedrockService');
    const { sanitizeMockHtml } = await import('../utils/htmlSanitizer');

    const catalog = await getDesignSystemCatalog();
    const result = await generateUiMockFromBedrock({
      featureTitle: feature.title,
      featureDescription: feature.description,
      featureTags: feature.tags,
      acceptanceCriteria: allAC,
      epicTitle: parentEpic?.title,
      catalog,
      additionalContext: additionalContext?.trim() || undefined,
    });

    if (result.mockHtml) {
      result.mockHtml = sanitizeMockHtml(result.mockHtml);
    }

    res
      .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:;")
      .json(result);
  } catch (error: any) {
    if (error.name === 'BedrockModelTruncatedError') {
      return res.status(422).json({
        error: `The model's response exceeded the output token limit (${error.maxTokens}). Set BEDROCK_UI_MOCK_MAX_TOKENS to a higher value (e.g. 32000) and try again.`,
      });
    }
    if (error.name === 'BedrockModelRefusalError') {
      return res.status(422).json({ error: error.message });
    }
    console.error('Error generating UI mock via Bedrock:', error);
    res.status(500).json({ error: 'Failed to generate UI mock', details: error.message });
  }
});

// POST /api/backlog/regenerate-ui-mock - Regenerate UI mock with BA/PO feedback
router.post('/backlog/regenerate-ui-mock', async (req: Request, res: Response) => {
  try {
    const { featureId, document, feedback, priorHtml, priorDecision, priorTargetRoute, priorPageTitle, priorSubTabs, priorActiveSubTab } = req.body as {
      featureId?: string;
      document?: any;
      feedback?: string;
      priorHtml?: string;
      priorDecision?: string;
      priorTargetRoute?: string;
      priorPageTitle?: string;
      priorSubTabs?: string[];
      priorActiveSubTab?: string;
    };

    if (!featureId || !document || !feedback?.trim() || !priorDecision) {
      return res.status(400).json({
        error: 'featureId, document, feedback, and priorDecision are required',
      });
    }

    const feature = (document.features ?? []).find((f: any) => f.id === featureId);
    if (!feature) {
      return res.status(404).json({ error: `Feature ${featureId} not found in document` });
    }

    const childPBIs = (document.pbis ?? []).filter((p: any) => p.parentId === featureId);
    const allAC: string[] = childPBIs.flatMap((p: any) => p.acceptanceCriteria ?? []);

    const { getDesignSystemCatalog } = await import('../services/designSystemService');
    const { regenerateUiMockFromBedrock } = await import('../services/bedrockService');
    const { sanitizeMockHtml } = await import('../utils/htmlSanitizer');

    const catalog = await getDesignSystemCatalog();
    const result = await regenerateUiMockFromBedrock({
      featureTitle: feature.title,
      featureDescription: feature.description,
      featureTags: feature.tags,
      acceptanceCriteria: allAC,
      catalog,
      priorHtml: priorHtml ?? '',
      priorDecision: priorDecision as any,
      priorTargetRoute,
      priorPageTitle,
      priorSubTabs,
      priorActiveSubTab,
      feedback,
    });

    if (result.mockHtml) {
      result.mockHtml = sanitizeMockHtml(result.mockHtml);
    }

    res
      .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:;")
      .json(result);
  } catch (error: any) {
    if (error.name === 'BedrockModelTruncatedError') {
      return res.status(422).json({
        error: `The model's response exceeded the output token limit (${error.maxTokens}). Set BEDROCK_UI_MOCK_MAX_TOKENS to a higher value (e.g. 32000) and try again.`,
      });
    }
    if (error.name === 'BedrockModelRefusalError') {
      return res.status(422).json({ error: error.message });
    }
    console.error('Error regenerating UI mock via Bedrock:', error);
    res.status(500).json({ error: 'Failed to regenerate UI mock', details: error.message });
  }
});

// POST /api/backlog/generate-pbi-view
// Generates a UI mock scoped to a single PBI and stores it in feature.uiMock.views[].
// The PBI's own title/description/AC are used as primary context so the AI focuses on
// that one user story rather than the whole feature.
router.post('/backlog/generate-pbi-view', async (req: Request, res: Response) => {
  try {
    const { featureId, pbiId, document, project, areaPath, additionalContext, featureOverviewHtml, variantCount } = req.body as {
      featureId?: string;
      pbiId?: string;
      document?: any;
      project?: string;
      areaPath?: string;
      additionalContext?: string;
      featureOverviewHtml?: string;
      variantCount?: number;
    };

    if (!featureId || !pbiId || !document) {
      return res.status(400).json({ error: 'featureId, pbiId, and document are required' });
    }

    const feature = (document.features ?? []).find((f: any) => f.id === featureId);
    if (!feature) return res.status(404).json({ error: `Feature ${featureId} not found` });

    const pbi = (document.pbis ?? []).find((p: any) => p.id === pbiId);
    if (!pbi) return res.status(404).json({ error: `PBI ${pbiId} not found` });

    const parentEpic = (document.epics ?? []).find((e: any) => e.id === feature.parentId);

    const { getDesignSystemCatalog } = await import('../services/designSystemService');
    const { generateUiMockVariantsFromBedrock, synthesisePlanFromUiMock } = await import('../services/bedrockService');
    const { sanitizeMockHtml } = await import('../utils/htmlSanitizer');

    // Resolve the UI surface plan: prefer persisted feature plan, fall back to epic plan,
    // fall back to synthesising a transient plan from feature.uiMock for backward compat.
    const featureMock = feature.uiMock as any | undefined;
    const siblingViews: any[] = featureMock?.views ?? [];

    let featurePlan = feature.uiSurfacePlan
      ?? parentEpic?.uiSurfacePlan
      ?? (featureMock?.decision
          ? synthesisePlanFromUiMock(feature.id, feature.title, featureMock)
          : undefined);

    // Build legacy featureContext as fallback when no plan is available
    const featureContext = !featurePlan && featureMock?.decision
      ? {
          decision: featureMock.decision,
          targetPageRoute: featureMock.targetPageRoute,
          targetPageTitle: featureMock.targetPageTitle,
          existingSubTabs: featureMock.targetPageSubTabs ?? [],
          siblingViewTitles: siblingViews
            .filter((v: any) => v.pbiId !== pbiId)
            .map((v: any) => v.pbiTitle as string),
        }
      : undefined;

    const catalog = await getDesignSystemCatalog();
    const baseInput = {
      featureTitle: `${feature.title} — ${pbi.title}`,
      featureDescription: pbi.description ?? feature.description,
      featureTags: feature.tags,
      acceptanceCriteria: pbi.acceptanceCriteria ?? [],
      epicTitle: parentEpic?.title,
      pbiId: pbi.id,
      catalog,
      featurePlan,
      featureContext,
      additionalContext: additionalContext?.trim() || undefined,
      featureOverviewHtml: featureOverviewHtml?.trim() || undefined,
    };

    // Clamp variant count: 1–4, default 1
    const n = Math.max(1, Math.min(4, Math.floor(Number(variantCount) || 1)));
    const variants = await generateUiMockVariantsFromBedrock(baseInput, n);

    // Sanitize each variant's HTML
    for (const v of variants) {
      if (v.mockHtml) v.mockHtml = sanitizeMockHtml(v.mockHtml);
    }

    res
      .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:;")
      .json({ pbiId, pbiTitle: pbi.title, variants });
  } catch (error: any) {
    if (error.name === 'BedrockModelTruncatedError') {
      return res.status(422).json({
        error: `The model's response exceeded the output token limit (${error.maxTokens}). Set BEDROCK_UI_MOCK_MAX_TOKENS to a higher value (e.g. 32000) and try again.`,
      });
    }
    if (error.name === 'BedrockModelRefusalError') {
      return res.status(422).json({ error: error.message });
    }
    console.error('Error generating PBI view:', error);
    res.status(500).json({ error: 'Failed to generate PBI view', details: error.message });
  }
});

// POST /api/backlog/regenerate-pbi-view
// Regenerates a PBI-scoped view with BA/UX feedback.
router.post('/backlog/regenerate-pbi-view', async (req: Request, res: Response) => {
  try {
    const { featureId, pbiId, document, feedback, priorHtml, priorDecision, priorTargetRoute, priorPageTitle, priorSubTabs, priorActiveSubTab } = req.body as {
      featureId?: string;
      pbiId?: string;
      document?: any;
      feedback?: string;
      priorHtml?: string;
      priorDecision?: string;
      priorTargetRoute?: string;
      priorPageTitle?: string;
      priorSubTabs?: string[];
      priorActiveSubTab?: string;
    };

    if (!featureId || !pbiId || !document || !feedback?.trim() || !priorDecision) {
      return res.status(400).json({
        error: 'featureId, pbiId, document, feedback, and priorDecision are required',
      });
    }

    const feature = (document.features ?? []).find((f: any) => f.id === featureId);
    if (!feature) return res.status(404).json({ error: `Feature ${featureId} not found` });

    const pbi = (document.pbis ?? []).find((p: any) => p.id === pbiId);
    if (!pbi) return res.status(404).json({ error: `PBI ${pbiId} not found` });

    const { getDesignSystemCatalog } = await import('../services/designSystemService');
    const { regenerateUiMockFromBedrock, synthesisePlanFromUiMock } = await import('../services/bedrockService');
    const { sanitizeMockHtml } = await import('../utils/htmlSanitizer');

    const parentEpicForRegen = (document.epics ?? []).find((e: any) => e.id === feature.parentId);
    const featureMock = feature.uiMock as any | undefined;
    const siblingViews: any[] = featureMock?.views ?? [];

    // Resolve the UI surface plan (same priority as generate-pbi-view)
    const featurePlan = feature.uiSurfacePlan
      ?? parentEpicForRegen?.uiSurfacePlan
      ?? (featureMock?.decision
          ? synthesisePlanFromUiMock(feature.id, feature.title, featureMock)
          : undefined);

    const featureContext = !featurePlan && featureMock?.decision
      ? {
          decision: featureMock.decision,
          targetPageRoute: featureMock.targetPageRoute,
          targetPageTitle: featureMock.targetPageTitle,
          existingSubTabs: featureMock.targetPageSubTabs ?? [],
          siblingViewTitles: siblingViews
            .filter((v: any) => v.pbiId !== pbiId)
            .map((v: any) => v.pbiTitle as string),
        }
      : undefined;

    /* Fall back to plan / feature-level subtabs/title if the client didn't send
       prior view-level state (PBI views inherit page structure from the feature). */
    const effectiveSubTabs = priorSubTabs ?? featurePlan?.subTabs ?? featureMock?.targetPageSubTabs;
    const effectivePageTitle = priorPageTitle ?? featurePlan?.targetPageTitle ?? featureMock?.targetPageTitle;

    const catalog = await getDesignSystemCatalog();
    const result = await regenerateUiMockFromBedrock({
      featureTitle: `${feature.title} — ${pbi.title}`,
      featureDescription: pbi.description ?? feature.description,
      featureTags: feature.tags,
      acceptanceCriteria: pbi.acceptanceCriteria ?? [],
      pbiId: pbi.id,
      catalog,
      featurePlan,
      priorHtml: priorHtml ?? '',
      priorDecision: priorDecision as any,
      priorTargetRoute,
      priorPageTitle: effectivePageTitle,
      priorSubTabs: effectiveSubTabs,
      priorActiveSubTab,
      feedback,
      featureContext,
    });

    if (result.mockHtml) {
      result.mockHtml = sanitizeMockHtml(result.mockHtml);
    }

    res
      .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:;")
      .json({ ...result, pbiId, pbiTitle: pbi.title });
  } catch (error: any) {
    if (error.name === 'BedrockModelTruncatedError') {
      return res.status(422).json({
        error: `The model's response exceeded the output token limit (${error.maxTokens}). Set BEDROCK_UI_MOCK_MAX_TOKENS to a higher value (e.g. 32000) and try again.`,
      });
    }
    if (error.name === 'BedrockModelRefusalError') {
      return res.status(422).json({ error: error.message });
    }
    console.error('Error regenerating PBI view:', error);
    res.status(500).json({ error: 'Failed to regenerate PBI view', details: error.message });
  }
});

// POST /api/backlog/generate-ui-plan
// Generates (or regenerates) a UiSurfacePlan for an epic or feature via Bedrock AI.
// Persists the plan to the backlog draft and returns it.
router.post('/backlog/generate-ui-plan', async (req: Request, res: Response) => {
  try {
    const { scope, epicId, featureId, document, project, areaPath, additionalContext } = req.body as {
      scope?: 'epic' | 'feature';
      epicId?: string;
      featureId?: string;
      document?: any;
      project?: string;
      areaPath?: string;
      additionalContext?: string;
    };

    if (!scope || !document || (scope === 'epic' && !epicId) || (scope === 'feature' && !featureId)) {
      return res.status(400).json({ error: 'scope, document, and either epicId (epic) or featureId (feature) are required' });
    }

    const { generateUiPlanFromBedrock } = await import('../services/bedrockService');
    const { getDesignSystemCatalog } = await import('../services/designSystemService');

    const catalog = await getDesignSystemCatalog();

    let plan;
    if (scope === 'feature') {
      const feature = (document.features ?? []).find((f: any) => f.id === featureId);
      if (!feature) return res.status(404).json({ error: `Feature ${featureId} not found` });

      const parentEpic = (document.epics ?? []).find((e: any) => e.id === feature.parentId);
      const childPBIs = (document.pbis ?? []).filter((p: any) => p.parentId === featureId);

      // Find sibling features in the same epic that already have a plan targeting
      // the same route — pass them so the prompt locks the surface structure and
      // only asks the model to describe this feature's delta contributions.
      const siblingFeaturesWithPlans = ((document.features ?? []) as any[]).filter(
        (f: any) =>
          f.id !== featureId &&
          f.parentId === feature.parentId &&
          f.uiSurfacePlan?.targetPageRoute
      );

      // Determine which route this feature is likely targeting: prefer its
      // existing plan (if regenerating), then its uiMock, then the epic plan.
      const likelyRoute: string | undefined =
        feature.uiSurfacePlan?.targetPageRoute ??
        feature.uiMock?.targetPageRoute ??
        parentEpic?.uiSurfacePlan?.targetPageRoute;

      const existingSurfacePlans = likelyRoute
        ? siblingFeaturesWithPlans
            .filter((f: any) => f.uiSurfacePlan.targetPageRoute === likelyRoute)
            .map((f: any) => ({ featureTitle: f.title as string, plan: f.uiSurfacePlan }))
        : // No known route yet — look for siblings that share ANY route among themselves
          // (most common one wins — don't pass when ambiguous)
          (() => {
            const routeCounts = new Map<string, number>();
            for (const f of siblingFeaturesWithPlans) {
              const r = f.uiSurfacePlan.targetPageRoute as string;
              routeCounts.set(r, (routeCounts.get(r) ?? 0) + 1);
            }
            const dominantRoute = [...routeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
            if (!dominantRoute) return [];
            return siblingFeaturesWithPlans
              .filter((f: any) => f.uiSurfacePlan.targetPageRoute === dominantRoute)
              .map((f: any) => ({ featureTitle: f.title as string, plan: f.uiSurfacePlan }));
          })();

      plan = await generateUiPlanFromBedrock({
        scope: 'feature',
        title: feature.title,
        description: feature.description,
        epicTitle: parentEpic?.title,
        childPbis: childPBIs.map((p: any) => ({
          pbiId: p.id,
          pbiTitle: p.title,
          description: p.description,
          acceptanceCriteria: p.acceptanceCriteria ?? [],
        })),
        catalog,
        additionalContext: additionalContext?.trim() || undefined,
        epicPlan: parentEpic?.uiSurfacePlan,
        existingSurfacePlans: existingSurfacePlans.length > 0 ? existingSurfacePlans : undefined,
      });

      // Persist plan to the feature
      const adoService = new AzureDevOpsService(project, areaPath);
      const docs = await adoService.getDraftBacklogDocs() as any[];
      // Find the doc that contains this feature
      const pagePath = req.body.pagePath as string | undefined;
      const targetDoc = pagePath
        ? docs.find((d: any) => d.path === pagePath)
        : docs.find((d: any) => ((d.document?.features ?? []) as any[]).some((f: any) => f.id === featureId));
      if (targetDoc) {
        const featureInDoc = ((targetDoc.document?.features ?? []) as any[]).find((f: any) => f.id === featureId);
        if (featureInDoc) {
          featureInDoc.uiSurfacePlan = plan;
          await adoService.updateDraftBacklogDoc(targetDoc.path, targetDoc.document);
        }
      }

    } else {
      // scope === 'epic'
      const epic = (document.epics ?? []).find((e: any) => e.id === epicId);
      if (!epic) return res.status(404).json({ error: `Epic ${epicId} not found` });

      const childFeatures = (document.features ?? []).filter((f: any) => f.parentId === epicId);
      const allChildPBIs = (document.pbis ?? []).filter((p: any) =>
        childFeatures.some((f: any) => f.id === p.parentId)
      );

      plan = await generateUiPlanFromBedrock({
        scope: 'epic',
        title: epic.title,
        description: epic.description,
        childPbis: allChildPBIs.map((p: any) => ({
          pbiId: p.id,
          pbiTitle: p.title,
          description: p.description,
          acceptanceCriteria: p.acceptanceCriteria ?? [],
        })),
        siblingFeatures: childFeatures.map((f: any) => ({ title: f.title, description: f.description })),
        catalog,
        additionalContext: additionalContext?.trim() || undefined,
      });

      // Persist plan to the epic
      const adoService = new AzureDevOpsService(project, areaPath);
      const docs = await adoService.getDraftBacklogDocs() as any[];
      const pagePath = req.body.pagePath as string | undefined;
      const targetDoc = pagePath
        ? docs.find((d: any) => d.path === pagePath)
        : docs.find((d: any) => ((d.document?.epics ?? []) as any[]).some((e: any) => e.id === epicId));
      if (targetDoc) {
        const epicInDoc = ((targetDoc.document?.epics ?? []) as any[]).find((e: any) => e.id === epicId);
        if (epicInDoc) {
          epicInDoc.uiSurfacePlan = plan;
          await adoService.updateDraftBacklogDoc(targetDoc.path, targetDoc.document);
        }
      }
    }

    res.json(plan);
  } catch (error: any) {
    if (error.name === 'BedrockModelTruncatedError') {
      return res.status(422).json({ error: `Model response truncated. Increase BEDROCK_UI_MOCK_MAX_TOKENS.` });
    }
    if (error.name === 'BedrockModelRefusalError') {
      return res.status(422).json({ error: error.message });
    }
    console.error('Error generating UI plan:', error);
    res.status(500).json({ error: 'Failed to generate UI plan', details: error.message });
  }
});

// PUT /api/backlog/ui-plan
// Saves a manually edited UiSurfacePlan to the backlog draft.
// Bumps planVersion and updatedAt without calling Bedrock.
router.put('/backlog/ui-plan', async (req: Request, res: Response) => {
  try {
    const { scope, epicId, featureId, plan, pagePath, project, areaPath } = req.body as {
      scope?: 'epic' | 'feature';
      epicId?: string;
      featureId?: string;
      plan?: any;
      pagePath?: string;
      project?: string;
      areaPath?: string;
    };

    if (!scope || !plan || !pagePath || (scope === 'epic' && !epicId) || (scope === 'feature' && !featureId)) {
      return res.status(400).json({ error: 'scope, plan, pagePath, and either epicId or featureId are required' });
    }

    const adoService = new AzureDevOpsService(project, areaPath);
    const docs = await adoService.getDraftBacklogDocs() as any[];
    const doc = docs.find((d: any) => d.path === pagePath);
    if (!doc) return res.status(404).json({ error: `Page "${pagePath}" not found` });

    const updatedPlan = {
      ...plan,
      planVersion: (plan.planVersion ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };

    if (scope === 'feature') {
      const feature = ((doc.document?.features ?? []) as any[]).find((f: any) => f.id === featureId);
      if (!feature) return res.status(404).json({ error: `Feature ${featureId} not found` });
      feature.uiSurfacePlan = updatedPlan;
    } else {
      const epic = ((doc.document?.epics ?? []) as any[]).find((e: any) => e.id === epicId);
      if (!epic) return res.status(404).json({ error: `Epic ${epicId} not found` });
      epic.uiSurfacePlan = updatedPlan;
    }

    await adoService.updateDraftBacklogDoc(pagePath, doc.document);
    res.json(updatedPlan);
  } catch (error: any) {
    console.error('Error saving UI plan:', error);
    res.status(500).json({ error: 'Failed to save UI plan', details: error.message });
  }
});

// POST /api/backlog/derive-feature-plan-from-epic
// Seeds a feature plan from its epic plan, then refines via Bedrock for feature-specific PBI contributions.
router.post('/backlog/derive-feature-plan-from-epic', async (req: Request, res: Response) => {
  try {
    const { epicId, featureId, document, project, areaPath, additionalContext } = req.body as {
      epicId?: string;
      featureId?: string;
      document?: any;
      project?: string;
      areaPath?: string;
      additionalContext?: string;
    };

    if (!epicId || !featureId || !document) {
      return res.status(400).json({ error: 'epicId, featureId, and document are required' });
    }

    const epic = (document.epics ?? []).find((e: any) => e.id === epicId);
    if (!epic) return res.status(404).json({ error: `Epic ${epicId} not found` });
    if (!epic.uiSurfacePlan) return res.status(400).json({ error: `Epic ${epicId} has no UI surface plan — generate one first` });

    const feature = (document.features ?? []).find((f: any) => f.id === featureId);
    if (!feature) return res.status(404).json({ error: `Feature ${featureId} not found` });

    const childPBIs = (document.pbis ?? []).filter((p: any) => p.parentId === featureId);

    const { generateUiPlanFromBedrock } = await import('../services/bedrockService');
    const { getDesignSystemCatalog } = await import('../services/designSystemService');

    const catalog = await getDesignSystemCatalog();

    // Same sibling-plan lookup as /generate-ui-plan: find features in this epic
    // that already have a plan for the same route the epic plan targets.
    const epicRoute: string | undefined = epic.uiSurfacePlan?.targetPageRoute;
    const siblingFeaturesWithPlans = ((document.features ?? []) as any[]).filter(
      (f: any) =>
        f.id !== featureId &&
        f.parentId === epicId &&
        f.uiSurfacePlan?.targetPageRoute
    );
    const existingSurfacePlans = epicRoute
      ? siblingFeaturesWithPlans
          .filter((f: any) => f.uiSurfacePlan.targetPageRoute === epicRoute)
          .map((f: any) => ({ featureTitle: f.title as string, plan: f.uiSurfacePlan }))
      : [];

    const plan = await generateUiPlanFromBedrock({
      scope: 'feature',
      title: feature.title,
      description: feature.description,
      epicTitle: epic.title,
      childPbis: childPBIs.map((p: any) => ({
        pbiId: p.id,
        pbiTitle: p.title,
        description: p.description,
        acceptanceCriteria: p.acceptanceCriteria ?? [],
      })),
      catalog,
      additionalContext: additionalContext?.trim() || undefined,
      epicPlan: epic.uiSurfacePlan,
      existingSurfacePlans: existingSurfacePlans.length > 0 ? existingSurfacePlans : undefined,
    });
    // Mark as inherited
    (plan as any).inheritedFromEpicId = epicId;

    const adoService = new AzureDevOpsService(project, areaPath);
    const docs = await adoService.getDraftBacklogDocs() as any[];
    const pagePath = req.body.pagePath as string | undefined;
    const targetDoc = pagePath
      ? docs.find((d: any) => d.path === pagePath)
      : docs.find((d: any) => ((d.document?.features ?? []) as any[]).some((f: any) => f.id === featureId));
    if (targetDoc) {
      const featureInDoc = ((targetDoc.document?.features ?? []) as any[]).find((f: any) => f.id === featureId);
      if (featureInDoc) {
        featureInDoc.uiSurfacePlan = plan;
        await adoService.updateDraftBacklogDoc(targetDoc.path, targetDoc.document);
      }
    }

    res.json(plan);
  } catch (error: any) {
    if (error.name === 'BedrockModelTruncatedError') {
      return res.status(422).json({ error: `Model response truncated. Increase BEDROCK_UI_MOCK_MAX_TOKENS.` });
    }
    if (error.name === 'BedrockModelRefusalError') {
      return res.status(422).json({ error: error.message });
    }
    console.error('Error deriving feature plan from epic:', error);
    res.status(500).json({ error: 'Failed to derive feature plan', details: error.message });
  }
});

// GET /api/backlog/mock-html/:featureId
// Returns the approved mock as a standalone HTML page so generate_figma_design can capture it.
router.get('/backlog/mock-html/:featureId', async (req: Request, res: Response) => {
  try {
    const { featureId } = req.params;
    const { pagePath, project, areaPath, pbiId } = req.query as {
      pagePath?: string;
      project?: string;
      areaPath?: string;
      pbiId?: string;
    };

    if (!pagePath) {
      return res.status(400).send('pagePath query param is required');
    }

    // When the request was authorized via an agent token (production path),
    // ensure the token's claims match the requested resource. Localhost-bypassed
    // requests have no token and skip this check (it's a same-machine dev call).
    const claims = (req as Request & { agentToken?: AgentTokenClaims }).agentToken;
    if (claims) {
      if (claims.featureId !== featureId) {
        return res.status(403).send('Agent token featureId mismatch');
      }
      if ((claims.pbiId ?? undefined) !== (pbiId ?? undefined)) {
        return res.status(403).send('Agent token pbiId mismatch');
      }
    }

    const adoService = new AzureDevOpsService(project, areaPath);
    const docs = await adoService.getDraftBacklogDocs() as any[];
    const doc = docs.find((d: any) => d.path === pagePath);
    if (!doc) {
      return res.status(404).send(`Backlog page "${pagePath}" not found`);
    }

    const feature = ((doc.document?.features ?? []) as any[]).find((f: any) => f.id === featureId);
    if (!feature) {
      return res.status(404).send(`Feature ${featureId} not found`);
    }

    // When pbiId is supplied, serve the PBI-scoped view's HTML instead
    let html: string | undefined;
    if (pbiId) {
      const view = (feature.uiMock?.views ?? []).find((v: any) => v.pbiId === pbiId);
      html = view?.mockHtml as string | undefined;
      if (!html) return res.status(404).send(`No mock HTML for PBI view ${pbiId}`);
    } else {
      html = feature.uiMock?.mockHtml as string | undefined;
      if (!html) return res.status(404).send('No mock HTML for this feature');
    }

    // Inject the Figma capture script so generate_figma_design can capture this page.
    // The script is a no-op unless the #figmacapture hash param is present.
    const captureScript = '<script src="https://mcp.figma.com/mcp/html-to-design/capture.js" async></script>';
    const htmlWithCapture = html.includes('</head>')
      ? html.replace('</head>', `${captureScript}</head>`)
      : html.includes('<body')
        ? html.replace('<body', `${captureScript}<body`)
        : captureScript + html;

    res
      .set('Content-Type', 'text/html; charset=utf-8')
      .set('Cache-Control', 'no-store')
      .send(htmlWithCapture);
  } catch (error: any) {
    console.error('Error serving mock HTML:', error);
    res.status(500).send('Failed to serve mock HTML');
  }
});

// GET /api/backlog/pending-figma-exports?project=...&areaPath=...
// Returns all features with pendingFigmaExport=true across all backlog docs.
// Called by the Cursor sessionStart hook to auto-push approved mocks to Figma.
router.get('/backlog/pending-figma-exports', async (req: Request, res: Response) => {
  try {
    const { project, areaPath } = req.query as { project?: string; areaPath?: string };
    const adoService = new AzureDevOpsService(project, areaPath);
    const docs = await adoService.getDraftBacklogDocs() as any[];

    const pending: Array<{
      featureId: string;
      featureTitle: string;
      pagePath: string;
      mockHtmlUrl: string;
      targetPageTitle: string | null;
      pbiId: string | null;
      pbiTitle?: string;
    }> = [];

    const serverPort = process.env.PORT ?? 3001;
    const baseUrl = process.env.PUBLIC_URL ?? `http://localhost:${serverPort}`;

    for (const doc of docs) {
      for (const feature of (doc.document?.features ?? []) as any[]) {
        // Feature-level mock
        if (feature.uiMock?.pendingFigmaExport && feature.uiMock?.mockHtml) {
          pending.push({
            featureId: feature.id,
            featureTitle: feature.title,
            pagePath: doc.path,
            mockHtmlUrl: `${baseUrl}/api/backlog/mock-html/${encodeURIComponent(feature.id)}?pagePath=${encodeURIComponent(doc.path)}&project=${encodeURIComponent(project ?? '')}&areaPath=${encodeURIComponent(areaPath ?? '')}`,
            targetPageTitle: feature.uiMock.targetPageTitle ?? null,
            pbiId: null,
          });
        }
        // PBI-scoped views
        for (const view of (feature.uiMock?.views ?? []) as any[]) {
          if (view.pendingFigmaExport && view.mockHtml) {
            pending.push({
              featureId: feature.id,
              featureTitle: feature.title,
              pagePath: doc.path,
              mockHtmlUrl: `${baseUrl}/api/backlog/mock-html/${encodeURIComponent(feature.id)}?pagePath=${encodeURIComponent(doc.path)}&project=${encodeURIComponent(project ?? '')}&areaPath=${encodeURIComponent(areaPath ?? '')}&pbiId=${encodeURIComponent(view.pbiId)}`,
              targetPageTitle: view.targetPageTitle ?? null,
              pbiId: view.pbiId,
              pbiTitle: view.pbiTitle,
            });
          }
        }
      }
    }

    res.json({ pending });
  } catch (error: any) {
    console.error('Error fetching pending Figma exports:', error);
    res.status(500).json({ error: 'Failed to fetch pending Figma exports', details: error.message });
  }
});

// POST /api/backlog/approve-mock
// Approves a UI mock, persists pendingFigmaExport=true, then fires the
// Cursor headless agent to create the Figma design automatically.
// The agent calls /api/backlog/update-figma-url when done.
router.post('/backlog/approve-mock', async (req: Request, res: Response) => {
  try {
    const { featureId, pagePath, project, areaPath, approvedVersion } = req.body as {
      featureId?: string;
      pagePath?: string;
      project?: string;
      areaPath?: string;
      approvedVersion?: number;
    };

    if (!featureId || !pagePath) {
      return res.status(400).json({ error: 'featureId and pagePath are required' });
    }

    const adoService = new AzureDevOpsService(project, areaPath);
    const docs = await adoService.getDraftBacklogDocs() as any[];
    const doc = docs.find((d: any) => d.path === pagePath);
    if (!doc) return res.status(404).json({ error: `Page "${pagePath}" not found` });

    const feature = ((doc.document?.features ?? []) as any[]).find((f: any) => f.id === featureId);
    if (!feature?.uiMock) return res.status(404).json({ error: `Feature ${featureId} or its uiMock not found` });

    // If approving a specific historical version, promote its HTML so Figma export uses it
    if (approvedVersion != null && approvedVersion !== feature.uiMock.mockVersion) {
      const entry = (feature.uiMock.history ?? []).find((h: any) => h.version === approvedVersion);
      if (!entry) return res.status(400).json({ error: `Version ${approvedVersion} not found in mock history` });
      feature.uiMock.mockHtml = entry.mockHtml;
      feature.uiMock.decision = entry.decision;
      feature.uiMock.rationale = entry.rationale;
      feature.uiMock.targetPageRoute = entry.targetPageRoute;
      feature.uiMock.targetPageTitle = entry.targetPageTitle;
    }

    // Mark as approved. The Figma import is now an explicit, user-initiated
    // action via the "Import to Figma" button, so we no longer auto-queue
    // it here. Existing pendingFigmaExport flags remain backward-compatible.
    feature.uiMock.status = 'approved';
    feature.uiMock.approvedVersion = approvedVersion ?? feature.uiMock.mockVersion;
    feature.uiMock.pendingFigmaExport = false;

    await adoService.updateDraftBacklogDoc(pagePath, doc.document);

    // If this feature already has an ADO work item, tag it now — the mock has been approved
    const adoWorkItemId = feature.adoWorkItemId as number | undefined;
    if (adoWorkItemId) {
      try {
        await adoService.addTagToWorkItem(adoWorkItemId, 'ai-generated-ui');
      } catch (tagErr) {
        console.warn(`Could not add ai-generated-ui tag to ADO item ${adoWorkItemId}:`, tagErr);
      }
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error('Error approving mock:', error);
    res.status(500).json({ error: 'Failed to approve mock', details: error.message });
  }
});

// POST /api/backlog/delete-mock-version
// Removes a specific version from a mock's history array.
// If the deleted version is the current (latest) version, the most recent remaining
// history entry is promoted to become the new current version.
// Returns the updated mock object so the client can sync state without a full reload.
router.post('/backlog/delete-mock-version', async (req: Request, res: Response) => {
  try {
    const { featureId, pbiId, pagePath, version, project, areaPath } = req.body as {
      featureId?: string;
      pbiId?: string;
      pagePath?: string;
      version?: number;
      project?: string;
      areaPath?: string;
    };

    if (!featureId || !pagePath || version == null) {
      return res.status(400).json({ error: 'featureId, pagePath, and version are required' });
    }

    const adoService = new AzureDevOpsService(project, areaPath);
    const docs = await adoService.getDraftBacklogDocs() as any[];
    const doc = docs.find((d: any) => d.path === pagePath);
    if (!doc) return res.status(404).json({ error: `Page "${pagePath}" not found` });

    const feature = ((doc.document?.features ?? []) as any[]).find((f: any) => f.id === featureId);
    if (!feature?.uiMock) return res.status(404).json({ error: `Feature ${featureId} or its uiMock not found` });

    // Target the feature-level mock or a PBI view
    const target: any = pbiId
      ? (feature.uiMock.views ?? []).find((v: any) => v.pbiId === pbiId)
      : feature.uiMock;

    if (!target) return res.status(404).json({ error: pbiId ? `PBI view ${pbiId} not found` : 'uiMock not found' });

    const history: any[] = target.history ?? [];

    const entryIdx = history.findIndex((h: any) => h.version === version);
    if (entryIdx === -1) return res.status(404).json({ error: `Version ${version} not found in history` });

    // If this is the only version, discard the entire mock
    if (history.length === 1) {
      if (pbiId) {
        feature.uiMock.views = (feature.uiMock.views ?? []).filter((v: any) => v.pbiId !== pbiId);
      } else {
        feature.uiMock = undefined;
      }
      await adoService.updateDraftBacklogDoc(pagePath, doc.document);
      return res.json({ success: true, discarded: true });
    }

    // Remove the entry
    history.splice(entryIdx, 1);
    target.history = history;

    // If we just deleted the current version, promote the most recent remaining entry
    if (version === target.mockVersion) {
      const promoted = [...history].sort((a: any, b: any) => b.version - a.version)[0];
      target.mockVersion = promoted.version;
      target.mockHtml = promoted.mockHtml;
      target.decision = promoted.decision;
      target.rationale = promoted.rationale;
      target.targetPageRoute = promoted.targetPageRoute;
      target.targetPageTitle = promoted.targetPageTitle;
      target.status = 'draft';
      target.approvedVersion = undefined;
      target.pendingFigmaExport = false;
    }

    await adoService.updateDraftBacklogDoc(pagePath, doc.document);
    res.json({ success: true, discarded: false, mock: pbiId ? target : feature.uiMock });
  } catch (error: any) {
    console.error('Error deleting mock version:', error);
    res.status(500).json({ error: 'Failed to delete mock version', details: error.message });
  }
});

// POST /api/backlog/clear-figma-pending
// Clears pendingFigmaExport on a feature's uiMock (used by the ✕ reset button).
router.post('/backlog/clear-figma-pending', async (req: Request, res: Response) => {
  try {
    const { featureId, pagePath, project, areaPath } = req.body as {
      featureId?: string;
      pagePath?: string;
      project?: string;
      areaPath?: string;
    };

    if (!featureId || !pagePath) {
      return res.status(400).json({ error: 'featureId and pagePath are required' });
    }

    const adoService = new AzureDevOpsService(project, areaPath);
    const docs = await adoService.getDraftBacklogDocs() as any[];
    const doc = docs.find((d: any) => d.path === pagePath);
    if (!doc) return res.status(404).json({ error: `Page "${pagePath}" not found` });

    const feature = ((doc.document?.features ?? []) as any[]).find((f: any) => f.id === featureId);
    if (!feature?.uiMock) return res.status(404).json({ error: `Feature ${featureId} or its uiMock not found` });

    feature.uiMock.pendingFigmaExport = false;

    await adoService.updateDraftBacklogDoc(pagePath, doc.document);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error clearing Figma pending:', error);
    res.status(500).json({ error: 'Failed to clear Figma pending', details: error.message });
  }
});

// POST /api/backlog/approve-pbi-view
// Approves a PBI-scoped view within feature.uiMock.views[], setting pendingFigmaExport=true.
router.post('/backlog/approve-pbi-view', async (req: Request, res: Response) => {
  try {
    const { featureId, pbiId, pagePath, project, areaPath, approvedVersion } = req.body as {
      featureId?: string;
      pbiId?: string;
      pagePath?: string;
      project?: string;
      areaPath?: string;
      approvedVersion?: number;
    };

    if (!featureId || !pbiId || !pagePath) {
      return res.status(400).json({ error: 'featureId, pbiId, and pagePath are required' });
    }

    const adoService = new AzureDevOpsService(project, areaPath);
    const docs = await adoService.getDraftBacklogDocs() as any[];
    const doc = docs.find((d: any) => d.path === pagePath);
    if (!doc) return res.status(404).json({ error: `Page "${pagePath}" not found` });

    const feature = ((doc.document?.features ?? []) as any[]).find((f: any) => f.id === featureId);
    if (!feature?.uiMock) return res.status(404).json({ error: `Feature ${featureId} or its uiMock not found` });

    const view = (feature.uiMock.views ?? []).find((v: any) => v.pbiId === pbiId);
    if (!view) return res.status(404).json({ error: `PBI view ${pbiId} not found on feature ${featureId}` });

    // If approving a specific historical version, promote its HTML so Figma export uses it
    if (approvedVersion != null && approvedVersion !== view.mockVersion) {
      const entry = (view.history ?? []).find((h: any) => h.version === approvedVersion);
      if (!entry) return res.status(400).json({ error: `Version ${approvedVersion} not found in PBI view history` });
      view.mockHtml = entry.mockHtml;
      view.decision = entry.decision;
      view.rationale = entry.rationale;
      view.targetPageRoute = entry.targetPageRoute;
      view.targetPageTitle = entry.targetPageTitle;
    }

    // Figma import is now user-initiated via the "Import to Figma" button,
    // not auto-queued — see /approve-mock for context.
    view.status = 'approved';
    view.approvedVersion = approvedVersion ?? view.mockVersion;
    view.pendingFigmaExport = false;

    await adoService.updateDraftBacklogDoc(pagePath, doc.document);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error approving PBI view:', error);
    res.status(500).json({ error: 'Failed to approve PBI view', details: error.message });
  }
});

// POST /api/backlog/mint-agent-token
// Auth-required. Mints two short-lived HMAC-signed tokens scoped to a single
// feature (and optional PBI) so the Cursor agent — which runs on the user's
// local machine and has no browser session cookie — can call:
//   - GET  /api/backlog/mock-html/:featureId   (read token)
//   - POST /api/backlog/update-figma-url       (write token)
// in production. In local dev the localhost bypass already covers the agent,
// but minting still works there too so the same client code path is used in
// both environments.
router.post('/backlog/mint-agent-token', async (req: Request, res: Response) => {
  try {
    const { featureId, pbiId, ttlSeconds } = req.body as {
      featureId?: string;
      pbiId?: string;
      ttlSeconds?: number;
    };

    if (!featureId || typeof featureId !== 'string') {
      return res.status(400).json({ error: 'featureId is required' });
    }
    if (pbiId !== undefined && typeof pbiId !== 'string') {
      return res.status(400).json({ error: 'pbiId must be a string when provided' });
    }
    // Cap TTL to 2h so a leaked token has a bounded lifetime even if the
    // client requests a longer one.
    const safeTtl = typeof ttlSeconds === 'number' && ttlSeconds > 0
      ? Math.min(ttlSeconds, 2 * 60 * 60)
      : undefined;

    const readToken = signAgentToken({ scope: 'read-mock', featureId, pbiId, ttlSeconds: safeTtl });
    const writeToken = signAgentToken({ scope: 'write-figma-url', featureId, pbiId, ttlSeconds: safeTtl });

    const expiresAt = Math.floor(Date.now() / 1000) + (safeTtl ?? 60 * 60);

    const userInfo = (req.user as { displayName?: string; emails?: { value?: string }[] } | undefined);
    console.log(
      `[agent-tokens] minted tokens for feature=${featureId}${pbiId ? ` pbi=${pbiId}` : ''} ` +
      `user=${userInfo?.emails?.[0]?.value ?? userInfo?.displayName ?? 'unknown'} ` +
      `ttl=${safeTtl ?? 3600}s`
    );

    res.json({ readToken, writeToken, expiresAt });
  } catch (error: any) {
    console.error('Error minting agent token:', error);
    res.status(500).json({ error: 'Failed to mint agent token', details: error.message });
  }
});

// POST /api/backlog/update-figma-url
// Called by the Cursor agent after the Figma design is created.
// Saves the Figma URL on the wiki draft, clears pendingFigmaExport, and when the
// Feature or PBI is merged to ADO appends the link to that work item's description.
// Agent-token requests require a resolved adoWorkItemId (merged backlog node).
router.post('/backlog/update-figma-url', async (req: Request, res: Response) => {
  try {
    const { featureId, pbiId, pagePath, figmaUrl, project, areaPath } = req.body as {
      featureId?: string;
      pbiId?: string;
      pagePath?: string;
      figmaUrl?: string;
      project?: string;
      areaPath?: string;
    };

    if (!featureId || !pagePath || !figmaUrl) {
      return res.status(400).json({ error: 'featureId, pagePath, and figmaUrl are required' });
    }

    // When the request was authorized via an agent token (production path),
    // ensure the token's claims match the body. Prevents a token minted for
    // feature A from being used to write a Figma URL onto feature B.
    const claims = (req as Request & { agentToken?: AgentTokenClaims }).agentToken;
    if (claims) {
      if (claims.featureId !== featureId) {
        return res.status(403).json({ error: 'Agent token featureId mismatch' });
      }
      if ((claims.pbiId ?? undefined) !== (pbiId ?? undefined)) {
        return res.status(403).json({ error: 'Agent token pbiId mismatch' });
      }
    }

    const adoService = new AzureDevOpsService(project, areaPath);
    const docs = await adoService.getDraftBacklogDocs() as any[];
    const doc = docs.find((d: any) => d.path === pagePath);
    if (!doc) {
      return res.status(404).json({ error: `Backlog page "${pagePath}" not found` });
    }

    const feature = ((doc.document?.features ?? []) as any[]).find((f: any) => f.id === featureId);
    if (!feature?.uiMock) {
      return res.status(404).json({ error: `Feature ${featureId} or its uiMock not found` });
    }

    /* Resolve ADO id from the draft document only (never from the request body). */
    let adoWorkItemId: number | undefined;
    if (pbiId) {
      const pbiRow = ((doc.document?.pbis ?? []) as any[]).find((p: any) => p.id === pbiId);
      if (pbiRow && typeof pbiRow.adoWorkItemId === 'number') {
        adoWorkItemId = pbiRow.adoWorkItemId;
      }
    } else if (typeof feature.adoWorkItemId === 'number') {
      adoWorkItemId = feature.adoWorkItemId;
    }

    if (claims && (adoWorkItemId == null || typeof adoWorkItemId !== 'number')) {
      return res.status(409).json({
        error:
          'Target work item is not merged to Azure DevOps (missing adoWorkItemId). Import to Figma requires a merged Feature or PBI.',
      });
    }

    if (pbiId) {
      // Update a PBI-scoped view
      const view = (feature.uiMock.views ?? []).find((v: any) => v.pbiId === pbiId);
      if (!view) return res.status(404).json({ error: `PBI view ${pbiId} not found` });
      view.figmaUrl = figmaUrl;
      view.figmaCreatedAt = new Date().toISOString();
      view.pendingFigmaExport = false;
    } else {
      // Update the feature-level mock
      feature.uiMock.figmaUrl = figmaUrl;
      feature.uiMock.figmaCreatedAt = new Date().toISOString();
      feature.uiMock.pendingFigmaExport = false;
    }

    await adoService.updateDraftBacklogDoc(pagePath, doc.document);

    if (typeof adoWorkItemId === 'number') {
      try {
        await adoService.appendFigmaLinkToDescription(adoWorkItemId, figmaUrl);
      } catch (adoErr: any) {
        console.error('[update-figma-url] Azure DevOps appendFigmaLinkToDescription failed:', adoErr);
        return res.status(502).json({
          error: 'Figma URL saved to the backlog draft but updating Azure DevOps failed',
          details: adoErr?.message ?? String(adoErr),
          wikiUpdated: true,
          figmaUrl,
          featureId,
          pbiId: pbiId ?? null,
        });
      }
    }

    res.json({
      success: true,
      figmaUrl,
      featureId,
      pbiId: pbiId ?? null,
      adoUpdated: typeof adoWorkItemId === 'number',
    });
  } catch (error: any) {
    console.error('Error updating Figma URL:', error);
    res.status(500).json({ error: 'Failed to update Figma URL', details: error.message });
  }
});

// POST /api/backlog/mark-design-ready
// Called by the UX designer once their Figma refinement is done and the screen is ready for dev.
// Sets designReady=true on the feature's uiMock (or a PBI view when pbiId is supplied)
// and adds a 'design-ready' tag to the ADO work item.
router.post('/backlog/mark-design-ready', async (req: Request, res: Response) => {
  try {
    const { featureId, pbiId, pagePath, project, areaPath } = req.body as {
      featureId?: string;
      pbiId?: string;
      pagePath?: string;
      project?: string;
      areaPath?: string;
    };

    if (!featureId || !pagePath) {
      return res.status(400).json({ error: 'featureId and pagePath are required' });
    }

    const adoService = new AzureDevOpsService(project, areaPath);
    const docs = await adoService.getDraftBacklogDocs() as any[];
    const doc = docs.find((d: any) => d.path === pagePath);
    if (!doc) {
      return res.status(404).json({ error: `Backlog page "${pagePath}" not found` });
    }

    const feature = ((doc.document?.features ?? []) as any[]).find((f: any) => f.id === featureId);
    if (!feature?.uiMock) {
      return res.status(404).json({ error: `Feature ${featureId} or its uiMock not found` });
    }

    const now = new Date().toISOString();

    let targetFigmaUrl: string | undefined;

    if (pbiId) {
      const view = (feature.uiMock.views ?? []).find((v: any) => v.pbiId === pbiId);
      if (!view) return res.status(404).json({ error: `PBI view ${pbiId} not found` });
      view.designReady = true;
      view.designReadyAt = now;
      targetFigmaUrl = view.figmaUrl as string | undefined;
    } else {
      feature.uiMock.designReady = true;
      feature.uiMock.designReadyAt = now;
      targetFigmaUrl = feature.uiMock.figmaUrl as string | undefined;
    }

    await adoService.updateDraftBacklogDoc(pagePath, doc.document);

    // Resolve the ADO work item ID for the target (feature or PBI)
    let targetAdoWorkItemId: number | undefined;
    if (pbiId) {
      const pbi = ((doc.document?.pbis ?? []) as any[]).find((p: any) => p.id === pbiId);
      targetAdoWorkItemId = pbi?.adoWorkItemId as number | undefined;
    } else {
      targetAdoWorkItemId = feature.adoWorkItemId as number | undefined;
    }

    if (targetAdoWorkItemId) {
      // Tag the work item so it surfaces in dev queries/boards
      try {
        await adoService.addTagToWorkItem(targetAdoWorkItemId, 'design-ready');
      } catch (tagErr) {
        console.warn(`Could not add design-ready tag to ADO item ${targetAdoWorkItemId}:`, tagErr);
      }
      // Append the Figma URL to the work item description
      if (targetFigmaUrl) {
        try {
          await adoService.appendFigmaLinkToDescription(targetAdoWorkItemId, targetFigmaUrl);
          console.log(`[mark-design-ready] Appended Figma link to ADO item ${targetAdoWorkItemId}`);
        } catch (figmaErr) {
          console.warn(`Could not append Figma link to ADO item ${targetAdoWorkItemId}:`, figmaErr);
        }
      }
    }

    res.json({ success: true, featureId, pbiId: pbiId ?? null, designReadyAt: now });
  } catch (error: any) {
    console.error('Error marking design ready:', error);
    res.status(500).json({ error: 'Failed to mark design ready', details: error.message });
  }
});

// DELETE /api/backlog/item - Remove a work item (and its children) from the wiki draft; optionally delete from ADO
router.delete('/backlog/item', async (req: Request, res: Response) => {
  try {
    const { itemId, workItemType, pagePath, document, project, areaPath, deleteFromADO, adoWorkItemId } = req.body as {
      itemId?: string;
      workItemType?: 'Epic' | 'Feature' | 'PBI';
      pagePath?: string;
      document?: any;
      project?: string;
      areaPath?: string;
      deleteFromADO?: boolean;
      adoWorkItemId?: number;
    };

    if (!itemId || !workItemType || !pagePath || !document) {
      return res.status(400).json({ error: 'itemId, workItemType, pagePath, and document are required' });
    }

    // Build the updated document by removing the item and any cascading children
    let updatedDoc: any;

    if (workItemType === 'Epic') {
      const removedFeatureIds = new Set<string>(
        (document.features ?? []).filter((f: any) => f.parentId === itemId).map((f: any) => f.id)
      );
      updatedDoc = {
        epics: (document.epics ?? []).filter((e: any) => e.id !== itemId),
        features: (document.features ?? []).filter((f: any) => f.parentId !== itemId),
        pbis: (document.pbis ?? []).filter((p: any) => !removedFeatureIds.has(p.parentId)),
      };
    } else if (workItemType === 'Feature') {
      updatedDoc = {
        ...document,
        features: (document.features ?? []).filter((f: any) => f.id !== itemId),
        pbis: (document.pbis ?? []).filter((p: any) => p.parentId !== itemId),
      };
    } else {
      updatedDoc = {
        ...document,
        pbis: (document.pbis ?? []).filter((p: any) => p.id !== itemId),
      };
    }

    // Save updated document to wiki
    const adoService = new AzureDevOpsService(project, areaPath);
    await adoService.updateDraftBacklogDoc(pagePath, updatedDoc);

    // Optionally delete from ADO
    if (deleteFromADO && adoWorkItemId && typeof adoWorkItemId === 'number') {
      try {
        await adoService.deleteWorkItem(adoWorkItemId);
        console.log(`[DELETE /backlog/item] Deleted ADO work item ${adoWorkItemId}`);
      } catch (adoErr: any) {
        // ADO delete failed — wiki save already succeeded; surface as a warning, not a hard failure
        console.error(`[DELETE /backlog/item] Wiki updated but ADO delete failed for ${adoWorkItemId}:`, adoErr.message);
        return res.json({ success: true, adoDeleteError: adoErr.message });
      }
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error('Error deleting backlog item:', error);
    if (error.message?.startsWith('WIKI_CONFLICT')) {
      return res.status(409).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to delete backlog item', details: error.message });
  }
});

// POST /api/backlog/unlink-ado-item - Delete an ADO work item and reset the backlog item back to Draft
router.post('/backlog/unlink-ado-item', async (req: Request, res: Response) => {
  try {
    const { itemId, workItemType, pagePath, document, project, areaPath } = req.body as {
      itemId?: string;
      workItemType?: 'Epic' | 'Feature' | 'PBI';
      pagePath?: string;
      document?: any;
      project?: string;
      areaPath?: string;
    };

    if (!itemId || !workItemType || !pagePath || !document || !project) {
      return res.status(400).json({ error: 'itemId, workItemType, pagePath, document, and project are required' });
    }

    const arrayKey = workItemType === 'Epic' ? 'epics' : workItemType === 'Feature' ? 'features' : 'pbis';
    const items: any[] = document[arrayKey] ?? [];
    const item = items.find((i: any) => i.id === itemId);
    if (!item) return res.status(404).json({ error: `${workItemType} ${itemId} not found in document` });

    const adoWorkItemId: number | undefined = item.adoWorkItemId;

    // Clear ADO link and reset status to Draft
    const updatedItems = items.map((i: any) =>
      i.id === itemId
        ? { ...i, status: 'Draft', adoWorkItemId: undefined, adoWorkItemUrl: undefined }
        : i
    );
    const updatedDoc = { ...document, [arrayKey]: updatedItems };

    const adoService = new AzureDevOpsService(project, areaPath);
    await adoService.updateDraftBacklogDoc(pagePath, updatedDoc);

    // Delete from ADO — best-effort; wiki save already committed
    if (adoWorkItemId && typeof adoWorkItemId === 'number') {
      try {
        await adoService.deleteWorkItem(adoWorkItemId);
        console.log(`[POST /backlog/unlink-ado-item] Deleted ADO work item ${adoWorkItemId}`);
      } catch (adoErr: any) {
        console.error(`[POST /backlog/unlink-ado-item] Wiki updated but ADO delete failed for ${adoWorkItemId}:`, adoErr.message);
        return res.json({ success: true, adoDeleteError: adoErr.message });
      }
    }

    res.json({ success: true, updatedDoc });
  } catch (error: any) {
    console.error('Error unlinking ADO item:', error);
    if (error.message?.startsWith('WIKI_CONFLICT')) {
      return res.status(409).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to unlink ADO item', details: error.message });
  }
});

// PUT /api/backlog/drafts - Save updated backlog document back to the wiki
router.put('/backlog/drafts', async (req: Request, res: Response) => {
  try {
    const { pagePath, document, project, areaPath } = req.body as {
      pagePath?: string;
      document?: unknown;
      project?: string;
      areaPath?: string;
    };

    if (!pagePath || typeof pagePath !== 'string') {
      return res.status(400).json({ error: 'pagePath is required' });
    }

    if (!document || typeof document !== 'object') {
      return res.status(400).json({ error: 'document is required' });
    }

    const adoService = new AzureDevOpsService(project, areaPath);
    const updated = await adoService.updateDraftBacklogDoc(pagePath, document as any);
    res.json(updated);
  } catch (error: any) {
    console.error('Error updating draft backlog doc:', error);
    if (error.message?.startsWith('WIKI_CONFLICT')) {
      return res.status(409).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to update draft backlog document' });
  }
});

// ── AI Capability Ladder ───────────────────────────────────────────────────────

// GET /api/ai-capability-ladder - Full scorecard combining Cursor analytics + ADO metrics
router.get('/ai-capability-ladder', async (req: Request, res: Response) => {
  try {
    const {
      from,
      to,
      areaPath: areaPathParam,
    } = req.query as { from?: string; to?: string; areaPath?: string };

    const toDate = to ? new Date(to) : new Date();
    const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const fromStr = fromDate.toISOString().split('T')[0]!;
    const toStr = toDate.toISOString().split('T')[0]!;

    console.log('=== API: /ai-capability-ladder called ===', { from: fromStr, to: toStr });

    const { buildCursorTeamSummary } = await import('../services/cursorAnalyticsService');
    const { buildLadderResult } = await import('../services/aiCapabilityLadderService');
    const { getBaseline } = await import('../services/aiCapabilityBaselineService');

    const adoService = new AzureDevOpsService('MaxView', areaPathParam || '');

    // Fetch all ADO data concurrently
    const [
      adoMembersResult,
      kickoffResult,
      prTimeResult,
      inProgressResult,
      qaBugResult,
      deploymentsResult,
    ] = await Promise.allSettled([
      adoService.getTeamMembersWithEmails('MaxView - Dev').catch(() => []),
      adoService.getDesignDocKickoffStats(fromStr, toStr),
      adoService.getPullRequestTimeStats(fromStr, toStr),
      adoService.getInProgressTimeStats(fromStr, toStr),
      adoService.getQABugStats(fromStr, toStr),
      import('../services/deploymentTracking').then(m =>
        new m.DeploymentTrackingService().getDeploymentHistory(200)
      ),
    ]);

    const adoMembersWithEmails: Array<{ name: string; email: string }> = adoMembersResult.status === 'fulfilled' ? adoMembersResult.value : [];
    const adoMembers: string[] = adoMembersWithEmails.map(m => m.name);
    const kickoffStats = kickoffResult.status === 'fulfilled' ? kickoffResult.value : [];
    const prTimeStats = prTimeResult.status === 'fulfilled' ? prTimeResult.value : [];
    const inProgressStats = inProgressResult.status === 'fulfilled' ? inProgressResult.value : [];
    const qaBugStats = qaBugResult.status === 'fulfilled' ? qaBugResult.value : [];
    const deployments = deploymentsResult.status === 'fulfilled' ? deploymentsResult.value : [];

    // Aggregate ADO metrics
    const kickoffCount = kickoffStats.reduce((s, d) => s + d.kickoffCount, 0);
    const totalEligibleFeatures = kickoffStats.reduce((s, d) => s + d.totalWorkItems, 0);

    const avgPrCycleTimeDays = prTimeStats.length > 0
      ? prTimeStats.reduce((s, d) => s + d.averageTimeInPullRequest, 0) / prTimeStats.length
      : null;

    const avgLeadTimeDays = inProgressStats.length > 0
      ? inProgressStats.reduce((s, d) => s + d.averageDaysInProgress, 0) / inProgressStats.length
      : null;

    const totalPbis = qaBugStats.reduce((s, d) => s + d.totalPBIs, 0);
    const totalBugs = qaBugStats.reduce((s, d) => s + d.totalBugs, 0);
    const avgDefectRatePerPbi = totalPbis > 0 ? totalBugs / totalPbis : null;

    const aiCodeWorkItemAdoption = await adoService.getAiCodeWorkItemAdoptionStats(fromStr, toStr, adoMembers);

    // Deploy frequency: deployments in window / window months
    const windowMonths = Math.max(1,
      (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24 * 30));
    const deploysInWindow = deployments.filter(d =>
      d.deployedAt >= fromStr && d.deployedAt <= toStr + 'T23:59:59Z'
    ).length;
    const deployFrequencyPerMonth = deploymentsResult.status === 'fulfilled'
      ? deploysInWindow / windowMonths
      : null;

    // Fetch Cursor team summary (server-side only — key never leaves server)
    let cursorSummary;
    let cursorDataAvailable = false;
    let cursorApiError: string | null = null;
    try {
      cursorSummary = await buildCursorTeamSummary(fromDate, toDate);
      // Consider Cursor data available only if we got at least 1 member back
      cursorDataAvailable = cursorSummary.teamSize > 0;
      if (!cursorDataAvailable) {
        cursorApiError = 'Cursor API returned 0 team members — verify the CURSOR_API_KEY has admin:* scope and the team has members';
        console.warn('Cursor analytics: 0 members returned. Key may lack admin:* scope.');
      }
    } catch (cursorErr: any) {
      const msg = cursorErr.message ?? 'Unknown error';
      console.error('Cursor analytics fetch failed:', msg);
      cursorApiError = `Cursor API error: ${msg}`;
      cursorSummary = {
        teamSize: 0, activeSeats: 0, developers: [],
        dauSeries: [], daysAbove50pct: 0, daysAbove80pct: 0,
        weeksAbove50pct: 0, weeksAbove80pct: 0,
        recentDauPct: 0, totalDauDays: 0,
        tabAcceptRate: 0, agentEditAcceptRate: 0,
        skillsInUse: [], totalSkillUsages: 0,
        mcpToolsInUse: [], planModeUsages: 0, commandsUsed: [],
      };
    }

    const baseline = getBaseline();

    const result = buildLadderResult({
      cursorSummary,
      cursorDataAvailable,
      cursorApiError,
      adoMembers,
      adoMembersWithEmails,
      kickoffCount,
      totalEligibleFeatures,
      aiCodeWorkItemAdoption,
      avgPrCycleTimeDays,
      avgLeadTimeDays,
      avgDefectRatePerPbi,
      deployFrequencyPerMonth,
      baseline,
      fromDate: fromStr,
      toDate: toStr,
    });

    console.log(`=== API: /ai-capability-ladder returning scorecard, ${result.bars.length} bars ===`);
    res.json(result);
  } catch (error: any) {
    console.error('Error generating AI capability ladder:', error);
    res.status(500).json({ error: 'Failed to generate AI capability ladder scorecard' });
  }
});

// GET /api/ai-capability-baseline - Read baseline config
router.get('/ai-capability-baseline', async (_req: Request, res: Response) => {
  try {
    const { getBaseline } = await import('../services/aiCapabilityBaselineService');
    res.json(getBaseline());
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to read baseline' });
  }
});

// PUT /api/ai-capability-baseline - Save baseline config
router.put('/ai-capability-baseline', async (req: Request, res: Response) => {
  try {
    const { saveBaseline } = await import('../services/aiCapabilityBaselineService');
    saveBaseline(req.body);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to save baseline' });
  }
});

// POST /api/ai-capability-baseline/auto-capture
// Derives pre-AI baseline metrics from ADO data before aiStartDate and saves them.
// Body: { aiStartDate: "YYYY-MM-DD", lookbackDays?: number, areaPath?: string }
router.post('/ai-capability-baseline/auto-capture', async (req: Request, res: Response) => {
  try {
    const { aiStartDate, lookbackDays = 90, areaPath = '' } = req.body as {
      aiStartDate: string;
      lookbackDays?: number;
      areaPath?: string;
    };

    if (!aiStartDate || !/^\d{4}-\d{2}-\d{2}$/.test(aiStartDate)) {
      return res.status(400).json({ error: 'aiStartDate is required (YYYY-MM-DD)' });
    }

    const toDate = new Date(aiStartDate);
    toDate.setDate(toDate.getDate() - 1); // day before AI start
    const fromDate = new Date(toDate);
    fromDate.setDate(fromDate.getDate() - lookbackDays);

    const fromStr = fromDate.toISOString().split('T')[0]!;
    const toStr = toDate.toISOString().split('T')[0]!;

    console.log(`=== auto-capture baseline: ${fromStr} → ${toStr} (${lookbackDays}d before ${aiStartDate}) ===`);

    const adoService = new AzureDevOpsService('MaxView', areaPath);

    const [prTimeResult, inProgressResult, qaBugResult] = await Promise.allSettled([
      adoService.getPullRequestTimeStats(fromStr, toStr),
      adoService.getInProgressTimeStats(fromStr, toStr),
      adoService.getQABugStats(fromStr, toStr),
    ]);

    const prTimeStats = prTimeResult.status === 'fulfilled' ? prTimeResult.value : [];
    const inProgressStats = inProgressResult.status === 'fulfilled' ? inProgressResult.value : [];
    const qaBugStats = qaBugResult.status === 'fulfilled' ? qaBugResult.value : [];

    const avgPrCycleTimeDays = prTimeStats.length > 0
      ? Math.round((prTimeStats.reduce((s: number, d: any) => s + d.averageTimeInPullRequest, 0) / prTimeStats.length) * 10) / 10
      : null;

    const avgLeadTimeDays = inProgressStats.length > 0
      ? Math.round((inProgressStats.reduce((s: number, d: any) => s + d.averageDaysInProgress, 0) / inProgressStats.length) * 10) / 10
      : null;

    const totalPbis = qaBugStats.reduce((s: number, d: any) => s + d.totalPBIs, 0);
    const totalBugs = qaBugStats.reduce((s: number, d: any) => s + d.totalBugs, 0);
    const defectRatePerPbi = totalPbis > 0 ? Math.round((totalBugs / totalPbis) * 100) / 100 : null;

    const { getBaseline, saveBaseline } = await import('../services/aiCapabilityBaselineService');
    const existing = getBaseline();

    const updated = {
      ...existing,
      capturedAt: new Date().toISOString().split('T')[0]!,
      prCycleTimeDays: avgPrCycleTimeDays,
      leadTimeDays: avgLeadTimeDays,
      defectRatePerPbi,
    };

    saveBaseline(updated);

    res.json({
      success: true,
      baseline: updated,
      capturedFrom: fromStr,
      capturedTo: toStr,
      prCycleTimeDays: avgPrCycleTimeDays,
      leadTimeDays: avgLeadTimeDays,
      defectRatePerPbi,
      prSampleSize: prTimeStats.reduce((s: number, d: any) => s + d.totalItemsInPullRequest, 0),
      leadTimeSampleSize: inProgressStats.reduce((s: number, d: any) => s + d.totalItemsInProgress, 0),
    });
  } catch (error: any) {
    console.error('auto-capture baseline error:', error);
    res.status(500).json({ error: error.message ?? 'Failed to auto-capture baseline' });
  }
});

export default router;
