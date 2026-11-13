import React from 'react';

export type PlanningTab = 'roadmap' | 'releases';

interface PlanningTabDef {
  id: PlanningTab;
  label: string;
  permission: string;
}

interface PlanningTabsProps {
  activeTab: PlanningTab;
  can: (key: string) => boolean;
  onNavigate: (tab: PlanningTab) => void;
}

const TABS: PlanningTabDef[] = [
  { id: 'roadmap',  label: 'Roadmap',  permission: 'planning:roadmap'  },
  { id: 'releases', label: 'Releases', permission: 'planning:releases' },
];

export const PlanningTabs: React.FC<PlanningTabsProps> = ({ activeTab, can, onNavigate }) => {
  const visibleTabs = TABS.filter((tab) => can(tab.permission));

  return (
    <div className="planning-tabs" data-testid="planning-tabs">
      {visibleTabs.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          data-testid={`planning-tab-${id}`}
          className={`tab-button ${activeTab === id ? 'active' : ''}`}
          onClick={() => onNavigate(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
};
