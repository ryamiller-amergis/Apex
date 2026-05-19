import { AzureDevOpsService } from './azureDevOps';
import { parseAutoCheckTeams } from './adoTeamConfig';

/**
 * Background service that automatically updates Feature status to "Done"
 * when all child items are in completed states.
 */
export class FeatureAutoCompleteService {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private readonly COMPLETED_STATES = ['Ready For Release', 'UAT - Test Done', 'Done', 'Closed'];
  private readonly CHECK_INTERVAL = 15 * 60 * 1000; // 15 minutes in milliseconds

  /**
   * Start the background service
   */
  start(): void {
    if (this.intervalId) {
      console.log('[FeatureAutoComplete] Service already running');
      return;
    }

    console.log('[FeatureAutoComplete] Starting service - checking every 15 minutes');
    
    // Run immediately on start
    this.checkAndUpdateFeatures();
    
    // Then run every 15 minutes
    this.intervalId = setInterval(() => {
      this.checkAndUpdateFeatures();
    }, this.CHECK_INTERVAL);
  }

  /**
   * Stop the background service
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[FeatureAutoComplete] Service stopped');
    }
  }

  /**
   * Main method to check and update features
   */
  private async checkAndUpdateFeatures(): Promise<void> {
    if (this.isRunning) {
      console.log('[FeatureAutoComplete] Previous check still running, skipping...');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    console.log(`[FeatureAutoComplete] Starting feature check at ${new Date().toISOString()}`);

    try {
      const { teams, skippedAreaPaths } = parseAutoCheckTeams();
      skippedAreaPaths.forEach((team) => {
        console.log(`[FeatureAutoComplete] Skipping retired area path ${team.project}/${team.areaPath}`);
      });

      if (teams.length === 0) {
        console.log('[FeatureAutoComplete] No teams configured, skipping check');
        return;
      }

      let totalFeaturesChecked = 0;
      let totalFeaturesUpdated = 0;

      // Check each team/project
      for (const team of teams) {
        try {
          const { checked, updated } = await this.checkTeamFeatures(team.project, team.areaPath);
          totalFeaturesChecked += checked;
          totalFeaturesUpdated += updated;
        } catch (error) {
          console.error(`[FeatureAutoComplete] Error checking team ${team.project}/${team.areaPath}:`, error);
        }
      }

      const duration = Date.now() - startTime;
      console.log(`[FeatureAutoComplete] Check completed in ${duration}ms - Checked: ${totalFeaturesChecked}, Updated: ${totalFeaturesUpdated}`);
    } catch (error) {
      console.error('[FeatureAutoComplete] Error during feature check:', error);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Check and update features for a specific team
   */
  private async checkTeamFeatures(project: string, areaPath: string): Promise<{ checked: number; updated: number }> {
    const azureDevOps = new AzureDevOpsService(project, areaPath);
    
    let featuresChecked = 0;
    let featuresUpdated = 0;

    try {
      // Get all work items (this will include Features)
      const workItems = await azureDevOps.getWorkItems();
      
      // Filter for Features that are not already in Done or Closed state
      const features = workItems.filter(item => 
        item.workItemType === 'Feature' && 
        !['Done', 'Closed'].includes(item.state)
      );

      console.log(`[FeatureAutoComplete] Found ${features.length} features to check in ${project}/${areaPath}`);

      // Check each feature
      for (const feature of features) {
        try {
          featuresChecked++;
          
          // Get children of this feature
          const children = await azureDevOps.getFeatureChildren(feature.id);
          
          if (children.length === 0) {
            // No children, skip this feature
            continue;
          }

          // Filter out "Removed" items - they don't count toward completion
          const activeChildren = children.filter(child => child.state !== 'Removed');
          
          if (activeChildren.length === 0) {
            // No active children (all removed), skip this feature
            continue;
          }

          // Check if all active children are in completed states
          const allChildrenComplete = activeChildren.every(child => 
            this.COMPLETED_STATES.includes(child.state)
          );

          if (allChildrenComplete) {
            console.log(`[FeatureAutoComplete] Feature ${feature.id} - All ${activeChildren.length} active children are complete (${children.length - activeChildren.length} removed). Updating to Done.`);
            
            // Update the feature state to Done
            await azureDevOps.updateWorkItemField(feature.id, 'System.State', 'Done');
            featuresUpdated++;
            
            console.log(`[FeatureAutoComplete] Successfully updated Feature ${feature.id} to Done`);
          }
        } catch (error) {
          console.error(`[FeatureAutoComplete] Error processing feature ${feature.id}:`, error);
        }
      }
    } catch (error) {
      console.error(`[FeatureAutoComplete] Error fetching work items for ${project}/${areaPath}:`, error);
    }

    return { checked: featuresChecked, updated: featuresUpdated };
  }

  /**
   * Manual trigger for testing/admin purposes
   */
  async triggerCheck(): Promise<void> {
    console.log('[FeatureAutoComplete] Manual trigger initiated');
    await this.checkAndUpdateFeatures();
  }
}

// Singleton instance
let serviceInstance: FeatureAutoCompleteService | null = null;

/**
 * Get the singleton instance of the service
 */
export function getFeatureAutoCompleteService(): FeatureAutoCompleteService {
  if (!serviceInstance) {
    serviceInstance = new FeatureAutoCompleteService();
  }
  return serviceInstance;
}
