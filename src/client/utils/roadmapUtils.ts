import { WorkItem } from '../types/workitem';

export interface RoadmapItem {
  id: number;
  title: string;
  workItemType: string;
  targetDate: string;
  assignedTo?: string;
  state: string;
  createdDate: string;
  completionPercentage: number;
  childCount: number;
  completedCount: number;
  greenCount: number;
  amberCount: number;
  redCount: number;
  healthStatus: 'on-track' | 'in-progress' | 'behind' | 'ahead';
  daysRemaining: number;
  timeElapsedPercentage: number;
  children?: WorkItem[];
}

export interface TimelineColumn {
  label: string;
  startDate: Date;
  endDate: Date;
  isCurrentPeriod: boolean;
}

/**
 * Calculate the health status of a work item based on progress vs. time elapsed
 * @param completionPercentage - Percentage of child items completed (0-100)
 * @param timeElapsedPercentage - Percentage of time elapsed from creation to target date (0-100)
 * @param daysRemaining - Days remaining until target date
 * @param remainingItems - Number of items remaining to complete (optional)
 * @returns Health status indicator
 */
export function calculateHealthStatus(
  completionPercentage: number,
  timeElapsedPercentage: number,
  daysRemaining: number,
  remainingItems?: number
): 'on-track' | 'in-progress' | 'behind' | 'ahead' {
  const PLANNING_HORIZON_DAYS = 60; // Don't flag items as in-progress if deadline is beyond this
  const REASONABLE_ITEMS_PER_DAY = 1; // Expected velocity: items we can complete per day
  
  // If past target date (overdue)
  if (daysRemaining < 0) {
    return completionPercentage >= 100 ? 'on-track' : 'behind';
  }

  // If completed, always on track
  if (completionPercentage >= 100) {
    return 'on-track';
  }

  // If deadline is far in the future and work hasn't started, don't flag as at-risk
  // This follows Agile best practice - work is planned but not yet in active sprint
  if (daysRemaining > PLANNING_HORIZON_DAYS && completionPercentage === 0) {
    return 'on-track';
  }

  // Check if we have enough time to complete remaining items
  // If remainingItems is provided and we have more than enough time, mark as on-track
  if (remainingItems !== undefined && remainingItems > 0) {
    const daysNeeded = remainingItems / REASONABLE_ITEMS_PER_DAY;
    // If we have at least 20% buffer time, we're on track
    if (daysRemaining >= daysNeeded * 1.2) {
      return 'on-track';
    }
  }

  // If work has started or deadline is within planning horizon, evaluate progress
  if (completionPercentage > 0 || daysRemaining <= PLANNING_HORIZON_DAYS) {
    // Calculate ideal progress (should match time elapsed)
    const progressDelta = completionPercentage - timeElapsedPercentage;

    // Ahead if progress is significantly ahead of time
    if (progressDelta > 15) {
      return 'ahead';
    }

    // In progress if work has started and is being tracked
    if (progressDelta < -10) {
      return 'in-progress';
    }
  }

  // On track if progress roughly matches expectations
  return 'on-track';
}

/**
 * Calculate time elapsed percentage from creation to target date
 * @param createdDate - When the work item was created
 * @param targetDate - Target completion date
 * @returns Percentage of time elapsed (0-100)
 */
export function calculateTimeElapsed(createdDate: string, targetDate: string): number {
  // Parse dates as local dates, not UTC, to avoid timezone issues
  const parseLocalDate = (dateStr: string) => {
    const [year, month, day] = dateStr.split('-').map(Number);
    return new Date(year, month - 1, day);
  };
  
  const created = parseLocalDate(createdDate);
  const target = parseLocalDate(targetDate);
  const now = new Date();

  const totalDuration = target.getTime() - created.getTime();
  const elapsed = now.getTime() - created.getTime();

  if (totalDuration <= 0) return 100;
  
  const percentage = (elapsed / totalDuration) * 100;
  return Math.max(0, Math.min(100, percentage));
}

/**
 * Calculate days remaining until target date
 * @param targetDate - Target completion date
 * @returns Number of days remaining (negative if past due)
 */
