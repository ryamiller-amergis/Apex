import React from 'react';
import { WorkItem } from '../types/workitem';
import type { CalendarItemHealth } from '../../shared/types/standup';
import { WorkItemConfidenceBadge } from './CalendarDeliveryPulseBar';
import './WorkItemCard.css';

interface WorkItemCardProps {
  workItem: WorkItem;
  onClick: () => void;
  isDragging?: boolean;
  itemHealth?: CalendarItemHealth | null;
  'data-testid'?: string;
}

export const WorkItemCard: React.FC<WorkItemCardProps> = ({
  workItem,
  onClick,
  isDragging = false,
  itemHealth,
  'data-testid': testId,
}) => {
  const isEpic = workItem.workItemType === 'Epic';
  const isFeature = workItem.workItemType === 'Feature';
  const isBug = workItem.workItemType === 'Bug';
  const isPBI = workItem.workItemType === 'Product Backlog Item';
  const isTBI = workItem.workItemType === 'Technical Backlog Item';
  
  // Get subtle accent colors for different work item types
  const getTypeColor = () => {
    if (isEpic) return '#8b5cf6'; // Purple
    if (isFeature) return '#3b82f6'; // Blue
    if (isBug) return '#ef4444'; // Red
    if (isPBI) return '#10b981'; // Green
    if (isTBI) return '#f59e0b'; // Amber
    return '#6b7280'; // Gray
  };
  
  return (
    <div
      className={`work-item-card ${isDragging ? 'dragging' : ''} ${isEpic ? 'epic-card' : ''} ${isFeature ? 'feature-card' : ''}`}
      onClick={onClick}
      data-testid={testId ?? `work-item-card-${workItem.id}`}
      style={{
        opacity: isDragging ? 0.5 : 1,
        cursor: 'pointer',
        borderLeftColor: getTypeColor(),
      }}
    >
      <div className="work-item-header">
        <div className="work-item-id">
          {isEpic && <span className="type-icon">👑</span>}
          {isFeature && <span className="type-icon">⭐</span>}
          {isBug && <span className="type-icon">🐛</span>}
          {isPBI && <span className="type-icon">📋</span>}
          {isTBI && <span className="type-icon">🔧</span>}
          <span className="id-number">#{workItem.id}</span>
        </div>
        <div className="work-item-state" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <WorkItemConfidenceBadge
            health={itemHealth}
            data-testid={`work-item-confidence-${workItem.id}`}
          />
          <span>{workItem.state}</span>
        </div>
      </div>
      <div className="work-item-title">
        {workItem.title}
      </div>
      {workItem.assignedTo && (
        <div className="work-item-assigned">
          {workItem.assignedTo}
        </div>
      )}
      {(isEpic || isFeature || isBug) && workItem.targetDate && (
        <div className="work-item-target-date">
          Target: {workItem.targetDate}
        </div>
      )}
    </div>
  );
};
