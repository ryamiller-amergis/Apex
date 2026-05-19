import { AzureDevOpsService } from './azureDevOps';
import { parseAutoCheckTeams } from './adoTeamConfig';

/**
 * Background service that automatically updates work items from "UAT - Test Done" 
 * to "Ready For Release" status.
 */
export class UatAutoReleaseService {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private readonly SOURCE_STATE = 'UAT - Test Done';
  private readonly TARGET_STATE = 'Ready For Release';
  private readonly CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes in milliseconds

  /**
   * Start the background service
   */
  start(): void {
    if (this.intervalId) {
      console.log('[UatAutoRelease] Service already running');
      return;
    }

    console.log('[UatAutoRelease] Starting service - checking every 5 minutes');
    
    // Run immediately on start
    this.checkAndUpdateWorkItems();
    
    // Then run every 5 minutes
    this.intervalId = setInterval(() => {
      this.checkAndUpdateWorkItems();
    }, this.CHECK_INTERVAL);
  }

  /**
   * Stop the background service
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[UatAutoRelease] Service stopped');
    }
  }

  /**
   * Main method to check and update work items
   */
  private async checkAndUpdateWorkItems(): Promise<void> {
    if (this.isRunning) {
      console.log('[UatAutoRelease] Previous check still running, skipping...');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    console.log(`[UatAutoRelease] Starting work item check at ${new Date().toISOString()}`);

    try {
      const { teams, skippedAreaPaths } = parseAutoCheckTeams();
      skippedAreaPaths.forEach((team) => {
        console.log(`[UatAutoRelease] Skipping retired area path ${team.project}/${team.areaPath}`);
      });

      if (teams.length === 0) {
        console.log('[UatAutoRelease] No teams configured, skipping check');
        return;
      }

      let totalItemsChecked = 0;
      let totalItemsUpdated = 0;

      // Check each team/project
      for (const team of teams) {
        try {
          const { checked, updated } = await this.checkTeamWorkItems(team.project, team.areaPath);
          totalItemsChecked += checked;
          totalItemsUpdated += updated;
        } catch (error) {
          console.error(`[UatAutoRelease] Error checking team ${team.project}/${team.areaPath}:`, error);
        }
      }

      const duration = Date.now() - startTime;
      console.log(`[UatAutoRelease] Check completed in ${duration}ms - Checked: ${totalItemsChecked}, Updated: ${totalItemsUpdated}`);
    } catch (error) {
      console.error('[UatAutoRelease] Error during work item check:', error);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Check and update work items for a specific team
   */
  private async checkTeamWorkItems(project: string, areaPath: string): Promise<{ checked: number; updated: number }> {
    const azureDevOps = new AzureDevOpsService(project, areaPath);
    
    let itemsChecked = 0;
    let itemsUpdated = 0;

    try {
      // Get all work items
      const workItems = await azureDevOps.getWorkItems();
      
      // Filter for items that are in "UAT - Test Done" state
      const uatDoneItems = workItems.filter(item => 
        item.state === this.SOURCE_STATE
      );

      console.log(`[UatAutoRelease] Found ${uatDoneItems.length} work items in "${this.SOURCE_STATE}" state in ${project}/${areaPath}`);

      // Update each item
      for (const item of uatDoneItems) {
        try {
          itemsChecked++;
          
          console.log(`[UatAutoRelease] Work Item ${item.id} (${item.workItemType}) - Updating from "${this.SOURCE_STATE}" to "${this.TARGET_STATE}"`);
          
          // Update the work item state to Ready For Release
          await azureDevOps.updateWorkItemField(item.id, 'System.State', this.TARGET_STATE);
          itemsUpdated++;
          
          console.log(`[UatAutoRelease] Successfully updated Work Item ${item.id} to "${this.TARGET_STATE}"`);
        } catch (error) {
          console.error(`[UatAutoRelease] Error processing work item ${item.id}:`, error);
        }
      }
    } catch (error) {
      console.error(`[UatAutoRelease] Error fetching work items for ${project}/${areaPath}:`, error);
    }

    return { checked: itemsChecked, updated: itemsUpdated };
  }

  /**
   * Manual trigger for testing/admin purposes
   */
  async triggerCheck(): Promise<void> {
    console.log('[UatAutoRelease] Manual trigger initiated');
    await this.checkAndUpdateWorkItems();
  }
}

// Singleton instance
let serviceInstance: UatAutoReleaseService | null = null;

/**
 * Get the singleton instance of the service
 */
export function getUatAutoReleaseService(): UatAutoReleaseService {
  if (!serviceInstance) {
    serviceInstance = new UatAutoReleaseService();
  }
  return serviceInstance;
}