export function calculateDaysRemaining(targetDate: string): number {
  // Parse date as local date, not UTC, to avoid timezone issues
  const [year, month, day] = targetDate.split('-').map(Number);
  const target = new Date(year, month - 1, day); // month is 0-indexed
  const now = new Date();
  
  // Reset time to midnight for accurate day calculation
  target.setHours(0, 0, 0, 0);
  now.setHours(0, 0, 0, 0);
  
  const diffTime = target.getTime() - now.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  return diffDays;
}

/**
 * Calculate completion percentage for a work item based on its children
 * @param children - Array of child work items
 * @returns Completion percentage (0-100)
 */
export function calculateCompletionPercentage(children: WorkItem[]): number {
  if (!children || children.length === 0) return 0;

  // Filter out "Removed" items from the calculation
  const activeChildren = children.filter(child => child.state !== 'Removed');
  
  if (activeChildren.length === 0) return 0;

  // For Features (children of Epics), only Done/Closed count as complete
  // For PBIs/TBIs/Bugs (children of Features), use the full completed states including Ready For Release
  const isFeatureLevel = activeChildren.some(child => child.workItemType === 'Feature');
  
  const completedStates = isFeatureLevel 
    ? ['Done', 'Closed']  // Features: only Done/Closed
    : ['Ready For Release', 'UAT - Test Done', 'Done', 'Closed'];  // PBIs/Bugs: include Ready For Release and UAT complete
  
  // In Progress states indicate active work
  const inProgressStates = ['In Progress', 'In Pull Request', 'Ready For Test', 'In Test'];
  
  let totalProgress = 0;
  
  activeChildren.forEach(child => {
    if (completedStates.includes(child.state)) {
      // Completed items count as 100%
      totalProgress += 100;
    } else if (inProgressStates.includes(child.state)) {
      // In-progress items count as 50% (actively being worked on)
      totalProgress += 50;
    }
    // New, Committed, and other states count as 0%
  });

  return Math.round(totalProgress / activeChildren.length);
}

/**
 * Calculate green/amber/red segment counts for a work item's children,
 * mirroring the same state classifications used by the Release tab progress bar.
 */
export function calculateSegmentedCounts(children: WorkItem[]): {
  greenCount: number;
  amberCount: number;
  redCount: number;
  activeTotal: number;
} {
  const activeChildren = children.filter(child => child.state !== 'Removed');

  const greenStates = ['Ready For Release', 'UAT - Test Done', 'Done', 'Closed'];
  const amberStates = ['UAT - Ready For Test', 'UAT Ready For Test', 'UAT-Ready For Test'];

  let greenCount = 0;
  let amberCount = 0;
  let redCount = 0;

  activeChildren.forEach(child => {
    if (greenStates.includes(child.state)) {
      greenCount++;
    } else if (amberStates.includes(child.state)) {
      amberCount++;
    } else {
      redCount++;
    }
  });

  return { greenCount, amberCount, redCount, activeTotal: activeChildren.length };
}

/**
 * Generate monthly timeline columns for a given date range
 * @param startDate - Start of the timeline
 * @param endDate - End of the timeline
 * @returns Array of timeline columns
 */
export function generateMonthlyTimeline(startDate: Date, endDate: Date): TimelineColumn[] {
  const columns: TimelineColumn[] = [];
  const current = new Date(startDate);
  const now = new Date();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();

  while (current <= endDate) {
    const year = current.getFullYear();
    const month = current.getMonth();
    
    const monthStart = new Date(year, month, 1);
    const monthEnd = new Date(year, month + 1, 0, 23, 59, 59, 999); // Last day of month at end of day

    const isCurrentPeriod = year === currentYear && month === currentMonth;

    columns.push({
      label: monthStart.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
      startDate: monthStart,
      endDate: monthEnd,
      isCurrentPeriod
    });

    // Move to next month
    current.setMonth(current.getMonth() + 1);
  }

  return columns;
}

/**
 * Generate quarterly timeline columns for a given date range
 * @param startDate - Start of the timeline
 * @param endDate - End of the timeline
 * @returns Array of timeline columns
 */
