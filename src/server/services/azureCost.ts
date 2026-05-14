import { DefaultAzureCredential, ClientSecretCredential } from '@azure/identity';
import { SubscriptionClient } from '@azure/arm-resources-subscriptions';
import { ResourceManagementClient } from '@azure/arm-resources';
import { CostManagementClient } from '@azure/arm-costmanagement';

export interface AzureSubscription {
  id: string;
  subscriptionId: string;
  name: string;
  state: string;
}

export interface AzureResourceGroup {
  id: string;
  name: string;
  location: string;
  subscriptionId: string;
}

export interface CostData {
  totalCost: number;
  dailyAverage: number;
  projectedMonthly: number;
  percentChange: number;
  costByDay: Array<{ date: string; cost: number }>;
  costByResourceGroup: Array<{ name: string; cost: number }>;
  costDetails: Array<{
    resourceGroup: string;
    service: string;
    resource: string;
    dailyCost: number;
    totalCost: number;
    trend: number;
  }>;
}

const MAX_RETRIES = 4;
const BASE_DELAY_MS = 2000;

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  label: string
): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const is429 =
        error?.statusCode === 429 ||
        error?.code === 'TooManyRequests' ||
        (error?.message && /too many requests/i.test(error.message));

      if (!is429 || attempt === MAX_RETRIES) throw error;

      const retryAfterHeader = error?.response?.headers?.get?.('retry-after');
      const delayMs = retryAfterHeader
        ? parseInt(retryAfterHeader, 10) * 1000
        : BASE_DELAY_MS * Math.pow(2, attempt);

      console.warn(
        `[${label}] 429 throttled – retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('Unreachable');
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class AzureCostService {
  private credential: DefaultAzureCredential | ClientSecretCredential;

  constructor() {
    // Use client credentials if available in env vars, otherwise use default credential chain
    const tenantId = process.env.AZURE_COST_TENANT_ID;
    const clientId = process.env.AZURE_COST_CLIENT_ID;
    const clientSecret = process.env.AZURE_COST_CLIENT_SECRET;

    if (tenantId && clientId && clientSecret) {
      console.log('Using ClientSecretCredential for Azure Cost Management');
      this.credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
    } else {
      console.log('Using DefaultAzureCredential for Azure Cost Management');
      this.credential = new DefaultAzureCredential();
    }
  }

  /**
   * Get all Azure subscriptions the user has access to
   */
  async getSubscriptions(): Promise<AzureSubscription[]> {
    try {
      const subscriptionClient = new SubscriptionClient(this.credential);
      const subscriptions: AzureSubscription[] = [];

      // Use the subscriptions.list() method from @azure/arm-resources-subscriptions
      for await (const subscription of subscriptionClient.subscriptions.list()) {
        if (subscription.subscriptionId && subscription.displayName) {
          subscriptions.push({
            id: subscription.subscriptionId,
            subscriptionId: subscription.subscriptionId,
            name: subscription.displayName,
            state: subscription.state || 'Unknown'
          });
        }
      }

      console.log(`Found ${subscriptions.length} Azure subscriptions`);
      return subscriptions;
    } catch (error) {
      console.error('Error fetching Azure subscriptions:', error);
      throw new Error(`Failed to fetch Azure subscriptions: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get all resource groups for a specific subscription
   */
  async getResourceGroups(subscriptionId: string): Promise<AzureResourceGroup[]> {
    try {
      return await retryWithBackoff(async () => {
        const resourceClient = new ResourceManagementClient(this.credential, subscriptionId);
        const resourceGroups: AzureResourceGroup[] = [];

        for await (const rg of resourceClient.resourceGroups.list()) {
          if (rg.name && rg.location) {
            resourceGroups.push({
              id: rg.id || rg.name,
              name: rg.name,
              location: rg.location,
              subscriptionId: subscriptionId
            });
          }
        }

        console.log(`Found ${resourceGroups.length} resource groups in subscription ${subscriptionId}`);
        return resourceGroups;
      }, `getResourceGroups(${subscriptionId})`);
    } catch (error) {
      console.error(`Error fetching resource groups for subscription ${subscriptionId}:`, error);
      throw new Error(`Failed to fetch resource groups: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get all subscriptions with their resource groups
   */
  async getSubscriptionsWithResourceGroups(): Promise<Array<AzureSubscription & { resourceGroups: string[] }>> {
    try {
      const subscriptions = await this.getSubscriptions();
      const result = await Promise.all(
        subscriptions.map(async (sub) => {
          const resourceGroups = await this.getResourceGroups(sub.subscriptionId);
          return {
            ...sub,
            resourceGroups: resourceGroups.map(rg => rg.name).sort()
          };
        })
      );

      return result;
    } catch (error) {
      console.error('Error fetching subscriptions with resource groups:', error);
      throw error;
    }
  }

  /**
   * Get cost data for specified subscription and resource groups
   * Fetches actual Azure costs using the Cost Management API
   */
  async getCostData(
    subscriptionId: string,
    resourceGroups: string[],
    timePeriod: '7d' | '30d' | '90d' | 'custom' = '30d',
    customStartDate?: string,
    customEndDate?: string
  ): Promise<CostData> {
    try {
      let startDate: Date;
      let endDate: Date;

      if (timePeriod === 'custom' && customStartDate && customEndDate) {
        // Use custom dates
        startDate = new Date(customStartDate);
        endDate = new Date(customEndDate);
      } else {
        // Calculate dates based on predefined period
        const days = this.getDaysFromPeriod(timePeriod as '7d' | '30d' | '90d');
        endDate = new Date();
        startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
      }

      // Calculate the number of days in the range
      const days = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;

      // Format dates for Azure API (YYYY-MM-DD)
      const from = startDate.toISOString().split('T')[0];
      const to = endDate.toISOString().split('T')[0];

      const costClient = new CostManagementClient(this.credential);

      // Build filter for resource groups
      const rgFilter = resourceGroups.length > 0
        ? resourceGroups.map(rg => `resourceGroup eq '${rg}'`).join(' or ')
        : undefined;

      // Query actual cost by day
      const scope = `/subscriptions/${subscriptionId}`;
      const usageQuery: any = {
        type: 'ActualCost',
        timeframe: 'Custom',
        timePeriod: { from, to },
        dataset: {
          granularity: 'Daily',
          aggregation: {
            totalCost: {
              name: 'Cost',
              function: 'Sum'
            }
          },
          grouping: [
            { type: 'Dimension', name: 'ResourceGroupName' },
            { type: 'Dimension', name: 'ResourceType' }
          ]
        }
      };

      if (rgFilter) {
        usageQuery.dataset.filter = {
          dimensions: {
            name: 'ResourceGroupName',
            operator: 'In',
            values: resourceGroups
          }
        };
      }

      console.log(`Fetching cost data for subscription ${subscriptionId}, ${resourceGroups.length} resource groups, period: ${from} to ${to}`);
      console.log('Resource groups requested:', resourceGroups);
      console.log('Query filter:', JSON.stringify(usageQuery.dataset.filter, null, 2));
      
      const result = await retryWithBackoff(
        () => costClient.query.usage(scope, usageQuery),
        `getCostData(${subscriptionId})`
      );
      
      console.log('API Response columns:', result.columns?.map((c: any) => c.name));
      console.log('API Response row count:', result.rows?.length || 0);
      
      // Process the results
      const costByDay: Array<{ date: string; cost: number }> = [];
      const costByRGMap = new Map<string, number>();
      const costDetailsMap = new Map<string, any>();
      const costByResourceByDay = new Map<string, Map<string, number>>(); // Track costs by resource by day for trend calculation
      
      if (result.rows && result.columns) {
        // Build column index map
        const columnMap = new Map<string, number>();
        result.columns.forEach((col: any, idx: number) => {
          columnMap.set(col.name, idx);
        });

        const costIdx = columnMap.get('Cost');
        const dateIdx = columnMap.get('UsageDate') || columnMap.get('Date');
        const rgIdx = columnMap.get('ResourceGroupName') || columnMap.get('ResourceGroup');
        const typeIdx = columnMap.get('ResourceType') || columnMap.get('ServiceName');

        console.log('Column indices:', { costIdx, dateIdx, rgIdx, typeIdx });

        // Track unique resource groups found
        const uniqueRGs = new Set<string>();

        // Process each row
        for (const row of result.rows) {
          const cost = costIdx !== undefined ? parseFloat(row[costIdx] || 0) : 0;
          const date = dateIdx !== undefined ? row[dateIdx] : null;
          const rg = rgIdx !== undefined ? row[rgIdx] : 'Unknown';
          const resourceType = typeIdx !== undefined ? row[typeIdx] : 'Unknown';

          uniqueRGs.add(rg);

          // Aggregate by day
          if (date) {
            const dateStr = typeof date === 'string' ? date.split('T')[0] : date.toString();
            const existing = costByDay.find(d => d.date === dateStr);
            if (existing) {
              existing.cost += cost;
            } else {
              costByDay.push({ date: dateStr, cost });
            }

            // Track by resource by day for trend calculation
            const key = `${rg}|${resourceType}`;
            if (!costByResourceByDay.has(key)) {
              costByResourceByDay.set(key, new Map());
            }
            const resourceDays = costByResourceByDay.get(key)!;
            resourceDays.set(dateStr, (resourceDays.get(dateStr) || 0) + cost);
          }

          // Aggregate by resource group
          const rgCost = costByRGMap.get(rg) || 0;
          costByRGMap.set(rg, rgCost + cost);

          // Store details
          const key = `${rg}|${resourceType}`;
          if (!costDetailsMap.has(key)) {
            costDetailsMap.set(key, {
              resourceGroup: rg,
              service: resourceType,
              resource: resourceType.split('/').pop() || resourceType,
              dailyCost: 0,
              totalCost: 0,
              trend: 0
            });
          }
          const detail = costDetailsMap.get(key);
          detail.totalCost += cost;
        }

        console.log('Unique resource groups found in data:', Array.from(uniqueRGs));
        console.log('Resource groups with costs:', Array.from(costByRGMap.keys()));
      }

      // Sort cost by day
      costByDay.sort((a, b) => a.date.localeCompare(b.date));

      // Calculate daily averages and trends for details
      const midpoint = Math.floor(days / 2);
      costDetailsMap.forEach((detail, key) => {
        detail.dailyCost = detail.totalCost / days;
        detail.dailyCost = parseFloat(detail.dailyCost.toFixed(2));
        detail.totalCost = parseFloat(detail.totalCost.toFixed(2));
        
        // Calculate real trend by comparing first half vs second half
        if (detail.totalCost === 0) {
          detail.trend = 0;
        } else {
          const resourceDays = costByResourceByDay.get(key);
          if (resourceDays && costByDay.length > 0) {
            const sortedDates = Array.from(resourceDays.keys()).sort();
            const firstHalfDates = sortedDates.slice(0, midpoint);
            const secondHalfDates = sortedDates.slice(midpoint);
            
            const firstHalfCost = firstHalfDates.reduce((sum, date) => sum + (resourceDays.get(date) || 0), 0);
            const secondHalfCost = secondHalfDates.reduce((sum, date) => sum + (resourceDays.get(date) || 0), 0);
            
            const firstAvg = firstHalfDates.length > 0 ? firstHalfCost / firstHalfDates.length : 0;
            const secondAvg = secondHalfDates.length > 0 ? secondHalfCost / secondHalfDates.length : 0;
            
            if (firstAvg > 0) {
              detail.trend = parseFloat((((secondAvg - firstAvg) / firstAvg) * 100).toFixed(1));
            } else if (secondAvg > 0) {
              detail.trend = 100; // Went from 0 to something
            } else {
              detail.trend = 0;
            }
          } else {
            detail.trend = 0;
          }
        }
      });

      // Convert maps to arrays
      const costByResourceGroup = Array.from(costByRGMap.entries()).map(([name, cost]) => ({
        name,
        cost: parseFloat(cost.toFixed(2))
      }));

      console.log('Cost by RG before adding zeros:', costByResourceGroup.map(rg => rg.name));

      // Add any requested resource groups that have no cost data (show as $0)
      for (const rg of resourceGroups) {
        if (!costByRGMap.has(rg)) {
          console.log(`Adding ${rg} with $0 cost`);
          costByResourceGroup.push({
            name: rg,
            cost: 0
          });
        }
      }

      console.log('Cost by RG after adding zeros:', costByResourceGroup.map(rg => ({ name: rg.name, cost: rg.cost })));

      const costDetails = Array.from(costDetailsMap.values());

      const totalCost = costByDay.reduce((sum, day) => sum + day.cost, 0);
      const dailyAverage = totalCost / days;
      const projectedMonthly = dailyAverage * 30;

      // Calculate percent change (comparing second half to first half)
      // Note: midpoint already declared earlier for detail trend calculations
      const firstHalf = costByDay.slice(0, midpoint);
      const secondHalf = costByDay.slice(midpoint);
      const firstAvg = firstHalf.reduce((sum, d) => sum + d.cost, 0) / firstHalf.length || 1;
      const secondAvg = secondHalf.reduce((sum, d) => sum + d.cost, 0) / secondHalf.length || 1;
      const percentChange = ((secondAvg - firstAvg) / firstAvg) * 100;

      console.log(`Cost data summary: Total=${totalCost.toFixed(2)}, Daily Avg=${dailyAverage.toFixed(2)}, ${costDetails.length} resources`);

      return {
        totalCost: parseFloat(totalCost.toFixed(2)),
        dailyAverage: parseFloat(dailyAverage.toFixed(2)),
        projectedMonthly: parseFloat(projectedMonthly.toFixed(2)),
        percentChange: parseFloat(percentChange.toFixed(2)),
        costByDay: costByDay.map(d => ({ ...d, cost: parseFloat(d.cost.toFixed(2)) })),
        costByResourceGroup,
        costDetails
      };
    } catch (error) {
      console.error('Error fetching Azure cost data:', error);
      console.error('Error details:', error instanceof Error ? error.message : 'Unknown error');
      throw new Error(`Failed to fetch Azure cost data: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private getDaysFromPeriod(period: '7d' | '30d' | '90d'): number {
    switch (period) {
      case '7d': return 7;
      case '30d': return 30;
      case '90d': return 90;
      default: return 30;
    }
  }

  /**
   * Get dashboard data showing top resource groups from each subscription
   * This provides a quick overview of cost drivers across all subscriptions
   */
  async getDashboardData(topN: number = 5): Promise<Array<{
    subscriptionId: string;
    subscriptionName: string;
    topResourceGroups: Array<{
      name: string;
      cost: number;
      trend: number;
    }>;
  }>> {
    try {
      const subscriptions = await this.getSubscriptions();
      const dashboardData = [];

      // Get cost data for each subscription (sequential with throttle to avoid 429s)
      for (let i = 0; i < subscriptions.length; i++) {
        const subscription = subscriptions[i];
        if (i > 0) await delay(1000);
        try {
          // Get all resource groups for this subscription
          const resourceGroups = await this.getResourceGroups(subscription.subscriptionId);
          
          if (resourceGroups.length === 0) {
            // No resource groups, skip this subscription
            continue;
          }

          // Get cost data for last 30 days
          const costData = await this.getCostData(
            subscription.subscriptionId,
            resourceGroups.map(rg => rg.name),
            '30d'
          );

          // Sort resource groups by cost and take top N
          const topResourceGroups = costData.costByResourceGroup
            .filter(rg => rg.cost > 0) // Only include resource groups with actual costs
            .sort((a, b) => b.cost - a.cost)
            .slice(0, topN)
            .map(rg => {
              // Find detailed cost data for this resource group to get trend
              const details = costData.costDetails.filter(d => d.resourceGroup === rg.name);
              const avgTrend = details.length > 0
                ? details.reduce((sum, d) => sum + d.trend, 0) / details.length
                : 0;

              return {
                name: rg.name,
                cost: rg.cost,
                trend: parseFloat(avgTrend.toFixed(1))
              };
            });

          dashboardData.push({
            subscriptionId: subscription.subscriptionId,
            subscriptionName: subscription.name,
            topResourceGroups
          });
        } catch (error) {
          console.error(`Error fetching cost data for subscription ${subscription.subscriptionId}:`, error);
          // Continue with other subscriptions
        }
      }

      return dashboardData;
    } catch (error) {
      console.error('Error fetching dashboard data:', error);
      throw new Error(`Failed to fetch dashboard data: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
