import React, { useState, useMemo } from 'react';
import { WorkItem } from '../types/workitem';
import { WorkItemCard } from './WorkItemCard';
import './UnscheduledList.css';

interface UnscheduledListProps {
  workItems: WorkItem[];
  allWorkItems: WorkItem[];
  onSelectItem: (item: WorkItem) => void;
  onUpdateDueDate: (id: number, dueDate: string | null) => void;
}

interface HierarchicalItem {
  item: WorkItem;
  children: HierarchicalItem[];
  level: number;
}

export const UnscheduledList: React.FC<UnscheduledListProps> = ({
  workItems,
  allWorkItems,
  onSelectItem,
  onUpdateDueDate,
}) => {
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [idSearch, setIdSearch] = useState<string>('');
  const [selectedIteration, setSelectedIteration] = useState<string>('');
  const [selectedWorkItemType, setSelectedWorkItemType] = useState<string>('');
  const [selectedAssignedTo, setSelectedAssignedTo] = useState<string>('');
  const [selectedStates, setSelectedStates] = useState<string[]>([]);
  const [isDropZone, setIsDropZone] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [showFilters, setShowFilters] = useState(false);
  const [width, setWidth] = useState<number>(() => {
    // Default to 40% of viewport width, clamped between 250px and 1000px
    const defaultWidth = window.innerWidth * 0.4;
    return Math.min(Math.max(defaultWidth, 250), 1000);
  });
  const [isResizing, setIsResizing] = useState(false);
  const [expandedItems, setExpandedItems] = useState<Set<number>>(new Set());

  // Get unique iteration values
  const iterationOptions = useMemo(() => {
    const unique = new Set<string>();
    workItems.forEach(item => {
      if (item.iterationPath) {
        unique.add(item.iterationPath);
      }
    });
    return Array.from(unique).sort();
  }, [workItems]);

  // Get unique work item types
  const workItemTypeOptions = useMemo(() => {
    const unique = new Set<string>();
    workItems.forEach(item => {
      if (item.workItemType) {
        unique.add(item.workItemType);
      }
    });
    // Ensure Bug is always available as an option
    unique.add('Bug');
    return Array.from(unique).sort();
  }, [workItems]);

  // Get unique assigned to values
  const assignedToOptions = useMemo(() => {
    const unique = new Set<string>();
    workItems.forEach(item => {
      if (item.assignedTo) {
        unique.add(item.assignedTo);
      }
    });
    return Array.from(unique).sort();
  }, [workItems]);

  // Get unique states
  const stateOptions = useMemo(() => {
    const unique = new Set<string>();
    workItems.forEach(item => {
      if (item.state) {
        unique.add(item.state);
      }
    });
    return Array.from(unique).sort();
  }, [workItems]);

  const idSearchResults = useMemo(() => {
    const trimmed = idSearch.trim();
    if (!trimmed) return [];
    return allWorkItems.filter(item => item.id.toString().includes(trimmed));
  }, [allWorkItems, idSearch]);

  const filteredItems = useMemo(() => {
    let items = workItems;
    
    // Filter by iteration
    if (selectedIteration) {
      items = items.filter(item => item.iterationPath === selectedIteration);
    }

    // Filter by work item type
    if (selectedWorkItemType) {
      items = items.filter(item => item.workItemType === selectedWorkItemType);
    }

    // Filter by assigned to
    if (selectedAssignedTo) {
      items = items.filter(item => item.assignedTo === selectedAssignedTo);
    }

    // Filter by state
    if (selectedStates.length > 0) {
      items = items.filter(item => selectedStates.includes(item.state));
    }
    
    return items;
  }, [workItems, selectedIteration, selectedWorkItemType, selectedAssignedTo, selectedStates]);

  // When a text search is active, search across ALL work items (scheduled + unscheduled)
  const searchResults = useMemo(() => {
    if (!searchTerm.trim()) return null;
    const lower = searchTerm.toLowerCase();
    return allWorkItems.filter(item =>
      item.title.toLowerCase().includes(lower) ||
      item.id.toString().includes(lower) ||
      (item.assignedTo && item.assignedTo.toLowerCase().includes(lower))
    );
  }, [allWorkItems, searchTerm]);

  // Build hierarchical structure
  const hierarchicalItems = useMemo(() => {
    const itemMap = new Map<number, HierarchicalItem>();
    const rootItems: HierarchicalItem[] = [];

    // First pass: create hierarchical item objects
    filteredItems.forEach(item => {
      itemMap.set(item.id, {
        item,
        children: [],
        level: 0,
      });
    });

    // Second pass: build parent-child relationships
    filteredItems.forEach(item => {
      const hierarchicalItem = itemMap.get(item.id)!;
      
      if (item.parentId && itemMap.has(item.parentId)) {
        // This item has a parent in the filtered list
        const parent = itemMap.get(item.parentId)!;
        parent.children.push(hierarchicalItem);
        hierarchicalItem.level = parent.level + 1;
      } else {
        // This is a root item (no parent or parent not in filtered list)
        // If "All Types" is selected, only show Epics at root
        if (!selectedWorkItemType) {
          // All Types mode - only show Epics at the root
          if (item.workItemType === 'Epic') {
            rootItems.push(hierarchicalItem);
          }
        } else {
          // Specific type selected - show all items of that type at root if parent not in filtered list
          rootItems.push(hierarchicalItem);
        }
      }
    });

    // Sort root items and children by work item type priority then by ID
    const typePriority: { [key: string]: number } = {
      'Epic': 1,
      'Feature': 2,
      'Product Backlog Item': 3,
      'Technical Backlog Item': 4,
      'Bug': 5,
    };

    const sortItems = (items: HierarchicalItem[]) => {
      items.sort((a, b) => {
        const aPriority = typePriority[a.item.workItemType] || 99;
        const bPriority = typePriority[b.item.workItemType] || 99;
        if (aPriority !== bPriority) {
          return aPriority - bPriority;
        }
        return a.item.id - b.item.id;
      });
      items.forEach(item => sortItems(item.children));
    };

    sortItems(rootItems);

    return rootItems;
  }, [filteredItems, selectedWorkItemType]);

  const toggleExpanded = (itemId: number) => {
    setExpandedItems(prev => {
      const newSet = new Set(prev);
      if (newSet.has(itemId)) {
        newSet.delete(itemId);
      } else {
        newSet.add(itemId);
      }
      return newSet;
    });
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setIsDropZone(true);
  };

  const handleDragLeave = () => {
    setIsDropZone(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDropZone(false);
    
    const draggedItem = (window as any).__DRAGGED_CALENDAR_ITEM__;
    if (draggedItem) {
      console.log('Removing due date from item:', draggedItem.id);
      onUpdateDueDate(draggedItem.id, null);
      (window as any).__DRAGGED_CALENDAR_ITEM__ = null;
    }
  };

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  };

  React.useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = e.clientX;
      // Constrain width between 200px and 1000px
      if (newWidth >= 200 && newWidth <= 1000) {
        setWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  return (
    <div 
      data-testid="unscheduled-list"
      className={`unscheduled-list ${isDropZone ? 'drop-zone-active' : ''} ${isCollapsed ? 'collapsed' : ''}`}
      style={{ width: isCollapsed ? '40px' : `${width}px` }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <button 
        className="collapse-toggle"
        onClick={() => setIsCollapsed(!isCollapsed)}
        title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {isCollapsed ? '▶' : '◀'}
      </button>
      {!isCollapsed && (
        <div
          className="resize-handle"
          onMouseDown={handleResizeStart}
          title="Drag to resize"
        >
          <div className="resize-handle-line" />
        </div>
      )}
      
      {!isCollapsed && (
        <>
          <h3>Work Items</h3>
          <input
            type="text"
            placeholder="Search items..."
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value);
              onSelectItem(null as any); // Close details panel
            }}
            className="search-input"
          />
          <button 
            className="filters-toggle"
            onClick={() => setShowFilters(!showFilters)}
          >
            {showFilters ? '▲' : '▼'} Filters
          </button>
          {showFilters && (
            <>
          <div className="filter-row">
            <select
              value={selectedWorkItemType}
              onChange={(e) => setSelectedWorkItemType(e.target.value)}
              className="filter-select"
            >
              <option value="">All Types</option>
              {workItemTypeOptions.map(type => (
                <option key={type} value={type}>
                  {type === 'Product Backlog Item' ? '📋 PBI' : 
                   type === 'Technical Backlog Item' ? '🔧 TBI' : 
                   type === 'Epic' ? '👑 Epic' :
                   type === 'Feature' ? '⭐ Feature' :
                   type === 'Bug' ? '🐛 Bug' :
                   type}
                </option>
              ))}
            </select>
            <select
              value={selectedAssignedTo}
              onChange={(e) => setSelectedAssignedTo(e.target.value)}
              className="filter-select"
            >
              <option value="">Assigned To</option>
              {assignedToOptions.map(person => (
                <option key={person} value={person}>{person}</option>
              ))}
            </select>
          </div>
          <div className="state-filter-container">
            <div className="state-filter-header">States:</div>
            <div className="state-checkboxes">
              {stateOptions.map(state => (
                <label key={state} className="state-checkbox-label">
                  <input
                    type="checkbox"
                    checked={selectedStates.includes(state)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedStates([...selectedStates, state]);
                      } else {
                        setSelectedStates(selectedStates.filter(s => s !== state));
                      }
                    }}
                    className="state-checkbox"
                  />
                  <span>{state}</span>
                </label>
              ))}
            </div>
          </div>
          <select
            value={selectedIteration}
            onChange={(e) => setSelectedIteration(e.target.value)}
            className="iteration-select"
          >
            <option value="">All Iterations</option>
            {iterationOptions.map(iteration => (
              <option key={iteration} value={iteration}>{iteration}</option>
            ))}
          </select>
          {(selectedWorkItemType || selectedAssignedTo || selectedStates.length > 0 || selectedIteration) && (
            <button 
              className="clear-filters-btn"
              onClick={() => {
                setSelectedWorkItemType('');
                setSelectedAssignedTo('');
                setSelectedStates([]);
                setSelectedIteration('');
              }}
            >
              Clear Filters
            </button>
          )}
            </>
          )}

          <div className="id-search-section">
            <div className="id-search-divider">
              <span>Find by ID</span>
            </div>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="Enter work item ID..."
              value={idSearch}
              onChange={(e) => {
                setIdSearch(e.target.value);
                onSelectItem(null as any);
              }}
              className="id-search-input"
            />
            {idSearch.trim() && (
              <div className="id-search-meta">
                {idSearchResults.length === 0
                  ? 'No items found'
                  : `${idSearchResults.length} item${idSearchResults.length !== 1 ? 's' : ''} found`}
                <button
                  className="id-search-clear"
                  onClick={() => setIdSearch('')}
                  title="Clear ID search"
                >
                  ✕
                </button>
              </div>
            )}
          </div>

          <div className="unscheduled-items">
            {idSearch.trim() ? (
              idSearchResults.length === 0 ? (
                <div className="empty-state">No items match ID "{idSearch.trim()}"</div>
              ) : (
                idSearchResults.map(item => (
                  <div key={item.id} className="item-wrapper no-children">
                    <DraggableWorkItem
                      workItem={item}
                      onClick={() => onSelectItem(item)}
                      scheduledDate={item.dueDate || item.targetDate}
                    />
                  </div>
                ))
              )
            ) : searchResults !== null ? (
              searchResults.length === 0 ? (
                <div className="empty-state">No items match your search</div>
              ) : (
                searchResults.map(item => (
                  <div key={item.id} className="item-wrapper no-children">
                    <DraggableWorkItem
                      workItem={item}
                      onClick={() => onSelectItem(item)}
                      scheduledDate={item.dueDate || item.targetDate}
                    />
                  </div>
                ))
              )
            ) : hierarchicalItems.length === 0 ? (
              <div className="empty-state">
                No unscheduled items
              </div>
            ) : (
              <HierarchicalItemList
                items={hierarchicalItems}
                expandedItems={expandedItems}
                onToggleExpanded={toggleExpanded}
                onSelectItem={onSelectItem}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
};

interface HierarchicalItemListProps {
  items: HierarchicalItem[];
  expandedItems: Set<number>;
  onToggleExpanded: (itemId: number) => void;
  onSelectItem: (item: WorkItem) => void;
}

const HierarchicalItemList: React.FC<HierarchicalItemListProps> = ({
  items,
  expandedItems,
  onToggleExpanded,
  onSelectItem,
}) => {
  const renderItem = (hierarchicalItem: HierarchicalItem): React.ReactNode => {
    const { item, children, level } = hierarchicalItem;
    const hasChildren = children.length > 0;
    const isExpanded = expandedItems.has(item.id);

    return (
      <div key={item.id} className="hierarchical-item-container">
        <div 
          className="hierarchical-item" 
          style={{ paddingLeft: `${level * 20}px` }}
        >
          {hasChildren && (
            <button
              className="expand-toggle"
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpanded(item.id);
              }}
            >
              {isExpanded ? '▼' : '▶'}
            </button>
          )}
          <div className={`item-wrapper ${!hasChildren ? 'no-children' : ''}`}>
            <DraggableWorkItem
              workItem={item}
              onClick={() => onSelectItem(item)}
            />
          </div>
        </div>
        {hasChildren && isExpanded && (
          <div className="children-container">
            {children.map(renderItem)}
          </div>
        )}
      </div>
    );
  };

  return <>{items.map(renderItem)}</>;
};

interface DraggableWorkItemProps {
  workItem: WorkItem;
  onClick: () => void;
  scheduledDate?: string;
}

const DraggableWorkItem: React.FC<DraggableWorkItemProps> = ({
  workItem,
  onClick,
  scheduledDate,
}) => {
  const [isDragging, setIsDragging] = useState(false);

  const handleDragStart = (e: React.DragEvent) => {
    setIsDragging(true);
    // Set global reference for calendar to pick up
    (window as any).__DRAGGED_WORK_ITEM__ = workItem;
    // Required for Firefox
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', JSON.stringify(workItem));
  };

  const handleDragEnd = () => {
    setIsDragging(false);
  };

  return (
    <div
      draggable="true"
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <WorkItemCard
        workItem={workItem}
        onClick={onClick}
        isDragging={isDragging}
      />
      {scheduledDate && (
        <div className="scheduled-badge">
          Scheduled: {scheduledDate}
        </div>
      )}
    </div>
  );
};
