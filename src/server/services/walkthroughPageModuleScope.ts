import {
  CONFIGURABLE_MENU_ITEMS,
  type MenuItemKey,
} from '../../shared/types/menuSettings';

export const APEX_WALKTHROUGH_PROJECT = 'Apex';

export interface WalkthroughPageEntryContext {
  component: string;
  routePattern: string;
  suggestedRoute: string;
}

export interface WalkthroughPageModuleContext {
  key: string;
  label: string;
  availability: 'platform-admin-configured' | 'fixed';
  pageEntries: readonly WalkthroughPageEntryContext[];
}

type WalkthroughPageModuleDefinition = Pick<
  WalkthroughPageModuleContext,
  'pageEntries'
>;

const PAGE_MODULE_BY_MENU_KEY: Record<
  MenuItemKey,
  WalkthroughPageModuleDefinition
> = {
  calendar: {
    pageEntries: [
      {
        component: 'src/client/components/ScrumCalendar.tsx',
        routePattern: '/calendar',
        suggestedRoute: '/calendar',
      },
      {
        component: 'src/client/components/UnscheduledList.tsx',
        routePattern: '/calendar',
        suggestedRoute: '/calendar',
      },
      {
        component: 'src/client/components/DetailsPanel.tsx',
        routePattern: '/calendar',
        suggestedRoute: '/calendar',
      },
    ],
  },
  planning: {
    pageEntries: [
      {
        component: 'src/client/components/DevStats.tsx',
        routePattern: '/planning/dev-stats',
        suggestedRoute: '/planning/dev-stats',
      },
      {
        component: 'src/client/components/QAMetrics.tsx',
        routePattern: '/planning/qa',
        suggestedRoute: '/planning/qa',
      },
      {
        component: 'src/client/components/AIAnalysis.tsx',
        routePattern: '/planning/ai-analysis',
        suggestedRoute: '/planning/ai-analysis',
      },
      {
        component: 'src/client/components/RoadmapView.tsx',
        routePattern: '/planning/roadmap',
        suggestedRoute: '/planning/roadmap',
      },
      {
        component: 'src/client/components/ReleaseView.tsx',
        routePattern: '/planning/releases',
        suggestedRoute: '/planning/releases',
      },
    ],
  },
  cloudcost: {
    pageEntries: [
      {
        component: 'src/client/components/CloudCost.tsx',
        routePattern: '/cloud-cost',
        suggestedRoute: '/cloud-cost',
      },
    ],
  },
  backlog: {
    pageEntries: [
      {
        component: 'src/client/components/InterviewsDashboard.tsx',
        routePattern: '/backlog',
        suggestedRoute: '/backlog',
      },
      {
        component: 'src/client/components/InterviewChatView.tsx',
        routePattern: '/backlog/interview/:interviewId',
        suggestedRoute: '/backlog?tab=interviews',
      },
      {
        component: 'src/client/components/PrdReviewView.tsx',
        routePattern: '/backlog/prd/:prdId',
        suggestedRoute: '/backlog?tab=prds',
      },
      {
        component: 'src/client/components/DesignPlanReviewView.tsx',
        routePattern: '/backlog/design-plan/:prdId',
        suggestedRoute: '/backlog?tab=prds',
      },
      {
        component: 'src/client/components/DesignPrototypeReviewView.tsx',
        routePattern: '/backlog/design-prototypes/:prdId',
        suggestedRoute: '/backlog?tab=design-prototypes',
      },
      {
        component: 'src/client/components/DesignDocReviewView.tsx',
        routePattern: '/backlog/design-doc/:designDocId',
        suggestedRoute: '/backlog?tab=design-docs',
      },
    ],
  },
  adr: {
    pageEntries: [
      {
        component: 'src/client/components/AdrsDashboard.tsx',
        routePattern: '/adr',
        suggestedRoute: '/adr',
      },
      {
        component: 'src/client/components/AdrChatView.tsx',
        routePattern: '/adr/:adrId',
        suggestedRoute: '/adr',
      },
    ],
  },
  'my-work': {
    pageEntries: [
      {
        component: 'src/client/components/DevWorkbenchView.tsx',
        routePattern: '/my-work',
        suggestedRoute: '/my-work',
      },
      {
        component: 'src/client/components/DevSessionView.tsx',
        routePattern: '/my-work/session/:sessionId',
        suggestedRoute: '/my-work',
      },
    ],
  },
  standup: {
    pageEntries: [
      {
        component: 'src/client/components/StandupCeremonyView.tsx',
        routePattern: '/standup',
        suggestedRoute: '/standup',
      },
      {
        component: 'src/client/components/StandupManageView.tsx',
        routePattern: '/standup-manage',
        suggestedRoute: '/standup-manage',
      },
      {
        component: 'src/client/components/StandupSummaryView.tsx',
        routePattern: '/standup-summary',
        suggestedRoute: '/standup-summary',
      },
    ],
  },
  'ui-lab': {
    pageEntries: [
      {
        component: 'src/client/components/UiLabView.tsx',
        routePattern: '/ui-lab',
        suggestedRoute: '/ui-lab',
      },
    ],
  },
  'feature-requests': {
    pageEntries: [
      {
        component: 'src/client/components/FeatureRequestsView.tsx',
        routePattern: '/feature-requests',
        suggestedRoute: '/feature-requests',
      },
    ],
  },
  'pdf-tools': {
    pageEntries: [
      {
        component: 'src/client/components/PdfAssemblyView.tsx',
        routePattern: '/pdf-tools',
        suggestedRoute: '/pdf-tools',
      },
    ],
  },
  'ai-cost': {
    pageEntries: [
      {
        component: 'src/client/components/AiCostAnalytics.tsx',
        routePattern: '/ai-cost',
        suggestedRoute: '/ai-cost',
      },
    ],
  },
  'design-module': {
    pageEntries: [
      {
        component: 'src/client/components/DesignModuleView.tsx',
        routePattern: '/design-module',
        suggestedRoute: '/design-module',
      },
    ],
  },
  'load-tests': {
    pageEntries: [
      {
        component: 'src/client/components/LoadTestsListPage.tsx',
        routePattern: '/load-tests',
        suggestedRoute: '/load-tests',
      },
      {
        component: 'src/client/components/LoadTestDefinitionBuilderView.tsx',
        routePattern: '/load-tests/:definitionId',
        suggestedRoute: '/load-tests',
      },
      {
        component: 'src/client/components/LoadTestRunDetailView.tsx',
        routePattern: '/load-tests/runs/:runId',
        suggestedRoute: '/load-tests',
      },
    ],
  },
  diagrams: {
    pageEntries: [
      {
        component: 'src/client/components/DiagramsPlaceholder.tsx',
        routePattern: '/diagrams',
        suggestedRoute: '/diagrams',
      },
    ],
  },
  'work-board': {
    pageEntries: [
      {
        component: 'src/client/components/ApexWorkBoardView.tsx',
        routePattern: '/work-board',
        suggestedRoute: '/work-board',
      },
    ],
  },
};

