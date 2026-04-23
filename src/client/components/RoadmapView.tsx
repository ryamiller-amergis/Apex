import React, { useState, useEffect } from 'react';
import { WorkItem } from '../types/workitem';
import {
  RoadmapItem,
  TimelineColumn,
  generateMonthlyTimeline,
  generateQuarterlyTimeline,
  isDateInColumn,
  calculateCompletionPercentage,
  calculateSegmentedCounts,
  calculateHealthStatus,
  calculateTimeElapsed,
  calculateDaysRemaining,
  getHealthStatusColor,
  getHealthStatusLabel
} from '../utils/roadmapUtils';
import './RoadmapView.css';

interface RoadmapViewProps {
  workItems: WorkItem[];
  project: string;
  areaPath: string;
  onSelectItem?: (workItem: WorkItem) => void;
}

type TimelineGranularity = 'monthly' | 'quarterly';

const RoadmapView: React.FC<RoadmapViewProps> = ({ workItems, project, areaPath, onSelectItem }) => {
  const [granularity, setGranularity] = useState<TimelineGranularity>('monthly');
  const [timelineMonths, setTimelineMonths] = useState<number>(6);
  const [roadmapItems, setRoadmapItems] = useState<RoadmapItem[]>([]);
  const [expandedItems, setExpandedItems] = useState<Set<number>>(new Set());
  const [childrenCache, setChildrenCache] = useState<Map<number, WorkItem[]>>(new Map());
  const [loadingChildren, setLoadingChildren] = useState<Set<number>>(new Set());
  const [showInfoPanel, setShowInfoPanel] = useState<boolean>(false);
  const [selectedStatuses, setSelectedStatuses] = useState<Set<string>>(new Set(['New', 'In Progress', 'In Design']));

  // Generate timeline columns based on granularity and time range
  const timelineColumns: TimelineColumn[] = React.useMemo(() => {
    const now = new Date();
    const startDate = new Date(now);
    startDate.setMonth(startDate.getMonth() - 1); // Start from last month
    
    const endDate = new Date(now);
    endDate.setMonth(endDate.getMonth() + timelineMonths);

    if (granularity === 'quarterly') {
      return generateQuarterlyTimeline(startDate, endDate);
    } else {
      return generateMonthlyTimeline(startDate, endDate);
    }
  }, [granularity, timelineMonths]);

  // Fetch children for a roadmap item
  const fetchChildren = async (item: RoadmapItem) => {
    if (childrenCache.has(item.id)) {
      return childrenCache.get(item.id)!;
    }

    setLoadingChildren(prev => new Set(prev).add(item.id));

    try {
      const endpoint = item.workItemType === 'Epic' 
        ? `/api/epics/${item.id}/children`
        : `/api/features/${item.id}/children`;

      const response = await fetch(
        `${endpoint}?project=${encodeURIComponent(project)}&areaPath=${encodeURIComponent(areaPath)}`
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch children for ${item.workItemType} ${item.id}`);
      }

      const children: WorkItem[] = await response.json();
      
      setChildrenCache(prev => new Map(prev).set(item.id, children));
      setLoadingChildren(prev => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });

      // If this is an Epic, also fetch children for all Features to calculate their completion
      if (item.workItemType === 'Epic') {
        const features = children.filter(child => child.workItemType === 'Feature');
        features.forEach(feature => {
          if (!childrenCache.has(feature.id)) {
            fetchChildren({
              id: feature.id,
              title: feature.title,
              workItemType: feature.workItemType,
              targetDate: feature.targetDate || '',
              assignedTo: feature.assignedTo,
              state: feature.state,
              createdDate: feature.createdDate,
              completionPercentage: 0,
              childCount: 0,
              completedCount: 0,
              greenCount: 0,
              amberCount: 0,
              redCount: 0,
              healthStatus: 'on-track',
              daysRemaining: 0,
              timeElapsedPercentage: 0,
              children: []
            } as RoadmapItem);
          }
        });
      }

      return children;
    } catch (error) {
      console.error(`Error fetching children for ${item.workItemType} ${item.id}:`, error);
      setLoadingChildren(prev => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
      return [];
    }
  };

  // Prepare roadmap items when work items change
  useEffect(() => {
    // Only show Epics with target dates in the main view (exclude ReleaseVersion epics)
    const epicsWithTargetDates = workItems.filter(item => {
      const hasTargetDate = !!item.targetDate;
      const isEpic = item.workItemType === 'Epic';
      const matchesStatus = selectedStatuses.size === 0 || selectedStatuses.has(item.state);
      const notReleaseVersion = !item.tags?.includes('ReleaseVersion');
      
      return hasTargetDate && isEpic && matchesStatus && notReleaseVersion;
    });

    const items = epicsWithTargetDates.map(item => {
      const completionPercentage = 0;
      const timeElapsedPercentage = calculateTimeElapsed(item.createdDate, item.targetDate!);
      const daysRemaining = calculateDaysRemaining(item.targetDate!);
      
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
        healthStatus: calculateHealthStatus(completionPercentage, timeElapsedPercentage, daysRemaining, 0) as 'on-track' | 'in-progress' | 'behind' | 'ahead',
        daysRemaining,
        timeElapsedPercentage,
        children: []
      };
    }).sort((a, b) => new Date(a.targetDate).getTime() - new Date(b.targetDate).getTime());
    
    // Update children cache with fresh work item data
    const updatedCache = new Map(childrenCache);
    let cacheUpdated = false;
    
    updatedCache.forEach((children, parentId) => {
      const updatedChildren = children.map(cachedChild => {
        const freshChild = workItems.find(wi => wi.id === cachedChild.id);
        if (freshChild && (
          freshChild.targetDate !== cachedChild.targetDate ||
          freshChild.state !== cachedChild.state ||
          freshChild.title !== cachedChild.title
        )) {
          cacheUpdated = true;
          return freshChild;
        }
        return cachedChild;
      });
      updatedCache.set(parentId, updatedChildren);
    });
    
    if (cacheUpdated) {
      setChildrenCache(updatedCache);
    }
    
    // Immediately apply cached children data to prevent percentage flicker on refresh
    const itemsWithCachedData = items.map(item => {
      const children = updatedCache.get(item.id);
      if (children) {
        return updateItemWithChildren(item, children);
      }
      return item;
    });
    
    setRoadmapItems(itemsWithCachedData);
    
    // Fetch children for Epics that don't have cached data
    items.forEach(item => {
      if (!updatedCache.has(item.id)) {
        fetchChildren(item);
      }
    });
  }, [workItems, selectedStatuses]);

  // Update roadmap items with completion data from children
  useEffect(() => {
    if (roadmapItems.length === 0) return;
    
    const updatedItems = roadmapItems.map((item) => {
      const children = childrenCache.get(item.id);
      if (children) {
        return updateItemWithChildren(item, children);
      }
      return item;
    });
    
    // Only update if there's actually a change
    const hasChanges = updatedItems.some((item, index) => 
      item.completionPercentage !== roadmapItems[index].completionPercentage ||
      item.childCount !== roadmapItems[index].childCount
    );
    
    if (hasChanges) {
      setRoadmapItems(updatedItems);
    }
  }, [childrenCache]);

  const updateItemWithChildren = (item: RoadmapItem, children: WorkItem[]): RoadmapItem => {
    const completionPercentage = calculateCompletionPercentage(children);
    
    // Filter out "Removed" items from calculations
    const activeChildren = children.filter(child => child.state !== 'Removed');

    // Segmented counts (green/amber/red) matching Release tab state classifications
    const { greenCount, amberCount, redCount } = calculateSegmentedCounts(children);

    const daysRemaining = calculateDaysRemaining(item.targetDate);
    
    // Calculate remaining work - count in-progress items as 0.5 remaining since they're already half done
    const inProgressStates = ['In Progress', 'In Pull Request', 'Ready For Test', 'In Test'];
    const greenStates = ['Ready For Release', 'UAT - Test Done', 'Done', 'Closed'];
    const inProgressCount = activeChildren.filter(child => inProgressStates.includes(child.state)).length;
    const notStartedCount = activeChildren.filter(child => 
      !greenStates.includes(child.state) && !inProgressStates.includes(child.state)
    ).length;
    const remainingItems = (inProgressCount * 0.5) + notStartedCount;
    
    // Find earliest created date from children or use item's date
    const createdDates = activeChildren.map(c => new Date(c.createdDate).getTime()).filter(d => !isNaN(d));
    const earliestCreated = createdDates.length > 0 ? new Date(Math.min(...createdDates)) : new Date(item.targetDate);
    
    const actualTimeElapsed = calculateTimeElapsed(earliestCreated.toISOString(), item.targetDate);
    const healthStatus = calculateHealthStatus(completionPercentage, actualTimeElapsed, daysRemaining, remainingItems);

    return {
      ...item,
      completionPercentage,
      childCount: activeChildren.length,
      completedCount: greenCount,
      greenCount,
      amberCount,
      redCount,
      healthStatus,
      daysRemaining,
      timeElapsedPercentage: actualTimeElapsed,
      children
    };
  };

  const toggleExpanded = async (itemId: number) => {
    // First check if it's a top-level roadmap item
    let item = roadmapItems.find(i => i.id === itemId);
    
    // If not found, it might be a Feature child, search through children cache
    if (!item) {
      for (const children of childrenCache.values()) {
        const foundChild = children.find(c => c.id === itemId);
        if (foundChild) {
          // Convert WorkItem to RoadmapItem structure for fetchChildren
          item = {
            id: foundChild.id,
            title: foundChild.title,
            workItemType: foundChild.workItemType,
            targetDate: foundChild.targetDate || '',
            assignedTo: foundChild.assignedTo,
            state: foundChild.state,
            createdDate: foundChild.createdDate,
            completionPercentage: 0,
            childCount: 0,
            completedCount: 0,
            greenCount: 0,
            amberCount: 0,
            redCount: 0,
            healthStatus: 'on-track',
            daysRemaining: 0,
            timeElapsedPercentage: 0,
            children: []
          } as RoadmapItem;
          break;
        }
      }
    }
    
    if (!item) return;

    if (expandedItems.has(itemId)) {
      setExpandedItems(prev => {
        const next = new Set(prev);
        next.delete(itemId);
        return next;
      });
    } else {
      if (!childrenCache.has(itemId)) {
        await fetchChildren(item);
      }
      setExpandedItems(prev => new Set(prev).add(itemId));
    }
  };

  const formatDate = (dateString: string): string => {
    // Parse as local date to avoid timezone issues
    const [year, month, day] = dateString.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const unscheduledItems = roadmapItems.filter(item => !item.targetDate || item.targetDate === '');

  return (
    <div className="roadmap-view">
      <div className="roadmap-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <h2>Roadmap</h2>
          <div 
            className="info-icon"
            onClick={() => setShowInfoPanel(!showInfoPanel)}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
              <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
            </svg>
          </div>
        </div>
        <div className="roadmap-controls">
          <div className="control-group">
            <label>Timeline:</label>
            <select 
              value={granularity} 
              onChange={(e) => setGranularity(e.target.value as TimelineGranularity)}
            >
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
            </select>
          </div>

          <div className="control-group">
            <label>Months Ahead:</label>
            <select 
              value={timelineMonths} 
              onChange={(e) => setTimelineMonths(parseInt(e.target.value))}
            >
              <option value="3">3 Months</option>
              <option value="6">6 Months</option>
              <option value="12">12 Months</option>
            </select>
          </div>

          <div className="control-group">
            <label>Status Filter:</label>
            <div className="status-checkboxes">
              {['New', 'In Progress', 'In Design', 'Done', 'Removed'].map(status => (
                <label key={status} className="status-checkbox-label">
                  <input
                    type="checkbox"
                    checked={selectedStatuses.has(status)}
                    onChange={(e) => {
                      const newStatuses = new Set(selectedStatuses);
                      if (e.target.checked) {
                        newStatuses.add(status);
                      } else {
                        newStatuses.delete(status);
                      }
                      setSelectedStatuses(newStatuses);
                    }}
                  />
                  <span>{status}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>

      {showInfoPanel && (
        <div className="roadmap-info-panel">
          <div className="info-section">
            <h3>Status Indicators</h3>
            <div className="status-explanations">
              <div className="status-item">
                <span className="status-badge" style={{ backgroundColor: getHealthStatusColor('on-track') }}>On Track</span>
                <p>Completed work aligns with the timeline. Less than 75% of time has elapsed, or completion percentage is on pace with time elapsed.</p>
              </div>
              <div className="status-item">
                <span className="status-badge" style={{ backgroundColor: getHealthStatusColor('ahead') }}>Ahead</span>
                <p>Exceptional progress! Completion percentage significantly exceeds time elapsed (more than 20% faster than expected).</p>
              </div>
              <div className="status-item">
                <span className="status-badge" style={{ backgroundColor: getHealthStatusColor('in-progress') }}>In Progress</span>
                <p>Work is actively happening but pacing slightly behind the ideal timeline. Items in this state are being worked on and have time remaining, but may need attention to stay on schedule.</p>
              </div>
              <div className="status-item">
                <span className="status-badge" style={{ backgroundColor: getHealthStatusColor('behind') }}>Behind</span>
                <p>Work is overdue. The target date has passed but work is not yet completed.</p>
              </div>
            </div>
          </div>

          <div className="info-section">
            <h3>Percentages</h3>
            <p>Percentages represent the completion rate of child items within each roadmap item:</p>
            <ul>
              <li><strong>Epics:</strong> Features are counted as complete when marked as "Done" or "Closed"</li>
              <li><strong>Features:</strong> Child items (PBIs/TBIs/Bugs) are counted as complete when marked as "Ready For Release", "UAT - Test Done", "Done", or "Closed"</li>
              <li><strong>In-Progress Items:</strong> Items actively being worked on count as 50% toward completion</li>
              <li><strong>Progress Bar:</strong> Visual representation of completion percentage</li>
            </ul>
          </div>

          <div className="info-section">
            <h3>Planning Horizon</h3>
            <p>Items beyond 60 days in the future are not flagged as "At Risk" even if work hasn't started, following Agile best practices for forward planning.</p>
          </div>
        </div>
      )}

      <div className="roadmap-legend">

        <div className="legend-item">
          <span className="legend-dot" style={{ backgroundColor: getHealthStatusColor('on-track') }}></span>
          <span>On Track</span>
        </div>
        <div className="legend-item">
          <span className="legend-dot" style={{ backgroundColor: getHealthStatusColor('ahead') }}></span>
          <span>Ahead</span>
        </div>
        <div className="legend-item">
          <span className="legend-dot" style={{ backgroundColor: getHealthStatusColor('in-progress') }}></span>
          <span>In Progress</span>
        </div>
        <div className="legend-item">
          <span className="legend-dot" style={{ backgroundColor: getHealthStatusColor('behind') }}></span>
          <span>Behind</span>
        </div>
      </div>

      <div className="roadmap-timeline" style={{ '--timeline-columns': timelineColumns.length } as React.CSSProperties}>
        <div className="timeline-header">
          <div className="timeline-label-column">Work Items</div>
          {timelineColumns.map((column, index) => (
            <div 
              key={index} 
              className={`timeline-column-header ${column.isCurrentPeriod ? 'current-period' : ''}`}
            >
              {column.label}
            </div>
          ))}
        </div>

        <div className="timeline-body">
          {roadmapItems.map((item) => {
            const isExpanded = expandedItems.has(item.id);
            const isLoading = loadingChildren.has(item.id);
            const children = childrenCache.get(item.id);

            return (
              <div key={item.id} className="timeline-row-group">
                <div className="timeline-row">
                  <div className="timeline-label-column">
                    <div className="roadmap-item-label">
                      <button 
                        className="expand-button"
                        onClick={() => toggleExpanded(item.id)}
                        disabled={isLoading}
                        style={{ visibility: (children && children.length > 0) || isLoading ? 'visible' : 'hidden' }}
                      >
                        {isLoading ? '⏳' : isExpanded ? '▼' : '▶'}
                      </button>
                      <span className="work-item-type-badge" data-type={item.workItemType.toLowerCase()}>
                        {item.workItemType}
                      </span>
                      <span 
                        className="work-item-title clickable" 
                        onClick={() => {
                          const workItem = workItems.find(w => w.id === item.id);
                          if (workItem && onSelectItem) onSelectItem(workItem);
                        }}
                        title="Click to view details"
                      >
                        {item.title}
                      </span>
                      {item.assignedTo && (
                        <span className="work-item-assignee">({item.assignedTo})</span>
                      )}
                    </div>
                  </div>

                  {timelineColumns.map((column, colIndex) => {
                    const isItemInColumn = isDateInColumn(item.targetDate, column);
                    
                    return (
                      <div key={colIndex} className={`timeline-cell ${column.isCurrentPeriod ? 'current-period' : ''}`}>
                        {isItemInColumn && (
                          <div 
                            className="roadmap-card"
                            style={{ borderLeftColor: getHealthStatusColor(item.healthStatus) }}
                          >
                            <div className="roadmap-card-header">
                              <span className="target-date">{formatDate(item.targetDate)}</span>
                              <span 
                                className="health-badge"
                                style={{ 
                                  backgroundColor: getHealthStatusColor(item.healthStatus),
                                  color: 'white'
                                }}
                              >
                                {getHealthStatusLabel(item.healthStatus)}
                              </span>
                            </div>
                            
                            <div className="progress-section">
                              <div className="progress-bar-container">
                                {item.childCount > 0 && (
                                  <>
                                    <div
                                      className="progress-bar-segment segment-green"
                                      style={{ width: `${(item.greenCount / item.childCount) * 100}%` }}
                                      title={`Ready / Done: ${item.greenCount}`}
                                    ></div>
                                    <div
                                      className="progress-bar-segment segment-amber"
                                      style={{ width: `${(item.amberCount / item.childCount) * 100}%` }}
                                      title={`UAT Ready for Test: ${item.amberCount}`}
                                    ></div>
                                    <div
                                      className="progress-bar-segment segment-red"
                                      style={{ width: `${(item.redCount / item.childCount) * 100}%` }}
                                      title={`Other: ${item.redCount}`}
                                    ></div>
                                  </>
                                )}
                              </div>
                              <div className="progress-stats">
                                <span className="completion-percentage">
                                  {item.childCount > 0 ? Math.round((item.greenCount / item.childCount) * 100) : 0}%
                                </span>
                                <span className="completion-count">
                                  {item.greenCount}/{item.childCount} items
                                </span>
                              </div>
                            </div>

                            <div className="days-remaining">
                              {item.state === 'Done' || item.state === 'Closed' 
                                ? 'Completed'
                                : item.daysRemaining >= 0 
                                  ? `${item.daysRemaining} days remaining`
                                  : `${Math.abs(item.daysRemaining)} days overdue`
                              }
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {isExpanded && children && (
                  <div className="timeline-children">
                    {children.filter(child => selectedStatuses.size === 0 || selectedStatuses.has(child.state)).map(child => {
                      const isChildExpanded = expandedItems.has(child.id);
                      const isChildLoading = loadingChildren.has(child.id);
                      const grandChildren = childrenCache.get(child.id);
                      const isFeature = child.workItemType === 'Feature';

                      return (
                        <React.Fragment key={child.id}>
                          <div className="timeline-row child-row">
                            <div className="timeline-label-column">
                              <div className="roadmap-item-label child-label">
                                <span className="child-indent">└─</span>
                                {isFeature && (
                                  <button 
                                    className="expand-button"
                                    onClick={() => toggleExpanded(child.id)}
                                    disabled={isChildLoading}
                                  >
                                    {isChildLoading ? '⏳' : isChildExpanded ? '▼' : '▶'}
                                  </button>
                                )}
                                <span className="work-item-type-badge small" data-type={child.workItemType.toLowerCase()}>
                                  {child.workItemType === 'Product Backlog Item' ? 'PBI' : 
                                   child.workItemType === 'Technical Backlog Item' ? 'TBI' : 
                                   child.workItemType === 'Feature' ? 'Feature' :
                                   child.workItemType === 'Bug' ? 'Bug' :
                                   child.workItemType}
                                </span>
                                <span 
                                  className="work-item-title clickable" 
                                  onClick={() => onSelectItem && onSelectItem(child)}
                                  title="Click to view details"
                                >
                                  {child.title}
                                </span>
                                {child.assignedTo && (
                                  <span className="work-item-assignee">({child.assignedTo})</span>
                                )}
                                <span className="work-item-state" data-state={child.state.toLowerCase().replace(/\s+/g, '-')}>
                                  {child.state}
                                </span>
                                {isFeature && grandChildren && (
                                  <div className="feature-progress-inline">
                                    <span className="feature-completion-text">
                                      {(() => {
                                        // Filter out "Removed" items from percentage calculation
                                        const activeGrandChildren = grandChildren.filter(gc => gc.state !== 'Removed');
                                        const completedStates = ['Ready For Release', 'UAT - Test Done', 'Done', 'Closed'];
                                        const completedCount = activeGrandChildren.filter(gc => completedStates.includes(gc.state)).length;
                                        const percentage = activeGrandChildren.length > 0 ? Math.round((completedCount / activeGrandChildren.length) * 100) : 0;
                                        return `${percentage}% (${completedCount}/${activeGrandChildren.length})`;
                                      })()}
                                    </span>
                                  </div>
                                )}
                              </div>
                            </div>
                            {timelineColumns.map((column, colIndex) => {
                              const isFeatureInColumn = child.targetDate && isDateInColumn(child.targetDate, column);
                              
                              return (
                                <div key={colIndex} className={`timeline-cell ${column.isCurrentPeriod ? 'current-period' : ''}`}>
                                  {isFeature && isFeatureInColumn && (
                                    <div 
                                      className="roadmap-card feature-card"
                                      style={{ 
                                        borderLeftColor: (() => {
                                          if (!grandChildren || grandChildren.length === 0) {
                                            const daysRemaining = calculateDaysRemaining(child.targetDate!);
                                            const timeElapsed = calculateTimeElapsed(child.createdDate, child.targetDate!);
                                            const healthStatus = calculateHealthStatus(0, timeElapsed, daysRemaining);
                                            return getHealthStatusColor(healthStatus);
                                          }
                                          const completedStates = ['Ready For Release', 'UAT - Test Done', 'Done', 'Closed'];
                                          const completedCount = grandChildren.filter(gc => completedStates.includes(gc.state)).length;
                                          const percentage = grandChildren.length > 0 ? Math.round((completedCount / grandChildren.length) * 100) : 0;
                                          const daysRemaining = calculateDaysRemaining(child.targetDate!);
                                          const timeElapsed = calculateTimeElapsed(child.createdDate, child.targetDate!);
                                          const healthStatus = calculateHealthStatus(percentage, timeElapsed, daysRemaining);
                                          return getHealthStatusColor(healthStatus);
                                        })()
                                      }}
                                    >
                                      <div className="roadmap-card-header">
                                        <span className="target-date">{child.targetDate ? formatDate(child.targetDate) : ''}</span>
                                        <span 
                                          className="health-badge"
                                          style={{ 
                                            backgroundColor: (() => {
                                              if (!grandChildren || grandChildren.length === 0) {
                                                const daysRemaining = calculateDaysRemaining(child.targetDate!);
                                                const timeElapsed = calculateTimeElapsed(child.createdDate, child.targetDate!);
                                                const healthStatus = calculateHealthStatus(0, timeElapsed, daysRemaining);
                                                return getHealthStatusColor(healthStatus);
                                              }
                                              const completedStates = ['Ready For Release', 'UAT - Test Done', 'Done', 'Closed'];
                                              const completedCount = grandChildren.filter(gc => completedStates.includes(gc.state)).length;
                                              const percentage = grandChildren.length > 0 ? Math.round((completedCount / grandChildren.length) * 100) : 0;
                                              const daysRemaining = calculateDaysRemaining(child.targetDate!);
                                              const timeElapsed = calculateTimeElapsed(child.createdDate, child.targetDate!);
                                              const healthStatus = calculateHealthStatus(percentage, timeElapsed, daysRemaining);
                                              return getHealthStatusColor(healthStatus);
                                            })(),
                                            color: 'white'
                                          }}
                                        >
                                          {(() => {
                                            if (!grandChildren || grandChildren.length === 0) {
                                              const daysRemaining = calculateDaysRemaining(child.targetDate!);
                                              const timeElapsed = calculateTimeElapsed(child.createdDate, child.targetDate!);
                                              const healthStatus = calculateHealthStatus(0, timeElapsed, daysRemaining);
                                              return getHealthStatusLabel(healthStatus);
                                            }
                                            const completedStates = ['Ready For Release', 'UAT - Test Done', 'Done', 'Closed'];
                                            const completedCount = grandChildren.filter(gc => completedStates.includes(gc.state)).length;
                                            const percentage = grandChildren.length > 0 ? Math.round((completedCount / grandChildren.length) * 100) : 0;
                                            const daysRemaining = calculateDaysRemaining(child.targetDate!);
                                            const timeElapsed = calculateTimeElapsed(child.createdDate, child.targetDate!);
                                            const healthStatus = calculateHealthStatus(percentage, timeElapsed, daysRemaining);
                                            return getHealthStatusLabel(healthStatus);
                                          })()}
                                        </span>
                                      </div>
                                      
                                      {(() => {
                                        const activeGC = grandChildren
                                          ? grandChildren.filter(gc => gc.state !== 'Removed')
                                          : [];
                                        const gcGreenStates = ['Ready For Release', 'UAT - Test Done', 'Done', 'Closed'];
                                        const gcAmberStates = ['UAT - Ready For Test', 'UAT Ready For Test', 'UAT-Ready For Test'];
                                        const gcGreen = activeGC.filter(gc => gcGreenStates.includes(gc.state)).length;
                                        const gcAmber = activeGC.filter(gc => gcAmberStates.includes(gc.state)).length;
                                        const gcRed = activeGC.length - gcGreen - gcAmber;
                                        const gcTotal = activeGC.length;
                                        const gcGreenPct = gcTotal > 0 ? Math.round((gcGreen / gcTotal) * 100) : 0;
                                        return (
                                          <div className="progress-section">
                                            <div className="progress-bar-container">
                                              {gcTotal > 0 && (
                                                <>
                                                  <div
                                                    className="progress-bar-segment segment-green"
                                                    style={{ width: `${(gcGreen / gcTotal) * 100}%` }}
                                                    title={`Ready / Done: ${gcGreen}`}
                                                  ></div>
                                                  <div
                                                    className="progress-bar-segment segment-amber"
                                                    style={{ width: `${(gcAmber / gcTotal) * 100}%` }}
                                                    title={`UAT Ready for Test: ${gcAmber}`}
                                                  ></div>
                                                  <div
                                                    className="progress-bar-segment segment-red"
                                                    style={{ width: `${(gcRed / gcTotal) * 100}%` }}
                                                    title={`Other: ${gcRed}`}
                                                  ></div>
                                                </>
                                              )}
                                            </div>
                                            <div className="progress-stats">
                                              <span className="completion-percentage">{gcGreenPct}%</span>
                                              <span className="completion-count">{gcGreen}/{gcTotal} items</span>
                                            </div>
                                          </div>
                                        );
                                      })()}

                                      <div className="days-remaining">
                                        {child.state === 'Done' || child.state === 'Closed' 
                                          ? 'Completed'
                                          : child.targetDate && (() => {
                                              const daysRemaining = calculateDaysRemaining(child.targetDate);
                                              return daysRemaining >= 0 
                                                ? `${daysRemaining} days remaining`
                                                : `${Math.abs(daysRemaining)} days overdue`;
                                            })()
                                        }
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          
                          {isFeature && isChildExpanded && grandChildren && (
                            <div className="timeline-children nested">
                              {grandChildren.map(grandChild => {
                                const isPBIorTBI = grandChild.workItemType === 'Product Backlog Item' || 
                                                    grandChild.workItemType === 'Technical Backlog Item' ||
                                                    grandChild.workItemType === 'Bug';
                                
                                return (
                                  <div key={grandChild.id} className="timeline-row child-row nested-child">
                                    <div className="timeline-label-column">
                                      <div className="roadmap-item-label child-label">
                                        <span className="child-indent">  └─</span>
                                        <span className="work-item-type-badge small" data-type={grandChild.workItemType.toLowerCase()}>
                                          {grandChild.workItemType === 'Product Backlog Item' ? 'PBI' : 
                                           grandChild.workItemType === 'Technical Backlog Item' ? 'TBI' : 
                                           grandChild.workItemType === 'Bug' ? 'Bug' :
                                           grandChild.workItemType}
                                        </span>
                                        <span 
                                          className="work-item-title clickable" 
                                          onClick={() => onSelectItem && onSelectItem(grandChild)}
                                          title="Click to view details"
                                        >
                                          {grandChild.title}
                                        </span>
                                        {grandChild.assignedTo && (
                                          <span className="work-item-assignee">({grandChild.assignedTo})</span>
                                        )}
                                        <span className="work-item-state" data-state={grandChild.state.toLowerCase().replace(/\s+/g, '-')}>
                                          {grandChild.state}
                                        </span>
                                      </div>
                                    </div>
                                    {timelineColumns.map((column, colIndex) => {
                                      // For PBI/TBI, check dueDate; for Bug, check targetDate
                                      const isPBIorTBIType = grandChild.workItemType === 'Product Backlog Item' || 
                                                              grandChild.workItemType === 'Technical Backlog Item';
                                      const dateToCheck = isPBIorTBIType ? grandChild.dueDate : grandChild.targetDate;
                                      const isItemInColumn = dateToCheck && isDateInColumn(dateToCheck, column);
                                      
                                      return (
                                        <div key={colIndex} className={`timeline-cell ${column.isCurrentPeriod ? 'current-period' : ''}`}>
                                          {isPBIorTBI && isItemInColumn && (
                                            <div 
                                              className="roadmap-card pbi-card"
                                              style={{ 
                                                borderLeftColor: (() => {
                                                  const completedStates = ['UAT - Test Done', 'Done', 'Closed'];
                                                  const isCompleted = completedStates.includes(grandChild.state);
                                                  const percentage = isCompleted ? 100 : 0;
                                                  const daysRemaining = calculateDaysRemaining(dateToCheck!);
                                                  const timeElapsed = calculateTimeElapsed(grandChild.createdDate, dateToCheck!);
                                                  const healthStatus = calculateHealthStatus(percentage, timeElapsed, daysRemaining);
                                                  return getHealthStatusColor(healthStatus);
                                                })()
                                              }}
                                            >
                                              <div className="roadmap-card-header">
                                                <span className="target-date">{formatDate(dateToCheck)}</span>
                                              </div>
                                            </div>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {unscheduledItems.length > 0 && (
        <div className="unscheduled-section">
          <h3>Unscheduled Items</h3>
          <div className="unscheduled-list">
            {unscheduledItems.map(item => (
              <div key={item.id} className="unscheduled-item">
                <span className="work-item-type-badge" data-type={item.workItemType.toLowerCase()}>
                  {item.workItemType}
                </span>
                <span className="work-item-title">{item.title}</span>
                {item.assignedTo && (
                  <span className="work-item-assignee">({item.assignedTo})</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export { RoadmapView };