export function generateQuarterlyTimeline(startDate: Date, endDate: Date): TimelineColumn[] {
  const columns: TimelineColumn[] = [];
  const current = new Date(startDate);
  const now = new Date();
  const currentQuarter = Math.floor(now.getMonth() / 3);
  const currentYear = now.getFullYear();

  // Start at the beginning of the current quarter
  const startQuarter = Math.floor(current.getMonth() / 3);
  current.setMonth(startQuarter * 3);
  current.setDate(1);

  while (current <= endDate) {
    const year = current.getFullYear();
    const quarter = Math.floor(current.getMonth() / 3);
    
    const quarterStart = new Date(year, quarter * 3, 1);
    const quarterEnd = new Date(year, quarter * 3 + 3, 0, 23, 59, 59, 999); // Last day of quarter at end of day

    const isCurrentPeriod = year === currentYear && quarter === currentQuarter;

    columns.push({
      label: `Q${quarter + 1} ${year}`,
      startDate: quarterStart,
      endDate: quarterEnd,
      isCurrentPeriod
    });

    // Move to next quarter
    current.setMonth(current.getMonth() + 3);
  }

  return columns;
}

/**
 * Check if a target date falls within a timeline column
 * @param targetDate - The target date to check (YYYY-MM-DD format)
 * @param column - The timeline column
 * @returns True if the date falls within the column
 */
export function isDateInColumn(targetDate: string, column: TimelineColumn): boolean {
  // Parse date as local time to avoid timezone issues
  const [year, month, day] = targetDate.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  
  // Set hours to noon to avoid any edge cases with date comparisons
  date.setHours(12, 0, 0, 0);
  
  return date >= column.startDate && date <= column.endDate;
}

/**
 * Filter and prepare roadmap items from work items
 * @param workItems - All work items
 * @param includeTypes - Work item types to include ('Epic', 'Feature', or both)
 * @returns Array of roadmap items with health status
 */
export function prepareRoadmapItems(
  workItems: WorkItem[],
  includeTypes: ('Epic' | 'Feature')[]
): RoadmapItem[] {
  return workItems
    .filter(item => 
      includeTypes.includes(item.workItemType as any) && 
      item.targetDate
    )
    .map(item => {
      const completionPercentage = 0; // Will be calculated from children
      const timeElapsedPercentage = calculateTimeElapsed(item.createdDate, item.targetDate!);
      const daysRemaining = calculateDaysRemaining(item.targetDate!);
      // remainingItems will be calculated when children are populated
      const remainingItems = 0;
      
      return {
        id: item.id,
        title: item.title,
        workItemType: item.workItemType,
        targetDate: item.targetDate!,
        assignedTo: item.assignedTo,
        state: item.state,
        createdDate: item.createdDate,
        completionPercentage,
        childCount: 0,
        completedCount: 0,
        greenCount: 0,
        amberCount: 0,
        redCount: 0,
        healthStatus: calculateHealthStatus(completionPercentage, timeElapsedPercentage, daysRemaining, remainingItems),
        daysRemaining,
        timeElapsedPercentage,
        children: []
      };
    })
    .sort((a, b) => new Date(a.targetDate).getTime() - new Date(b.targetDate).getTime());
}

/**
 * Get health status color for UI display
 * @param status - Health status
 * @returns CSS color value
 */
export function getHealthStatusColor(status: 'on-track' | 'in-progress' | 'behind' | 'ahead'): string {
  const colors = {
    'on-track': '#4CAF50',
    'ahead': '#2196F3',
    'in-progress': '#2196F3',
    'behind': '#F44336'
  };
  return colors[status];
}

/**
 * Get health status label for UI display
 * @param status - Health status
 * @returns Human-readable label
 */
export function getHealthStatusLabel(status: 'on-track' | 'in-progress' | 'behind' | 'ahead'): string {
  const labels = {
    'on-track': 'On Track',
    'ahead': 'Ahead',
    'in-progress': 'In Progress',
    'behind': 'Behind'
  };
  return labels[status];
}