const FIXED_PAGE_MODULES: readonly WalkthroughPageModuleContext[] = [
  {
    key: 'home',
    label: 'Home',
    availability: 'fixed',
    pageEntries: [
      {
        component: 'src/client/components/AgentHome.tsx',
        routePattern: '/home',
        suggestedRoute: '/home',
      },
      {
        component: 'src/client/components/AppHeader.tsx',
        routePattern: '/home',
        suggestedRoute: '/home',
      },
      {
        component: 'src/client/components/AppSidebar.tsx',
        routePattern: '/home',
        suggestedRoute: '/home',
      },
      {
        component: 'src/client/components/Changelog.tsx',
        routePattern: '/home',
        suggestedRoute: '/home',
      },
    ],
  },
  {
    key: 'admin',
    label: 'Project administration',
    availability: 'fixed',
    pageEntries: [
      {
        component: 'src/client/components/AdminRoles.tsx',
        routePattern: '/admin/roles',
        suggestedRoute: '/admin/roles',
      },
      {
        component: 'src/client/components/AdminUsers.tsx',
        routePattern: '/admin/users',
        suggestedRoute: '/admin/users',
      },
      {
        component: 'src/client/components/AdminGroups.tsx',
        routePattern: '/admin/groups',
        suggestedRoute: '/admin/groups',
      },
      {
        component: 'src/client/components/AdminProjectSettings.tsx',
        routePattern: '/admin/project-settings',
        suggestedRoute: '/admin/project-settings',
      },
      {
        component: 'src/client/components/AdminNotifications.tsx',
        routePattern: '/admin/notifications',
        suggestedRoute: '/admin/notifications',
      },
      {
        component: 'src/client/components/LoadTestAllowlistSettings.tsx',
        routePattern: '/admin/load-test-targets',
        suggestedRoute: '/admin/load-test-targets',
      },
    ],
  },
  {
    key: 'profile',
    label: 'Profile',
    availability: 'fixed',
    pageEntries: [
      {
        component: 'src/client/components/ProfilePage.tsx',
        routePattern: '/profile',
        suggestedRoute: '/profile',
      },
    ],
  },
];

export async function listApplicableWalkthroughPageModules(): Promise<
  WalkthroughPageModuleContext[]
> {
  const configuredModules = CONFIGURABLE_MENU_ITEMS.map(
    (item): WalkthroughPageModuleContext => ({
      key: item.key,
      label: item.label,
      availability: 'platform-admin-configured',
      ...PAGE_MODULE_BY_MENU_KEY[item.key],
    })
  );

  return [...configuredModules, ...FIXED_PAGE_MODULES];
}

export function listWalkthroughPageEntryComponents(
  modules: readonly WalkthroughPageModuleContext[]
): string[] {
  return [
    ...new Set(
      modules.flatMap((module) =>
        module.pageEntries.map((entry) => entry.component)
      )
    ),
  ];
}
