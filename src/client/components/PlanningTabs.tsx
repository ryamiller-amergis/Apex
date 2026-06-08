import React from 'react';

export type PlanningTab = 'cycle-time' | 'dev-stats' | 'qa' | 'ai-analysis' | 'roadmap' | 'releases';

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
  // { id: 'cycle-time', label: 'Cycle Time', permission: 'planning:view' }, // Hidden — not currently in use
  { id: 'dev-stats',    label: 'Developer Stats', permission: 'planning:devstats'    },
  { id: 'qa',           label: 'QA Metrics',      permission: 'planning:qa'          },
  { id: 'ai-analysis',  label: 'AI Analysis',     permission: 'planning:ai-analysis' },
  { id: 'roadmap',      label: 'Roadmap',         permission: 'planning:roadmap'     },
  { id: 'releases',     label: 'Releases',        permission: 'planning:releases'    },
];

export const PlanningTabs: React.FC<PlanningTabsProps> = ({ activeTab, can, onNavigate }) => {
  const visibleTabs = TABS.filter((tab) => can(tab.permission));

  return (
    <div className="planning-tabs">
      {visibleTabs.map(({ id, label }) => (
        <button
          key={id}
          className={`tab-button ${activeTab === id ? 'active' : ''}`}
          onClick={() => onNavigate(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
};
