import { WorkItem, DeveloperDueDateStats, DueDateHitRateStats, PullRequestTimeStats, QABugStats, InProgressTimeStats, DesignDocKickoffStats, PullRequestFeedbackStats, PrResolutionMetricsStats, EslintBurnDownGranularity, EslintBurnDownPoint, EslintBurnDownResponse, EslintBuildSnapshot } from '../types/workitem';
import './DevStats.css';
import { AiCapabilityLadderSection } from './AiCapabilityLadderSection';
import { useState, useMemo, useEffect } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';

/** First 10 chars YYYY-MM-DD from commit / review date strings */
function parseStatDay(s: string): Date | null {
  const base = typeof s === 'string' && s.length >= 10 ? s.slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(base)) return null;
  const [y, m, d] = base.split('-').map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}

/** Monday-start week bucket id (YYYY-MM-DD of that Monday) */
function weekStartMondayKey(d: Date): string {
  const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = copy.getDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  copy.setDate(copy.getDate() + diff);
  const ys = copy.getFullYear();
  const ms = String(copy.getMonth() + 1).padStart(2, '0');
  const ds = String(copy.getDate()).padStart(2, '0');
  return `${ys}-${ms}-${ds}`;
}

function formatWeekLabel(weekMonday: string): string {
  const parts = weekMonday.split('-').map(Number);
  const y = parts[0]!;
  const m = parts[1]!;
  const d = parts[2]!;
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function monthKey(d: Date): string {
  const ys = d.getFullYear();
  const ms = String(d.getMonth() + 1).padStart(2, '0');
  return `${ys}-${ms}`;
}

function formatMonthLabel(monthKeyValue: string): string {
  const [y, m] = monthKeyValue.split('-').map(Number) as [number, number];
  const dt = new Date(y, m - 1, 1);
  return dt.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function quarterKey(d: Date): string {
  const quarter = Math.floor(d.getMonth() / 3) + 1;
  return `${d.getFullYear()}-Q${quarter}`;
}

function formatQuarterLabel(quarterKeyValue: string): string {
  const [yearPart, quarterPart] = quarterKeyValue.split('-Q');
  return `Q${quarterPart} ${yearPart}`;
}

function periodKeyForSnapshot(snapshot: EslintBuildSnapshot, granularity: EslintBurnDownGranularity): string | null {
  const day = parseStatDay(snapshot.capturedAt);
  if (!day) return null;
  if (granularity === 'weekly') return weekStartMondayKey(day);
  if (granularity === 'monthly') return monthKey(day);
  return quarterKey(day);
}

function formatEslintPeriodLabel(periodKey: string, granularity: EslintBurnDownGranularity): string {
  if (granularity === 'weekly') return formatWeekLabel(periodKey);
  if (granularity === 'monthly') return formatMonthLabel(periodKey);
  return formatQuarterLabel(periodKey);
}

function aggregateEslintBurnDown(
  snapshots: EslintBuildSnapshot[],
  granularity: EslintBurnDownGranularity,
): EslintBurnDownPoint[] {
  const bucket = new Map<string, EslintBurnDownPoint>();

  for (const snapshot of snapshots) {
    const periodKey = periodKeyForSnapshot(snapshot, granularity);
    if (!periodKey) continue;

    const existing = bucket.get(periodKey);
    if (!existing || snapshot.capturedAt.localeCompare(existing.capturedAt) >= 0) {
      bucket.set(periodKey, {
        periodKey,
        periodLabel: formatEslintPeriodLabel(periodKey, granularity),
        capturedAt: snapshot.capturedAt,
        buildId: snapshot.buildId,
        buildNumber: snapshot.buildNumber,
        totalErrors: snapshot.totalErrors,
        totalWarnings: snapshot.totalWarnings,
        issueCount: snapshot.issueCount,
        filesWithProblems: snapshot.filesWithProblems,
        fixableCount: snapshot.fixableCount,
      });
    }
  }

  return Array.from(bucket.values()).sort((a, b) => a.periodKey.localeCompare(b.periodKey));
}

interface DevStatsProps {
  workItems: WorkItem[];
  project: string;
  areaPath: string;
  onSelectItem?: (item: WorkItem) => void;
}

const LOADING_STATE_KEY = 'devStatsLoadingState';
const DATA_STATE_KEY = 'devStatsData';
const FILTER_STATE_KEY = 'devStatsFilters';
const HIT_RATE_DATA_KEY = 'devStatsHitRateData';
const HIT_RATE_LOADING_STATE_KEY = 'devStatsHitRateLoadingState';
const PR_TIME_DATA_KEY = 'devStatsPRTimeData';
const PR_TIME_LOADING_STATE_KEY = 'devStatsPRTimeLoadingState';
const QA_BUG_DATA_KEY = 'devStatsQABugData';
const QA_BUG_LOADING_STATE_KEY = 'devStatsQABugLoadingState';
const IN_PROGRESS_DATA_KEY = 'devStatsInProgressData';
const IN_PROGRESS_LOADING_STATE_KEY = 'devStatsInProgressLoadingState';
const KICKOFF_DATA_KEY = 'devStatsKickoffData';
const KICKOFF_LOADING_STATE_KEY = 'devStatsKickoffLoadingState';
const PR_FEEDBACK_DATA_KEY = 'devStatsPRFeedbackData';
const PR_FEEDBACK_LOADING_STATE_KEY = 'devStatsPRFeedbackLoadingState';
const PR_RESOLUTION_DATA_KEY = 'devStatsPrResolutionData';
const PR_RESOLUTION_LOADING_STATE_KEY = 'devStatsPrResolutionLoadingState';
const ESLINT_DATA_KEY = 'devStatsEslintData';
const ESLINT_LOADING_STATE_KEY = 'devStatsEslintLoadingState';
const SESSION_INITIALIZED_KEY = 'devStatsSessionInitialized';

// Check for page refresh once - this runs before component render
const checkAndClearOnRefresh = () => {
  // If session was already initialized, this is a tab switch, not a page refresh
  const wasInitialized = sessionStorage.getItem(SESSION_INITIALIZED_KEY);
  
  if (!wasInitialized) {
    // First load or actual page refresh - clear everything
    console.log('DevStats - Page refresh/first load detected, clearing sessionStorage');
    sessionStorage.removeItem(DATA_STATE_KEY);
    sessionStorage.removeItem(LOADING_STATE_KEY);
    sessionStorage.removeItem(FILTER_STATE_KEY);
    sessionStorage.removeItem(HIT_RATE_DATA_KEY);
    sessionStorage.removeItem(HIT_RATE_LOADING_STATE_KEY);
    sessionStorage.removeItem(PR_TIME_DATA_KEY);
    sessionStorage.removeItem(PR_TIME_LOADING_STATE_KEY);
    sessionStorage.removeItem(IN_PROGRESS_DATA_KEY);
    sessionStorage.removeItem(IN_PROGRESS_LOADING_STATE_KEY);
    sessionStorage.removeItem(KICKOFF_DATA_KEY);
    sessionStorage.removeItem(KICKOFF_LOADING_STATE_KEY);
    sessionStorage.removeItem(PR_FEEDBACK_DATA_KEY);
    sessionStorage.removeItem(PR_FEEDBACK_LOADING_STATE_KEY);
    sessionStorage.removeItem(PR_RESOLUTION_DATA_KEY);
    sessionStorage.removeItem(PR_RESOLUTION_LOADING_STATE_KEY);
    sessionStorage.removeItem(ESLINT_DATA_KEY);
    sessionStorage.removeItem(ESLINT_LOADING_STATE_KEY);
    sessionStorage.setItem(SESSION_INITIALIZED_KEY, 'true');
    return true;
  }
  
  console.log('DevStats - Tab navigation detected, restoring from sessionStorage');
  return false;
};

export const DevStats: React.FC<DevStatsProps> = ({ workItems, onSelectItem }) => {
  const [isPageRefresh] = useState(() => checkAndClearOnRefresh());

  // Restore data from sessionStorage on mount
  const [dueDateStats, setDueDateStats] = useState<DeveloperDueDateStats[]>(() => {
    if (isPageRefresh) return [];
    const savedData = sessionStorage.getItem(DATA_STATE_KEY);
    return savedData ? JSON.parse(savedData).stats : [];
  });
  const [loading, setLoading] = useState(() => {
    if (isPageRefresh) return false;
    const savedLoading = sessionStorage.getItem(LOADING_STATE_KEY);
    return savedLoading ? JSON.parse(savedLoading).loading : false;
  });
  const [error, setError] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(() => {
    if (isPageRefresh) return false;
    const savedData = sessionStorage.getItem(DATA_STATE_KEY);
    return savedData ? JSON.parse(savedData).hasLoaded : false;
  });
  const [showNotification, setShowNotification] = useState(() => {
    if (isPageRefresh) return false;
    const savedLoading = sessionStorage.getItem(LOADING_STATE_KEY);
    return savedLoading ? JSON.parse(savedLoading).loading : false;
  });
  const [notificationMessage, setNotificationMessage] = useState(() => {
    if (isPageRefresh) return '';
    const savedLoading = sessionStorage.getItem(LOADING_STATE_KEY);
    return savedLoading ? 'Loading statistics in background...' : '';
  });
  
  // Due date hit rate state
  const [hitRateStats, setHitRateStats] = useState<DueDateHitRateStats[]>(() => {
    if (isPageRefresh) return [];
    const savedData = sessionStorage.getItem(HIT_RATE_DATA_KEY);
    return savedData ? JSON.parse(savedData).stats : [];
  });
  const [hitRateLoading, setHitRateLoading] = useState(() => {
    if (isPageRefresh) return false;
    const savedLoading = sessionStorage.getItem(HIT_RATE_LOADING_STATE_KEY);
    return savedLoading ? JSON.parse(savedLoading).loading : false;
  });
  const [hitRateHasLoaded, setHitRateHasLoaded] = useState(() => {
    if (isPageRefresh) return false;
    const savedData = sessionStorage.getItem(HIT_RATE_DATA_KEY);
    return savedData ? JSON.parse(savedData).hasLoaded : false;
  });
  const [hitRateError, setHitRateError] = useState<string | null>(null);
  const [showHitRateNotification, setShowHitRateNotification] = useState(() => {
    if (isPageRefresh) return false;
    const savedLoading = sessionStorage.getItem(HIT_RATE_LOADING_STATE_KEY);
    return savedLoading ? JSON.parse(savedLoading).loading : false;
  });
  const [hitRateNotificationMessage, setHitRateNotificationMessage] = useState(() => {
    if (isPageRefresh) return '';
    const savedLoading = sessionStorage.getItem(HIT_RATE_LOADING_STATE_KEY);
    return savedLoading ? 'Loading hit rate data in background...' : '';
  });
  
  // Pull Request time stats state
  const [prTimeStats, setPrTimeStats] = useState<PullRequestTimeStats[]>(() => {
    if (isPageRefresh) return [];
    const savedData = sessionStorage.getItem(PR_TIME_DATA_KEY);
    return savedData ? JSON.parse(savedData).stats : [];
  });
  const [prTimeLoading, setPrTimeLoading] = useState(() => {
    if (isPageRefresh) return false;
    const savedLoading = sessionStorage.getItem(PR_TIME_LOADING_STATE_KEY);
    return savedLoading ? JSON.parse(savedLoading).loading : false;
  });
  const [prTimeHasLoaded, setPrTimeHasLoaded] = useState(() => {
    if (isPageRefresh) return false;
    const savedData = sessionStorage.getItem(PR_TIME_DATA_KEY);
    return savedData ? JSON.parse(savedData).hasLoaded : false;
  });
  const [prTimeError, setPrTimeError] = useState<string | null>(null);
  const [showPrTimeNotification, setShowPrTimeNotification] = useState(() => {
    if (isPageRefresh) return false;
    const savedLoading = sessionStorage.getItem(PR_TIME_LOADING_STATE_KEY);
    return savedLoading ? JSON.parse(savedLoading).loading : false;
  });
  const [prTimeNotificationMessage, setPrTimeNotificationMessage] = useState(() => {
    if (isPageRefresh) return '';
    const savedLoading = sessionStorage.getItem(PR_TIME_LOADING_STATE_KEY);
    return savedLoading ? 'Loading pull request time stats in background...' : '';
  });
  
  // QA Bug stats state
  const [qaBugStats, setQaBugStats] = useState<QABugStats[]>(() => {
    if (isPageRefresh) return [];
    const savedData = sessionStorage.getItem(QA_BUG_DATA_KEY);
    return savedData ? JSON.parse(savedData).stats : [];
  });
  const [qaBugLoading, setQaBugLoading] = useState(() => {
    if (isPageRefresh) return false;
    const savedLoading = sessionStorage.getItem(QA_BUG_LOADING_STATE_KEY);
    return savedLoading ? JSON.parse(savedLoading).loading : false;
  });
  const [qaBugHasLoaded, setQaBugHasLoaded] = useState(() => {
    if (isPageRefresh) return false;
    const savedData = sessionStorage.getItem(QA_BUG_DATA_KEY);
    return savedData ? JSON.parse(savedData).hasLoaded : false;
  });
  const [qaBugError, setQaBugError] = useState<string | null>(null);
  const [showQaBugNotification, setShowQaBugNotification] = useState(() => {
    if (isPageRefresh) return false;
    const savedLoading = sessionStorage.getItem(QA_BUG_LOADING_STATE_KEY);
    return savedLoading ? JSON.parse(savedLoading).loading : false;
  });
  const [qaBugNotificationMessage, setQaBugNotificationMessage] = useState(() => {
    if (isPageRefresh) return '';
    const savedLoading = sessionStorage.getItem(QA_BUG_LOADING_STATE_KEY);
    return savedLoading ? 'Loading QA bug stats in background...' : '';
  });

  // In Progress time stats state
  const [inProgressStats, setInProgressStats] = useState<InProgressTimeStats[]>(() => {
    if (isPageRefresh) return [];
    const savedData = sessionStorage.getItem(IN_PROGRESS_DATA_KEY);
    return savedData ? JSON.parse(savedData).stats : [];
  });
  const [inProgressLoading, setInProgressLoading] = useState(() => {
    if (isPageRefresh) return false;
    const savedLoading = sessionStorage.getItem(IN_PROGRESS_LOADING_STATE_KEY);
    return savedLoading ? JSON.parse(savedLoading).loading : false;
  });
  const [inProgressHasLoaded, setInProgressHasLoaded] = useState(() => {
    if (isPageRefresh) return false;
    const savedData = sessionStorage.getItem(IN_PROGRESS_DATA_KEY);
    return savedData ? JSON.parse(savedData).hasLoaded : false;
  });
  const [inProgressError, setInProgressError] = useState<string | null>(null);
  const [showInProgressNotification, setShowInProgressNotification] = useState(() => {
    if (isPageRefresh) return false;
    const savedLoading = sessionStorage.getItem(IN_PROGRESS_LOADING_STATE_KEY);
    return savedLoading ? JSON.parse(savedLoading).loading : false;
  });
  const [inProgressNotificationMessage, setInProgressNotificationMessage] = useState(() => {
    if (isPageRefresh) return '';
    const savedLoading = sessionStorage.getItem(IN_PROGRESS_LOADING_STATE_KEY);
    return savedLoading ? 'Loading in-progress stats in background...' : '';
  });
  
  // Design Doc Kickoff stats state
  const [kickoffStats, setKickoffStats] = useState<DesignDocKickoffStats[]>(() => {
    if (isPageRefresh) return [];
    const savedData = sessionStorage.getItem(KICKOFF_DATA_KEY);
    return savedData ? JSON.parse(savedData).stats : [];
  });
  const [kickoffLoading, setKickoffLoading] = useState(() => {
    if (isPageRefresh) return false;
    const savedLoading = sessionStorage.getItem(KICKOFF_LOADING_STATE_KEY);
    return savedLoading ? JSON.parse(savedLoading).loading : false;
  });
  const [kickoffHasLoaded, setKickoffHasLoaded] = useState(() => {
    if (isPageRefresh) return false;
    const savedData = sessionStorage.getItem(KICKOFF_DATA_KEY);
    return savedData ? JSON.parse(savedData).hasLoaded : false;
  });
  const [kickoffError, setKickoffError] = useState<string | null>(null);
  const [showKickoffNotification, setShowKickoffNotification] = useState(() => {
    if (isPageRefresh) return false;
    const savedLoading = sessionStorage.getItem(KICKOFF_LOADING_STATE_KEY);
    return savedLoading ? JSON.parse(savedLoading).loading : false;
  });
  const [kickoffNotificationMessage, setKickoffNotificationMessage] = useState(() => {
    if (isPageRefresh) return '';
    const savedLoading = sessionStorage.getItem(KICKOFF_LOADING_STATE_KEY);
    return savedLoading ? 'Loading design doc kickoff stats in background...' : '';
  });

  // Pull Request Feedback stats state
  const [prFeedbackStats, setPrFeedbackStats] = useState<PullRequestFeedbackStats[]>(() => {
    if (isPageRefresh) return [];
    const savedData = sessionStorage.getItem(PR_FEEDBACK_DATA_KEY);
    return savedData ? JSON.parse(savedData).stats : [];
  });
  const [prFeedbackLoading, setPrFeedbackLoading] = useState(() => {
    if (isPageRefresh) return false;
    const savedLoading = sessionStorage.getItem(PR_FEEDBACK_LOADING_STATE_KEY);
    return savedLoading ? JSON.parse(savedLoading).loading : false;
  });
  const [prFeedbackHasLoaded, setPrFeedbackHasLoaded] = useState(() => {
    if (isPageRefresh) return false;
    const savedData = sessionStorage.getItem(PR_FEEDBACK_DATA_KEY);
    return savedData ? JSON.parse(savedData).hasLoaded : false;
  });
  const [prFeedbackError, setPrFeedbackError] = useState<string | null>(null);
  const [showPrFeedbackNotification, setShowPrFeedbackNotification] = useState(() => {
    if (isPageRefresh) return false;
    const savedLoading = sessionStorage.getItem(PR_FEEDBACK_LOADING_STATE_KEY);
    return savedLoading ? JSON.parse(savedLoading).loading : false;
  });
  const [prFeedbackNotificationMessage, setPrFeedbackNotificationMessage] = useState(() => {
    if (isPageRefresh) return '';
    const savedLoading = sessionStorage.getItem(PR_FEEDBACK_LOADING_STATE_KEY);
    return savedLoading ? 'Loading pull request feedback stats in background...' : '';
  });

  const [prResolutionStats, setPrResolutionStats] = useState<PrResolutionMetricsStats[]>(() => {
    if (isPageRefresh) return [];
    const savedData = sessionStorage.getItem(PR_RESOLUTION_DATA_KEY);
    return savedData ? JSON.parse(savedData).stats : [];
  });
  const [prResolutionLoading, setPrResolutionLoading] = useState(() => {
    if (isPageRefresh) return false;
    const savedLoading = sessionStorage.getItem(PR_RESOLUTION_LOADING_STATE_KEY);
    return savedLoading ? JSON.parse(savedLoading).loading : false;
  });
  const [prResolutionHasLoaded, setPrResolutionHasLoaded] = useState(() => {
    if (isPageRefresh) return false;
    const savedData = sessionStorage.getItem(PR_RESOLUTION_DATA_KEY);
    return savedData ? JSON.parse(savedData).hasLoaded : false;
  });
  const [prResolutionError, setPrResolutionError] = useState<string | null>(null);
  const [showPrResolutionNotification, setShowPrResolutionNotification] = useState(() => {
    if (isPageRefresh) return false;
    const savedLoading = sessionStorage.getItem(PR_RESOLUTION_LOADING_STATE_KEY);
    return savedLoading ? JSON.parse(savedLoading).loading : false;
  });
  const [prResolutionNotificationMessage, setPrResolutionNotificationMessage] = useState(() => {
    if (isPageRefresh) return '';
    const savedLoading = sessionStorage.getItem(PR_RESOLUTION_LOADING_STATE_KEY);
    return savedLoading ? 'Loading PR resolution metrics in background...' : '';
  });

  const [eslintBurnDown, setEslintBurnDown] = useState<EslintBurnDownResponse | null>(() => {
    if (isPageRefresh) return null;
    const savedData = sessionStorage.getItem(ESLINT_DATA_KEY);
    return savedData ? JSON.parse(savedData).burnDown : null;
  });
  const [eslintGranularity, setEslintGranularity] = useState<EslintBurnDownGranularity>(() => {
    if (isPageRefresh) return 'weekly';
    const savedData = sessionStorage.getItem(ESLINT_DATA_KEY);
    return savedData ? JSON.parse(savedData).granularity ?? 'weekly' : 'weekly';
  });
  const [eslintLoading, setEslintLoading] = useState(() => {
    if (isPageRefresh) return false;
    const savedLoading = sessionStorage.getItem(ESLINT_LOADING_STATE_KEY);
    return savedLoading ? JSON.parse(savedLoading).loading : false;
  });
  const [eslintHasLoaded, setEslintHasLoaded] = useState(() => {
    if (isPageRefresh) return false;
    const savedData = sessionStorage.getItem(ESLINT_DATA_KEY);
    return savedData ? JSON.parse(savedData).hasLoaded : false;
  });
  const [eslintError, setEslintError] = useState<string | null>(null);
  const [showEslintNotification, setShowEslintNotification] = useState(() => {
    if (isPageRefresh) return false;
    const savedLoading = sessionStorage.getItem(ESLINT_LOADING_STATE_KEY);
    return savedLoading ? JSON.parse(savedLoading).loading : false;
  });
  const [eslintNotificationMessage, setEslintNotificationMessage] = useState(() => {
    if (isPageRefresh) return '';
    const savedLoading = sessionStorage.getItem(ESLINT_LOADING_STATE_KEY);
    return savedLoading ? 'Loading MaxView ESLint burn-down in background...' : '';
  });

  // Info tooltip state
  const [showChangesInfo, setShowChangesInfo] = useState(false);
  const [showHitRateInfo, setShowHitRateInfo] = useState(false);
  const [showPrTimeInfo, setShowPrTimeInfo] = useState(false);
  const [showQaBugInfo, setShowQaBugInfo] = useState(false);
  const [showInProgressInfo, setShowInProgressInfo] = useState(false);
  const [showKickoffInfo, setShowKickoffInfo] = useState(false);
  const [showPrFeedbackInfo, setShowPrFeedbackInfo] = useState(false);
  const [showPrResolutionInfo, setShowPrResolutionInfo] = useState(false);
  const [showAiAdoptionInfo, setShowAiAdoptionInfo] = useState(false);
  const [showPrCycleInfo, setShowPrCycleInfo] = useState(false);
  const [showAiCodeTagInfo, setShowAiCodeTagInfo] = useState(false);
  const [showEslintInfo, setShowEslintInfo] = useState(false);

  // Collapse state for sections — all default to collapsed for better visibility
  const [isEslintCollapsed, setIsEslintCollapsed] = useState(true);
  const [isAiAdoptionCollapsed, setIsAiAdoptionCollapsed] = useState(true);
  const [isPrCycleCollapsed, setIsPrCycleCollapsed] = useState(true);
  const [isAiCodeTagCollapsed, setIsAiCodeTagCollapsed] = useState(true);
  const [isChangesCollapsed, setIsChangesCollapsed] = useState(true);
  const [isHitRateCollapsed, setIsHitRateCollapsed] = useState(true);
  const [isPrTimeCollapsed, setIsPrTimeCollapsed] = useState(true);
  const [isQaBugCollapsed, setIsQaBugCollapsed] = useState(true);
  const [isInProgressCollapsed, setIsInProgressCollapsed] = useState(true);
  const [isKickoffCollapsed, setIsKickoffCollapsed] = useState(true);
  const [isPrFeedbackCollapsed, setIsPrFeedbackCollapsed] = useState(true);
  const [isPrResolutionCollapsed, setIsPrResolutionCollapsed] = useState(true);
  const [collapsedReasons, setCollapsedReasons] = useState<Set<string>>(new Set());
  const [collapsedQaBug, setCollapsedQaBug] = useState<Set<string>>(new Set());
  const [activeStatsTab, setActiveStatsTab] = useState<'ai' | 'other'>('ai');
  
  // Filter states - restore from sessionStorage
  const [selectedDeveloper, setSelectedDeveloper] = useState<string>(() => {
    if (isPageRefresh) return 'all';
    const savedFilters = sessionStorage.getItem(FILTER_STATE_KEY);
    return savedFilters ? JSON.parse(savedFilters).selectedDeveloper : 'all';
  });
  const [timeFrame, setTimeFrame] = useState<string>(() => {
    if (isPageRefresh) return '30';
    const savedFilters = sessionStorage.getItem(FILTER_STATE_KEY);
    return savedFilters ? JSON.parse(savedFilters).timeFrame : '30';
  });
  const [customFromDate, setCustomFromDate] = useState(() => {
    if (isPageRefresh) return '';
    const savedFilters = sessionStorage.getItem(FILTER_STATE_KEY);
    return savedFilters ? JSON.parse(savedFilters).customFromDate : '';
  });
  const [customToDate, setCustomToDate] = useState(() => {
    if (isPageRefresh) return '';
    const savedFilters = sessionStorage.getItem(FILTER_STATE_KEY);
    return savedFilters ? JSON.parse(savedFilters).customToDate : '';
  });

  // Get unique developers from stats data (not local workItems)
  // Include developers from all stat types
  const developers = useMemo(() => {
    const devSet = new Set<string>();
    
    // Add from due date stats
    dueDateStats.forEach(stat => {
      devSet.add(stat.developer);
    });
    
    // Add from hit rate stats
    hitRateStats.forEach(stat => {
      devSet.add(stat.developer);
    });
    
    // Add from PR time stats
    prTimeStats.forEach(stat => {
      devSet.add(stat.developer);
    });

    prResolutionStats.forEach(stat => {
      devSet.add(stat.developer);
    });
    
    const devList = Array.from(devSet).sort();
    console.log('DevStats - Developers from all stats:', devList);
    return devList;
  }, [dueDateStats, hitRateStats, prTimeStats, prResolutionStats]);

  // Team selection state
  const [selectedTeam, setSelectedTeam] = useState<string>('all');
  const [teamMembers, setTeamMembers] = useState<string[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [allTeamMembers, setAllTeamMembers] = useState<string[]>([]);

  // Combined list for dropdown: team members only (optionally extended by stats developers
  // who are also team members, so the list is always restricted to the 3 dev teams).
  const dropdownDevelopers = useMemo(() => {
    const relevantMembers = selectedTeam === 'all' ? allTeamMembers : teamMembers;
    const memberSet = new Set(relevantMembers);
    const combinedSet = new Set<string>(relevantMembers);

    // Only add developers from loaded stats if they are in the team member list
    if (memberSet.size > 0) {
      developers.forEach(dev => { if (memberSet.has(dev)) combinedSet.add(dev); });
    }

    const result = Array.from(combinedSet).sort();
    console.log('DevStats - Dropdown developers:', {
      count: result.length,
      selectedTeam,
      teamMembersCount: teamMembers.length,
      allTeamMembersCount: allTeamMembers.length,
    });
    return result;
  }, [selectedTeam, allTeamMembers, teamMembers, developers]);

  // Available teams — areaPath values must match ADO area path structure exactly
  const teams = [
    { id: 'all',           name: 'All Teams',          areaPath: '' },
    { id: 'maxview-dev',   name: 'MaxView - Dev',       teamName: 'MaxView - Dev',      project: 'MaxView', areaPath: 'MaxView' },
    { id: 'maxview-infra', name: 'MaxView Infra Team',  teamName: 'MaxView Infra Team', project: 'MaxView', areaPath: 'MaxView\\MaxView Infra Team' },
    { id: 'mobile-dev',    name: 'Mobile - Dev',        teamName: 'Mobile - Dev',       project: 'MaxView', areaPath: 'MaxView\\Mobile - Team' }
  ];

  // Fetch team members when team selection changes
  useEffect(() => {
    const fetchTeamMembers = async () => {
      if (selectedTeam === 'all') {
        // Fetch all team members from all dev teams
        try {
          setLoadingMembers(true);
          const response = await fetch('/api/dev-team-members', {
            credentials: 'include'
          });
          
          if (response.ok) {
            const members = await response.json();
            console.log(`DevStats - Loaded ${members.length} members from all teams:`, members);
            setAllTeamMembers(members);
            setTeamMembers([]);
          }
        } catch (error) {
          console.error('Error fetching all team members:', error);
          setAllTeamMembers([]);
        } finally {
          setLoadingMembers(false);
        }
        return;
      }

      const team = teams.find(t => t.id === selectedTeam);
      if (!team || !('teamName' in team) || !team.teamName || !team.project) return;

      try {
        setLoadingMembers(true);
        const params = new URLSearchParams();
        params.append('project', team.project);
        params.append('teamName', team.teamName);
        
        const response = await fetch(`/api/team-members?${params.toString()}`, {
          credentials: 'include'
        });
        
        if (response.ok) {
          const members = await response.json();
          console.log(`DevStats - Loaded ${members.length} members for ${team.name}:`, members);
          setTeamMembers(members);
          setAllTeamMembers([]);
        }
      } catch (error) {
        console.error('Error fetching team members:', error);
        setTeamMembers([]);
      } finally {
        setLoadingMembers(false);
      }
    };

    fetchTeamMembers();
  }, [selectedTeam]); // Run when team selection changes

  // Poll sessionStorage to sync loading state and data across navigation
  useEffect(() => {
    const checkState = () => {
      // Check loading state for due date changes
      const savedLoadingState = sessionStorage.getItem(LOADING_STATE_KEY);
      if (savedLoadingState) {
        const { loading: isLoading } = JSON.parse(savedLoadingState);
        if (isLoading && !loading) {
          setLoading(true);
          setShowNotification(true);
          setNotificationMessage('Loading statistics in background...');
        } else if (!isLoading && loading) {
          setLoading(false);
        }
      } else if (loading) {
        // If sessionStorage was cleared but we're still loading locally, sync it
        setLoading(false);
        setShowNotification(false);
      }

      // Check loading state for hit rate
      const savedHitRateLoadingState = sessionStorage.getItem(HIT_RATE_LOADING_STATE_KEY);
      if (savedHitRateLoadingState) {
        const { loading: isLoading } = JSON.parse(savedHitRateLoadingState);
        if (isLoading && !hitRateLoading) {
          setHitRateLoading(true);
          setShowHitRateNotification(true);
          setHitRateNotificationMessage('Loading hit rate statistics in background...');
        } else if (!isLoading && hitRateLoading) {
          setHitRateLoading(false);
        }
      } else if (hitRateLoading) {
        setHitRateLoading(false);
        setShowHitRateNotification(false);
      }

      // Check for data updates
      const savedData = sessionStorage.getItem(DATA_STATE_KEY);
      if (savedData) {
        const { stats, hasLoaded: dataHasLoaded } = JSON.parse(savedData);
        // Only update if the data has changed
        if (JSON.stringify(stats) !== JSON.stringify(dueDateStats)) {
          setDueDateStats(stats);
        }
        if (dataHasLoaded !== hasLoaded) {
          setHasLoaded(dataHasLoaded);
        }
      }

      // Check for hit rate data updates
      const savedHitRateData = sessionStorage.getItem(HIT_RATE_DATA_KEY);
      if (savedHitRateData) {
        const { stats, hasLoaded: dataHasLoaded } = JSON.parse(savedHitRateData);
        if (JSON.stringify(stats) !== JSON.stringify(hitRateStats)) {
          setHitRateStats(stats);
        }
        if (dataHasLoaded !== hitRateHasLoaded) {
          setHitRateHasLoaded(dataHasLoaded);
        }
      }

      // Check loading state for PR time
      const savedPRTimeLoadingState = sessionStorage.getItem(PR_TIME_LOADING_STATE_KEY);
      if (savedPRTimeLoadingState) {
        const { loading: isLoading } = JSON.parse(savedPRTimeLoadingState);
        if (isLoading && !prTimeLoading) {
          setPrTimeLoading(true);
          setShowPrTimeNotification(true);
          setPrTimeNotificationMessage('Loading pull request time stats in background...');
        } else if (!isLoading && prTimeLoading) {
          setPrTimeLoading(false);
        }
      } else if (prTimeLoading) {
        setPrTimeLoading(false);
        setShowPrTimeNotification(false);
      }

      // Check for PR time data updates
      const savedPRTimeData = sessionStorage.getItem(PR_TIME_DATA_KEY);
      if (savedPRTimeData) {
        const { stats, hasLoaded: dataHasLoaded } = JSON.parse(savedPRTimeData);
        if (JSON.stringify(stats) !== JSON.stringify(prTimeStats)) {
          setPrTimeStats(stats);
        }
        if (dataHasLoaded !== prTimeHasLoaded) {
          setPrTimeHasLoaded(dataHasLoaded);
        }
      }

      // Check loading state for kickoff
      const savedKickoffLoadingState = sessionStorage.getItem(KICKOFF_LOADING_STATE_KEY);
      if (savedKickoffLoadingState) {
        const { loading: isLoading } = JSON.parse(savedKickoffLoadingState);
        if (isLoading && !kickoffLoading) {
          setKickoffLoading(true);
          setShowKickoffNotification(true);
          setKickoffNotificationMessage('Loading design doc kickoff stats in background...');
        } else if (!isLoading && kickoffLoading) {
          setKickoffLoading(false);
        }
      } else if (kickoffLoading) {
        setKickoffLoading(false);
        setShowKickoffNotification(false);
      }

      // Check for kickoff data updates
      const savedKickoffData = sessionStorage.getItem(KICKOFF_DATA_KEY);
      if (savedKickoffData) {
        const { stats, hasLoaded: dataHasLoaded } = JSON.parse(savedKickoffData);
        if (JSON.stringify(stats) !== JSON.stringify(kickoffStats)) {
          setKickoffStats(stats);
        }
        if (dataHasLoaded !== kickoffHasLoaded) {
          setKickoffHasLoaded(dataHasLoaded);
        }
      }
    };

    // Check immediately on mount
    checkState();

    // Poll every 500ms to detect changes
    const interval = setInterval(checkState, 500);

    return () => clearInterval(interval);
  }, [loading, dueDateStats, hasLoaded, hitRateLoading, hitRateStats, hitRateHasLoaded, prTimeLoading, prTimeStats, prTimeHasLoaded, kickoffLoading, kickoffStats, kickoffHasLoaded]);

  // Persist filter selections to sessionStorage whenever they change
  useEffect(() => {
    const filters = {
      selectedDeveloper,
      timeFrame,
      customFromDate,
      customToDate
    };
    sessionStorage.setItem(FILTER_STATE_KEY, JSON.stringify(filters));
  }, [selectedDeveloper, timeFrame, customFromDate, customToDate]);

  // Persist data and hasLoaded state to sessionStorage
  useEffect(() => {
    const data = {
      stats: dueDateStats,
      hasLoaded
    };
    sessionStorage.setItem(DATA_STATE_KEY, JSON.stringify(data));
  }, [dueDateStats, hasLoaded]);

  // Persist hit rate data to sessionStorage
  useEffect(() => {
    const data = {
      stats: hitRateStats,
      hasLoaded: hitRateHasLoaded
    };
    sessionStorage.setItem(HIT_RATE_DATA_KEY, JSON.stringify(data));
  }, [hitRateStats, hitRateHasLoaded]);

  // Persist PR time data to sessionStorage
  useEffect(() => {
    const data = {
      stats: prTimeStats,
      hasLoaded: prTimeHasLoaded
    };
    console.log('DevStats - PR Time state changed:', {
      statsCount: prTimeStats.length,
      hasLoaded: prTimeHasLoaded,
      developers: prTimeStats.map(s => s.developer)
    });
    sessionStorage.setItem(PR_TIME_DATA_KEY, JSON.stringify(data));
  }, [prTimeStats, prTimeHasLoaded]);

  // Persist kickoff data to sessionStorage
  useEffect(() => {
    sessionStorage.setItem(KICKOFF_DATA_KEY, JSON.stringify({ stats: kickoffStats, hasLoaded: kickoffHasLoaded }));
  }, [kickoffStats, kickoffHasLoaded]);

  // Persist PR feedback data to sessionStorage
  useEffect(() => {
    sessionStorage.setItem(PR_FEEDBACK_DATA_KEY, JSON.stringify({ stats: prFeedbackStats, hasLoaded: prFeedbackHasLoaded }));
  }, [prFeedbackStats, prFeedbackHasLoaded]);

  useEffect(() => {
    sessionStorage.setItem(PR_RESOLUTION_DATA_KEY, JSON.stringify({ stats: prResolutionStats, hasLoaded: prResolutionHasLoaded }));
  }, [prResolutionStats, prResolutionHasLoaded]);

  useEffect(() => {
    sessionStorage.setItem(ESLINT_DATA_KEY, JSON.stringify({ burnDown: eslintBurnDown, granularity: eslintGranularity, hasLoaded: eslintHasLoaded }));
  }, [eslintBurnDown, eslintGranularity, eslintHasLoaded]);

  const fetchDueDateStats = async () => {
    setLoading(true);
    setError(null);
    setShowNotification(true);
    setNotificationMessage('Loading statistics in background...');
    
    // Store loading state in sessionStorage
    sessionStorage.setItem(LOADING_STATE_KEY, JSON.stringify({ loading: true, timestamp: Date.now() }));
    
    try {
      // Calculate date range based on time frame
      let fromDate = '';
      let toDate = new Date().toISOString().split('T')[0];
      
      if (timeFrame === 'custom') {
        fromDate = customFromDate;
        toDate = customToDate;
      } else {
        const daysBack = parseInt(timeFrame);
        const from = new Date();
        from.setDate(from.getDate() - daysBack);
        fromDate = from.toISOString().split('T')[0];
      }
      
      // Build query params
      const params = new URLSearchParams();
      if (fromDate) params.append('from', fromDate);
      if (toDate) params.append('to', toDate);
      if (selectedDeveloper !== 'all') params.append('developer', selectedDeveloper);
      const selectedTeamDef = teams.find(t => t.id === selectedTeam);
      if (selectedTeamDef?.areaPath) params.append('areaPath', selectedTeamDef.areaPath);
      
      const response = await fetch(`/api/due-date-stats?${params.toString()}`, {
        credentials: 'include'
      });
      
      if (!response.ok) {
        throw new Error('Failed to fetch due date statistics');
      }
      const data = await response.json();
      
      console.log('DevStats - API returned data:', {
        count: data.length,
        developers: data.map((s: any) => s.developer)
      });
      
      // Save to sessionStorage immediately (works even if component unmounts)
      sessionStorage.setItem(DATA_STATE_KEY, JSON.stringify({ 
        stats: data, 
        hasLoaded: true 
      }));
      
      // Update component state (only works if still mounted)
      setDueDateStats(data);
      setHasLoaded(true);
      setNotificationMessage('Statistics loaded successfully!');
      
      // Auto-hide success notification after 3 seconds
      setTimeout(() => {
        setShowNotification(false);
      }, 3000);
    } catch (err) {
      console.error('Error fetching due date stats:', err);
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      setError(errorMsg);
      setNotificationMessage(`Error: ${errorMsg}`);
    } finally {
      setLoading(false);
      // Update loading state to false instead of removing
      sessionStorage.setItem(LOADING_STATE_KEY, JSON.stringify({ loading: false, timestamp: Date.now() }));
    }
  };

  const fetchDueDateHitRate = async () => {
    setHitRateLoading(true);
    setHitRateError(null);
    setShowHitRateNotification(true);
    setHitRateNotificationMessage('Loading hit rate statistics in background...');
    
    // Store loading state in sessionStorage
    sessionStorage.setItem(HIT_RATE_LOADING_STATE_KEY, JSON.stringify({ loading: true, timestamp: Date.now() }));
    
    try {
      // Calculate date range based on time frame
      let fromDate = '';
      let toDate = new Date().toISOString().split('T')[0];
      
      if (timeFrame === 'custom') {
        fromDate = customFromDate;
        toDate = customToDate;
      } else {
        const daysBack = parseInt(timeFrame);
        const from = new Date();
        from.setDate(from.getDate() - daysBack);
        fromDate = from.toISOString().split('T')[0];
      }
      
      // Build query params
      const params = new URLSearchParams();
      if (fromDate) params.append('from', fromDate);
      if (toDate) params.append('to', toDate);
      if (selectedDeveloper !== 'all') params.append('developer', selectedDeveloper);
      const selectedTeamDef = teams.find(t => t.id === selectedTeam);
      if (selectedTeamDef?.areaPath) params.append('areaPath', selectedTeamDef.areaPath);
      
      const response = await fetch(`/api/due-date-hit-rate?${params.toString()}`, {
        credentials: 'include'
      });
      
      if (!response.ok) {
        throw new Error('Failed to fetch due date hit rate statistics');
      }
      const data = await response.json();
      
      console.log('DevStats - Hit rate API returned data:', data);
      
      // Save to sessionStorage immediately (works even if component unmounts)
      sessionStorage.setItem(HIT_RATE_DATA_KEY, JSON.stringify({ 
        stats: data, 
        hasLoaded: true 
      }));
      
      // Update component state (only works if still mounted)
      setHitRateStats(data);
      setHitRateHasLoaded(true);
      setHitRateNotificationMessage('Hit rate statistics loaded successfully!');
      
      // Auto-hide success notification after 3 seconds
      setTimeout(() => {
        setShowHitRateNotification(false);
      }, 3000);
    } catch (err) {
      console.error('Error fetching due date hit rate stats:', err);
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      setHitRateError(errorMsg);
      setHitRateNotificationMessage(`Error: ${errorMsg}`);
    } finally {
      setHitRateLoading(false);
      // Update loading state to false instead of removing
      sessionStorage.setItem(HIT_RATE_LOADING_STATE_KEY, JSON.stringify({ loading: false, timestamp: Date.now() }));
    }
  };

  const fetchPullRequestTimeStats = async () => {
    console.log('=== FETCH PR TIME STATS STARTED ===');
    console.log('Current state:', {
      selectedTeam,
      selectedDeveloper,
      timeFrame,
      customFromDate,
      customToDate,
      teamMembers: teamMembers.length,
      allTeamMembers: allTeamMembers.length
    });
    
    setPrTimeLoading(true);
    setPrTimeError(null);
    setShowPrTimeNotification(true);
    setPrTimeNotificationMessage('Loading pull request time statistics in background...');
    
    // Store loading state in sessionStorage
    sessionStorage.setItem(PR_TIME_LOADING_STATE_KEY, JSON.stringify({ loading: true, timestamp: Date.now() }));
    
    try {
      // Calculate date range based on time frame
      let fromDate = '';
      let toDate = new Date().toISOString().split('T')[0];
      
      if (timeFrame === 'custom') {
        fromDate = customFromDate;
        toDate = customToDate;
      } else {
        const daysBack = parseInt(timeFrame);
        const from = new Date();
        from.setDate(from.getDate() - daysBack);
        fromDate = from.toISOString().split('T')[0];
      }
      
      console.log('Date range calculated:', { fromDate, toDate });
      
      // Build query params
      const params = new URLSearchParams();
      if (fromDate) params.append('from', fromDate);
      if (toDate) params.append('to', toDate);
      if (selectedDeveloper !== 'all') params.append('developer', selectedDeveloper);
      const selectedTeamDef = teams.find(t => t.id === selectedTeam);
      if (selectedTeamDef?.areaPath) params.append('areaPath', selectedTeamDef.areaPath);
      
      const url = `/api/pull-request-time-stats?${params.toString()}`;
      console.log('Fetching PR time stats from:', url);
      
      const response = await fetch(url, {
        credentials: 'include'
      });
      
      console.log('Response status:', response.status);
      
      if (!response.ok) {
        throw new Error('Failed to fetch pull request time statistics');
      }
      const data = await response.json();
      
      console.log('=== PR TIME API RESPONSE ===');
      console.log('Total developers returned:', data.length);
      console.log('Data:', JSON.stringify(data, null, 2));
      console.log('Developers:', data.map((d: any) => d.developer));
      
      // Save to sessionStorage immediately (works even if component unmounts)
      sessionStorage.setItem(PR_TIME_DATA_KEY, JSON.stringify({ 
        stats: data, 
        hasLoaded: true 
      }));
      
      console.log('Saved to sessionStorage:', PR_TIME_DATA_KEY);
      
      // Update component state (only works if still mounted)
      console.log('Setting prTimeStats state with', data.length, 'items');
      setPrTimeStats(data);
      setPrTimeHasLoaded(true);
      setPrTimeNotificationMessage('Pull request time statistics loaded successfully!');
      
      console.log('=== FETCH PR TIME STATS COMPLETED SUCCESSFULLY ===');
      
      // Auto-hide success notification after 3 seconds
      setTimeout(() => {
        setShowPrTimeNotification(false);
      }, 3000);
    } catch (err) {
      console.error('=== ERROR FETCHING PR TIME STATS ===');
      console.error('Error details:', err);
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      setPrTimeError(errorMsg);
      setPrTimeNotificationMessage(`Error: ${errorMsg}`);
    } finally {
      setPrTimeLoading(false);
      // Update loading state to false instead of removing
      sessionStorage.setItem(PR_TIME_LOADING_STATE_KEY, JSON.stringify({ loading: false, timestamp: Date.now() }));
      console.log('=== FETCH PR TIME STATS ENDED ===');
    }
  };

  const fetchQABugStats = async () => {
    console.log('=== FETCH QA BUG STATS CALLED ===');
    console.log('Current state:', {
      selectedTeam,
      selectedDeveloper,
      timeFrame,
      customFromDate,
      customToDate,
      teamMembers: teamMembers.length,
      allTeamMembers: allTeamMembers.length
    });
    
    setQaBugLoading(true);
    setQaBugError(null);
    setShowQaBugNotification(true);
    setQaBugNotificationMessage('Loading QA bug statistics in background...');
    
    // Store loading state in sessionStorage
    sessionStorage.setItem(QA_BUG_LOADING_STATE_KEY, JSON.stringify({ loading: true, timestamp: Date.now() }));
    
    try {
      // Calculate date range based on time frame
      let fromDate = '';
      let toDate = new Date().toISOString().split('T')[0];
      
      if (timeFrame === 'custom') {
        fromDate = customFromDate;
        toDate = customToDate;
      } else {
        const daysBack = parseInt(timeFrame);
        const from = new Date();
        from.setDate(from.getDate() - daysBack);
        fromDate = from.toISOString().split('T')[0];
      }
      
      console.log('Date range calculated:', { fromDate, toDate });
      
      // Build query params
      const params = new URLSearchParams();
      if (fromDate) params.append('from', fromDate);
      if (toDate) params.append('to', toDate);
      if (selectedDeveloper !== 'all') params.append('developer', selectedDeveloper);
      const selectedTeamDef = teams.find(t => t.id === selectedTeam);
      if (selectedTeamDef?.areaPath) params.append('areaPath', selectedTeamDef.areaPath);
      
      const url = `/api/qa-bug-stats?${params.toString()}`;
      console.log('Fetching QA bug stats from:', url);
      
      const response = await fetch(url, {
        credentials: 'include'
      });
      
      console.log('Response status:', response.status);
      
      if (!response.ok) {
        throw new Error('Failed to fetch QA bug statistics');
      }
      const data = await response.json();
      
      console.log('=== QA BUG API RESPONSE ===');
      console.log('Total developers returned:', data.length);
      console.log('Data:', JSON.stringify(data, null, 2));
      console.log('Developers:', data.map((d: any) => d.developer));
      
      // Save to sessionStorage immediately (works even if component unmounts)
      sessionStorage.setItem(QA_BUG_DATA_KEY, JSON.stringify({ 
        stats: data, 
        hasLoaded: true 
      }));
      
      console.log('Saved to sessionStorage:', QA_BUG_DATA_KEY);
      
      // Update component state (only works if still mounted)
      console.log('Setting qaBugStats state with', data.length, 'items');
      setQaBugStats(data);
      setQaBugHasLoaded(true);
      setQaBugNotificationMessage('QA bug statistics loaded successfully!');
      
      console.log('=== FETCH QA BUG STATS COMPLETED SUCCESSFULLY ===');
      
      // Auto-hide success notification after 3 seconds
      setTimeout(() => {
        setShowQaBugNotification(false);
      }, 3000);
    } catch (err) {
      console.error('=== ERROR FETCHING QA BUG STATS ===');
      console.error('Error details:', err);
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      setQaBugError(errorMsg);
      setQaBugNotificationMessage(`Error: ${errorMsg}`);
    } finally {
      setQaBugLoading(false);
      // Update loading state to false instead of removing
      sessionStorage.setItem(QA_BUG_LOADING_STATE_KEY, JSON.stringify({ loading: false, timestamp: Date.now() }));
      console.log('=== FETCH QA BUG STATS ENDED ===');
    }
  };

  const fetchInProgressStats = async () => {
    setInProgressLoading(true);
    setInProgressError(null);
    setShowInProgressNotification(true);
    setInProgressNotificationMessage('Loading in-progress statistics in background...');
    sessionStorage.setItem(IN_PROGRESS_LOADING_STATE_KEY, JSON.stringify({ loading: true, timestamp: Date.now() }));

    try {
      let fromDate = '';
      let toDate = new Date().toISOString().split('T')[0];

      if (timeFrame === 'custom') {
        fromDate = customFromDate;
        toDate = customToDate;
      } else {
        const daysBack = parseInt(timeFrame);
        const from = new Date();
        from.setDate(from.getDate() - daysBack);
        fromDate = from.toISOString().split('T')[0];
      }

      const params = new URLSearchParams();
      if (fromDate) params.append('from', fromDate);
      if (toDate) params.append('to', toDate);
      if (selectedDeveloper !== 'all') params.append('developer', selectedDeveloper);
      const selectedTeamDef = teams.find(t => t.id === selectedTeam);
      if (selectedTeamDef?.areaPath) params.append('areaPath', selectedTeamDef.areaPath);

      const response = await fetch(`/api/in-progress-stats?${params.toString()}`, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch in-progress statistics');

      const data: InProgressTimeStats[] = await response.json();
      sessionStorage.setItem(IN_PROGRESS_DATA_KEY, JSON.stringify({ stats: data, hasLoaded: true }));
      setInProgressStats(data);
      setInProgressHasLoaded(true);
      setInProgressNotificationMessage('In-progress statistics loaded successfully!');
      setTimeout(() => setShowInProgressNotification(false), 3000);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      setInProgressError(errorMsg);
      setInProgressNotificationMessage(`Error: ${errorMsg}`);
    } finally {
      setInProgressLoading(false);
      sessionStorage.setItem(IN_PROGRESS_LOADING_STATE_KEY, JSON.stringify({ loading: false, timestamp: Date.now() }));
    }
  };

  const fetchDesignDocKickoffStats = async () => {
    setKickoffLoading(true);
    setKickoffError(null);
    setShowKickoffNotification(true);
    setKickoffNotificationMessage('Loading design doc kickoff statistics in background...');
    sessionStorage.setItem(KICKOFF_LOADING_STATE_KEY, JSON.stringify({ loading: true, timestamp: Date.now() }));

    try {
      let fromDate = '';
      let toDate = new Date().toISOString().split('T')[0];

      if (timeFrame === 'custom') {
        fromDate = customFromDate;
        toDate = customToDate;
      } else {
        const daysBack = parseInt(timeFrame);
        const from = new Date();
        from.setDate(from.getDate() - daysBack);
        fromDate = from.toISOString().split('T')[0];
      }

      const params = new URLSearchParams();
      if (fromDate) params.append('from', fromDate);
      if (toDate) params.append('to', toDate);
      if (selectedDeveloper !== 'all') params.append('developer', selectedDeveloper);
      const selectedTeamDef = teams.find(t => t.id === selectedTeam);
      if (selectedTeamDef?.areaPath) params.append('areaPath', selectedTeamDef.areaPath);

      const response = await fetch(`/api/design-doc-kickoff-stats?${params.toString()}`, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch design doc kickoff statistics');

      const data: DesignDocKickoffStats[] = await response.json();
      sessionStorage.setItem(KICKOFF_DATA_KEY, JSON.stringify({ stats: data, hasLoaded: true }));
      setKickoffStats(data);
      setKickoffHasLoaded(true);
      setKickoffNotificationMessage('Design doc kickoff statistics loaded successfully!');
      setTimeout(() => setShowKickoffNotification(false), 3000);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      setKickoffError(errorMsg);
      setKickoffNotificationMessage(`Error: ${errorMsg}`);
    } finally {
      setKickoffLoading(false);
      sessionStorage.setItem(KICKOFF_LOADING_STATE_KEY, JSON.stringify({ loading: false, timestamp: Date.now() }));
    }
  };

  const fetchPullRequestFeedbackStats = async () => {
    setPrFeedbackLoading(true);
    setPrFeedbackError(null);
    setShowPrFeedbackNotification(true);
    setPrFeedbackNotificationMessage('Loading pull request feedback statistics in background...');
    sessionStorage.setItem(PR_FEEDBACK_LOADING_STATE_KEY, JSON.stringify({ loading: true, timestamp: Date.now() }));

    try {
      let fromDate = '';
      let toDate = new Date().toISOString().split('T')[0];
      if (timeFrame === 'custom') {
        fromDate = customFromDate;
        toDate = customToDate;
      } else {
        const daysBack = parseInt(timeFrame);
        const from = new Date();
        from.setDate(from.getDate() - daysBack);
        fromDate = from.toISOString().split('T')[0];
      }

      const params = new URLSearchParams();
      if (fromDate) params.append('from', fromDate);
      if (toDate) params.append('to', toDate);
      if (selectedDeveloper !== 'all') params.append('developer', selectedDeveloper);
      const selectedTeamDef = teams.find(t => t.id === selectedTeam);
      if (selectedTeamDef?.areaPath) params.append('areaPath', selectedTeamDef.areaPath);

      const response = await fetch(`/api/pull-request-feedback-stats?${params.toString()}`, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch pull request feedback statistics');

      const data: PullRequestFeedbackStats[] = await response.json();
      sessionStorage.setItem(PR_FEEDBACK_DATA_KEY, JSON.stringify({ stats: data, hasLoaded: true }));
      setPrFeedbackStats(data);
      setPrFeedbackHasLoaded(true);
      setPrFeedbackNotificationMessage('Pull request feedback statistics loaded successfully!');
      setTimeout(() => setShowPrFeedbackNotification(false), 3000);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      setPrFeedbackError(errorMsg);
      setPrFeedbackNotificationMessage(`Error: ${errorMsg}`);
    } finally {
      setPrFeedbackLoading(false);
      sessionStorage.setItem(PR_FEEDBACK_LOADING_STATE_KEY, JSON.stringify({ loading: false, timestamp: Date.now() }));
    }
  };

  const fetchPrResolutionMetricsStats = async () => {
    setPrResolutionLoading(true);
    setPrResolutionError(null);
    setShowPrResolutionNotification(true);
    setPrResolutionNotificationMessage('Loading PR resolution metrics in background...');
    sessionStorage.setItem(PR_RESOLUTION_LOADING_STATE_KEY, JSON.stringify({ loading: true, timestamp: Date.now() }));

    try {
      let fromDate = '';
      let toDate = new Date().toISOString().split('T')[0];
      if (timeFrame === 'custom') {
        fromDate = customFromDate;
        toDate = customToDate;
      } else {
        const daysBack = parseInt(timeFrame);
        const from = new Date();
        from.setDate(from.getDate() - daysBack);
        fromDate = from.toISOString().split('T')[0];
      }

      const params = new URLSearchParams();
      if (fromDate) params.append('from', fromDate);
      if (toDate) params.append('to', toDate);
      if (selectedDeveloper !== 'all') params.append('developer', selectedDeveloper);
      const selectedTeamDef = teams.find(t => t.id === selectedTeam);
      if (selectedTeamDef?.areaPath) params.append('areaPath', selectedTeamDef.areaPath);

      const response = await fetch(`/api/pr-resolution-metrics-stats?${params.toString()}`, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch PR resolution metrics');

      const data: PrResolutionMetricsStats[] = await response.json();
      sessionStorage.setItem(PR_RESOLUTION_DATA_KEY, JSON.stringify({ stats: data, hasLoaded: true }));
      setPrResolutionStats(data);
      setPrResolutionHasLoaded(true);
      setPrResolutionNotificationMessage('PR resolution metrics loaded successfully!');
      setTimeout(() => setShowPrResolutionNotification(false), 3000);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      setPrResolutionError(errorMsg);
      setPrResolutionNotificationMessage(`Error: ${errorMsg}`);
    } finally {
      setPrResolutionLoading(false);
      sessionStorage.setItem(PR_RESOLUTION_LOADING_STATE_KEY, JSON.stringify({ loading: false, timestamp: Date.now() }));
    }
  };

  const fetchEslintBurnDown = async () => {
    setEslintLoading(true);
    setEslintError(null);
    setShowEslintNotification(true);
    setEslintNotificationMessage('Loading MaxView ESLint burn-down from pipeline artifacts...');
    sessionStorage.setItem(ESLINT_LOADING_STATE_KEY, JSON.stringify({ loading: true, timestamp: Date.now() }));

    try {
      const fromDate =
        timeFrame === 'custom' && customFromDate
          ? customFromDate
          : (() => {
              const d = new Date();
              d.setDate(d.getDate() - parseInt(timeFrame || '90', 10));
              return d.toISOString().split('T')[0]!;
            })();
      const toDate =
        timeFrame === 'custom' && customToDate ? customToDate : new Date().toISOString().split('T')[0]!;

      if (!fromDate || !toDate) {
        throw new Error('Select a valid date range before loading ESLint burn-down data');
      }

      const params = new URLSearchParams({ from: fromDate, to: toDate });
      const response = await fetch(`/api/maxview-eslint-burndown?${params.toString()}`, { credentials: 'include' });
      if (!response.ok) {
        let message = 'Failed to fetch MaxView ESLint burn-down';
        try {
          const body = await response.json();
          if (body?.error) message = body.error;
        } catch {
          // Keep the generic message if the API did not return JSON.
        }
        throw new Error(message);
      }

      const data: EslintBurnDownResponse = await response.json();
      sessionStorage.setItem(ESLINT_DATA_KEY, JSON.stringify({ burnDown: data, granularity: eslintGranularity, hasLoaded: true }));
      setEslintBurnDown(data);
      setEslintHasLoaded(true);
      setEslintNotificationMessage('MaxView ESLint burn-down loaded successfully!');
      setTimeout(() => setShowEslintNotification(false), 3000);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      setEslintError(errorMsg);
      setEslintNotificationMessage(`Error: ${errorMsg}`);
    } finally {
      setEslintLoading(false);
      sessionStorage.setItem(ESLINT_LOADING_STATE_KEY, JSON.stringify({ loading: false, timestamp: Date.now() }));
    }
  };

  const refreshAiAdoptionTrends = async () => {
    await Promise.all([
      fetchDesignDocKickoffStats(),
      fetchPrResolutionMetricsStats(),
    ]);
  };

  // Active member allow-list: allTeamMembers for "all", teamMembers for a specific team.
  // null means the list is still loading — don't filter yet.
  const activeMemberSet = useMemo((): Set<string> | null => {
    if (selectedTeam === 'all') {
      return allTeamMembers.length > 0 ? new Set(allTeamMembers) : null;
    }
    return teamMembers.length > 0 ? new Set(teamMembers) : null;
  }, [selectedTeam, teamMembers, allTeamMembers]);

  // Filter the results by developer if needed, and by team if selected
  const filteredStats = useMemo(() => {
    let stats = activeMemberSet
      ? dueDateStats.filter(s => activeMemberSet.has(s.developer))
      : dueDateStats;
    if (selectedDeveloper !== 'all') stats = stats.filter(s => s.developer === selectedDeveloper);
    return stats;
  }, [dueDateStats, selectedDeveloper, activeMemberSet]);

  const filteredHitRateStats = useMemo(() => {
    let stats = activeMemberSet
      ? hitRateStats.filter(s => activeMemberSet.has(s.developer))
      : hitRateStats;
    if (selectedDeveloper !== 'all') stats = stats.filter(s => s.developer === selectedDeveloper);
    return stats;
  }, [hitRateStats, selectedDeveloper, activeMemberSet]);

  const filteredPrTimeStats = useMemo(() => {
    let stats = activeMemberSet
      ? prTimeStats.filter(s => activeMemberSet.has(s.developer))
      : prTimeStats;
    if (selectedDeveloper !== 'all') stats = stats.filter(s => s.developer === selectedDeveloper);
    return stats;
  }, [prTimeStats, selectedDeveloper, activeMemberSet]);

  const filteredQaBugStats = useMemo(() => {
    let stats = activeMemberSet
      ? qaBugStats.filter(s => activeMemberSet.has(s.developer))
      : qaBugStats;
    if (selectedDeveloper !== 'all') stats = stats.filter(s => s.developer === selectedDeveloper);
    return stats;
  }, [qaBugStats, selectedDeveloper, activeMemberSet]);

  const filteredInProgressStats = useMemo(() => {
    let stats = activeMemberSet
      ? inProgressStats.filter(s => activeMemberSet.has(s.developer))
      : inProgressStats;
    if (selectedDeveloper !== 'all') stats = stats.filter(s => s.developer === selectedDeveloper);
    return stats;
  }, [inProgressStats, selectedDeveloper, activeMemberSet]);

  const filteredKickoffStats = useMemo(() => {
    let stats = activeMemberSet
      ? kickoffStats.filter(s => activeMemberSet.has(s.developer))
      : kickoffStats;
    if (selectedDeveloper !== 'all') stats = stats.filter(s => s.developer === selectedDeveloper);
    return stats;
  }, [kickoffStats, selectedDeveloper, activeMemberSet]);

  const filteredPrFeedbackStats = useMemo(() => {
    let stats = activeMemberSet
      ? prFeedbackStats.filter(s => activeMemberSet.has(s.developer))
      : prFeedbackStats;
    if (selectedDeveloper !== 'all') stats = stats.filter(s => s.developer === selectedDeveloper);
    return stats;
  }, [prFeedbackStats, selectedDeveloper, activeMemberSet]);

  const filteredPrResolutionStats = useMemo(() => {
    let stats = activeMemberSet
      ? prResolutionStats.filter(s => activeMemberSet.has(s.developer))
      : prResolutionStats;
    if (selectedDeveloper !== 'all') stats = stats.filter(s => s.developer === selectedDeveloper);
    return stats;
  }, [prResolutionStats, selectedDeveloper, activeMemberSet]);

  /** Weekly counts from kickoff commits and PR resolution rows (respects team / developer filters). */
  const aiAdoptionChartData = useMemo(() => {
    const bucket = new Map<string, { weekKey: string; designDocCount: number; prResolutionCount: number }>();

    const bump = (weekKey: string, field: 'designDocCount' | 'prResolutionCount') => {
      const cur = bucket.get(weekKey) ?? { weekKey, designDocCount: 0, prResolutionCount: 0 };
      cur[field] += 1;
      bucket.set(weekKey, cur);
    };

    for (const dev of filteredKickoffStats) {
      for (const k of dev.kickoffDetails) {
        const day = parseStatDay(k.commitDate);
        if (!day) continue;
        bump(weekStartMondayKey(day), 'designDocCount');
      }
    }
    for (const dev of filteredPrResolutionStats) {
      for (const pr of dev.prDetails) {
        const day = parseStatDay(pr.date);
        if (!day) continue;
        bump(weekStartMondayKey(day), 'prResolutionCount');
      }
    }

    return Array.from(bucket.values())
      .sort((a, b) => a.weekKey.localeCompare(b.weekKey))
      .map(row => ({
        weekKey: row.weekKey,
        period: formatWeekLabel(row.weekKey),
        designDocCount: row.designDocCount,
        prResolutionCount: row.prResolutionCount,
      }));
  }, [filteredKickoffStats, filteredPrResolutionStats]);

  /** Weekly PR cycle-time trend: opened PRs by creation week; completed PRs by closed week. */
  const prCycleTimeChartData = useMemo(() => {
    type WeekBucket = {
      weekKey: string;
      openedTotalDays: number;
      openedCount: number;
      completedTotalDays: number;
      completedCount: number;
    };
    const bucket = new Map<string, WeekBucket>();
    const getBucket = (weekKey: string) => {
      const cur = bucket.get(weekKey) ?? {
        weekKey,
        openedTotalDays: 0,
        openedCount: 0,
        completedTotalDays: 0,
        completedCount: 0,
      };
      bucket.set(weekKey, cur);
      return cur;
    };

    for (const dev of filteredPrTimeStats) {
      for (const item of dev.workItemDetails) {
        const openedDay = parseStatDay(item.enteredPullRequestDate);
        if (openedDay) {
          const openedBucket = getBucket(weekStartMondayKey(openedDay));
          openedBucket.openedTotalDays += item.timeInPullRequestDays;
          openedBucket.openedCount += 1;
        }

        if (!item.isActive) {
          const closedDay = parseStatDay(item.exitedPullRequestDate);
          if (closedDay) {
            const closedBucket = getBucket(weekStartMondayKey(closedDay));
            closedBucket.completedTotalDays += item.timeInPullRequestDays;
            closedBucket.completedCount += 1;
          }
        }
      }
    }

    return Array.from(bucket.values())
      .sort((a, b) => a.weekKey.localeCompare(b.weekKey))
      .map(row => ({
        weekKey: row.weekKey,
        period: formatWeekLabel(row.weekKey),
        avgCycleTimeDays: row.openedCount > 0 ? Math.round((row.openedTotalDays / row.openedCount) * 10) / 10 : null,
        completedAvgCycleTimeDays: row.completedCount > 0 ? Math.round((row.completedTotalDays / row.completedCount) * 10) / 10 : null,
        prCount: row.openedCount,
        completedPrCount: row.completedCount,
      }));
  }, [filteredPrTimeStats]);

  const eslintChartData = useMemo(() => {
    if (!eslintBurnDown?.snapshots.length) return [];
    return aggregateEslintBurnDown(eslintBurnDown.snapshots, eslintGranularity);
  }, [eslintBurnDown, eslintGranularity]);

  /** Dynamic plain-language synopsis of the PR cycle time trend for the info panel. */
  const prCycleTimeSynopsis = useMemo(() => {
    const data = prCycleTimeChartData;
    if (data.length < 2) return null;

    const n = data.length;

    const avgField = (
      slice: typeof data,
      field: 'avgCycleTimeDays' | 'completedAvgCycleTimeDays' | 'completedPrCount',
    ): number | null => {
      const vals = slice.map(d => d[field]).filter((v): v is number => v !== null);
      if (vals.length === 0) return null;
      return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
    };

    const recentSlice = data.slice(Math.max(0, n - 4));
    const priorSlice = data.slice(Math.max(0, n - 8), Math.max(0, n - 4));

    const recentOpened = avgField(recentSlice, 'avgCycleTimeDays');
    const priorOpened = avgField(priorSlice, 'avgCycleTimeDays');
    const recentCompleted = avgField(recentSlice, 'completedAvgCycleTimeDays');
    const priorCompleted = avgField(priorSlice, 'completedAvgCycleTimeDays');
    const recentThroughput = avgField(recentSlice, 'completedPrCount');
    const priorThroughput = avgField(priorSlice, 'completedPrCount');

    if (recentOpened === null && recentCompleted === null) return null;

    const dir = (recent: number | null, prior: number | null): 'up' | 'down' | 'flat' | 'unknown' => {
      if (recent === null || prior === null || prior === 0) return 'unknown';
      const pct = (recent - prior) / prior;
      if (pct > 0.05) return 'up';
      if (pct < -0.05) return 'down';
      return 'flat';
    };

    const openedDir = dir(recentOpened, priorOpened);
    const completedDir = dir(recentCompleted, priorCompleted);
    const throughputDir = dir(recentThroughput, priorThroughput);

    let headline = '';
    let detail = '';

    if (openedDir === 'down' && completedDir === 'up') {
      headline = 'New PRs are moving faster, but older slow PRs are still landing.';
      detail = `Opened PR cycle time has improved recently (${recentOpened?.toFixed(1)} days avg vs ${priorOpened?.toFixed(1)} days prior), indicating current work is moving faster. Completed PR cycle time remains elevated (${recentCompleted?.toFixed(1)} days), likely because slow PRs from earlier weeks are now merging. Expect completed avg to fall as that backlog clears.`;
    } else if (openedDir === 'down' && completedDir === 'down') {
      headline = 'PR cycle time is improving across the board — a positive signal.';
      detail = `Both lines are trending down. Opened PRs avg ${recentOpened?.toFixed(1)} days (was ${priorOpened?.toFixed(1)}); Completed PRs avg ${recentCompleted?.toFixed(1)} days (was ${priorCompleted?.toFixed(1)}). PRs are being reviewed and merged faster than the prior period.`;
    } else if (openedDir === 'up' && completedDir === 'up') {
      headline = 'PR cycle time is increasing — PRs are taking longer to get through review.';
      detail = `Opened PRs avg ${recentOpened?.toFixed(1)} days (was ${priorOpened?.toFixed(1)}); Completed PRs avg ${recentCompleted?.toFixed(1)} days (was ${priorCompleted?.toFixed(1)}). This may reflect larger PR sizes, reviewer bottlenecks, or process slowdowns worth investigating.`;
    } else if (openedDir === 'up' && completedDir === 'down') {
      headline = 'Old backlog is clearing, but newer PRs are taking longer to move.';
      detail = `Completed PR cycle time is improving (${recentCompleted?.toFixed(1)} days, down from ${priorCompleted?.toFixed(1)}), but opened PR cycle time is rising (${recentOpened?.toFixed(1)} days, up from ${priorOpened?.toFixed(1)}). Monitor whether recently opened PRs close quickly or continue to accumulate.`;
    } else if (openedDir === 'flat' && completedDir === 'flat') {
      headline = 'PR cycle time is holding steady — no significant change recently.';
      detail = `Opened PRs avg ${recentOpened?.toFixed(1)} days; Completed PRs avg ${recentCompleted?.toFixed(1)} days. Both lines are stable compared to the prior 4 weeks.`;
    } else {
      const parts: string[] = [];
      if (recentOpened !== null) parts.push(`Opened PRs avg ${recentOpened.toFixed(1)} days`);
      if (recentCompleted !== null) parts.push(`Completed PRs avg ${recentCompleted.toFixed(1)} days`);
      if (parts.length === 0) return null;
      headline = 'PR cycle time snapshot for the selected period.';
      detail = parts.join('; ') + '.';
    }

    if (throughputDir === 'up' && recentThroughput !== null) {
      detail += ` Throughput is up — averaging ${recentThroughput.toFixed(1)} PRs merged per week recently.`;
    } else if (throughputDir === 'down' && recentThroughput !== null) {
      detail += ` Throughput has slowed — averaging ${recentThroughput.toFixed(1)} PRs merged per week recently.`;
    } else if (recentThroughput !== null) {
      detail += ` Throughput is steady at ~${recentThroughput.toFixed(1)} PRs merged per week.`;
    }

    return { headline, detail };
  }, [prCycleTimeChartData]);

  /** Weekly work item counts split by whether the current item has the ai-code tag. */
  const aiCodeTagChartData = useMemo(() => {
    const selectedTeamDef = teams.find(t => t.id === selectedTeam);
    const fromDate = timeFrame === 'custom'
      ? customFromDate
      : (() => {
        const from = new Date();
        from.setDate(from.getDate() - parseInt(timeFrame));
        return from.toISOString().split('T')[0];
      })();
    const toDate = timeFrame === 'custom'
      ? customToDate
      : new Date().toISOString().split('T')[0];
    const bucket = new Map<string, { weekKey: string; aiCodeCount: number; nonAiCodeCount: number }>();

    const hasAiCodeTag = (tags?: string) => (tags ?? '')
      .split(';')
      .map(tag => tag.trim().toLowerCase())
      .includes('ai-code');
    const inProgressOrLaterStates = new Set([
      'active',
      'committed',
      'in progress',
      'in pull request',
      'ready for test',
      'in test',
      'uat - ready for test',
      'uat ready for test',
      'uat-ready for test',
      'uat - test done',
      'ready for release',
      'done',
      'closed',
      'resolved',
    ]);

    for (const item of workItems) {
      if (!inProgressOrLaterStates.has(item.state.toLowerCase())) continue;
      if (selectedDeveloper !== 'all' && item.assignedTo !== selectedDeveloper) continue;
      if (activeMemberSet && item.assignedTo && !activeMemberSet.has(item.assignedTo)) continue;
      if (selectedTeamDef?.areaPath && !item.areaPath.startsWith(selectedTeamDef.areaPath)) continue;

      const dateString = item.changedDate || item.createdDate;
      const day = parseStatDay(dateString);
      if (!day) continue;
      const dayKey = dateString.slice(0, 10);
      if (fromDate && dayKey < fromDate) continue;
      if (toDate && dayKey > toDate) continue;

      const weekKey = weekStartMondayKey(day);
      const cur = bucket.get(weekKey) ?? { weekKey, aiCodeCount: 0, nonAiCodeCount: 0 };
      if (hasAiCodeTag(item.tags)) {
        cur.aiCodeCount += 1;
      } else {
        cur.nonAiCodeCount += 1;
      }
      bucket.set(weekKey, cur);
    }

    return Array.from(bucket.values())
      .sort((a, b) => a.weekKey.localeCompare(b.weekKey))
      .map(row => ({
        weekKey: row.weekKey,
        period: formatWeekLabel(row.weekKey),
        aiCodeCount: row.aiCodeCount,
        nonAiCodeCount: row.nonAiCodeCount,
      }));
  }, [activeMemberSet, customFromDate, customToDate, selectedDeveloper, selectedTeam, teams, timeFrame, workItems]);

  // Build a minimal WorkItem stub from stats data when the item isn't in the
  // currently loaded workItems array (e.g. different date range / area path).
  // The DetailsPanel uses workItem.id for its own API calls, so this is enough
  // to open the panel and load full details on demand.
  const resolveWorkItem = (id: number, title: string, workItemType?: string): WorkItem => {
    return workItems.find(wi => wi.id === id) ?? {
      id,
      title,
      state: '',
      workItemType: workItemType ?? '',
      changedDate: '',
      createdDate: '',
      areaPath: '',
      iterationPath: '',
    };
  };

  const getVoteLabel = (vote: number): { label: string; className: string } => {
    switch (vote) {
      case 10:  return { label: 'Approved', className: 'vote-approved' };
      case -10: return { label: 'Rejected', className: 'vote-rejected' };
      default:  return { label: '', className: 'vote-none' };
    }
  };

  const getWorkItemTypeIcon = (type: string): string => {
    switch (type) {
      case 'Product Backlog Item': return '📋';
      case 'Technical Backlog Item': return '🔧';
      case 'Bug': return '🐛';
      default: return '📄';
    }
  };

  return (
    <div className="dev-stats-container">
      <h2>Developer Statistics</h2>
      
      <div className="filter-controls">
        <div className="filter-row">
          <div className="filter-group">
            <label htmlFor="team-filter">Team:</label>
            <select 
              id="team-filter"
              value={selectedTeam} 
              onChange={(e) => {
                setSelectedTeam(e.target.value);
                setSelectedDeveloper('all'); // Reset developer filter when team changes
              }}
              className="filter-select"
            >
              {teams.map(team => (
                <option key={team.id} value={team.id}>{team.name}</option>
              ))}
            </select>
          </div>

          <div className="filter-group">
            <label htmlFor="developer-filter">Developer:</label>
            <select 
              id="developer-filter"
              value={selectedDeveloper} 
              onChange={(e) => setSelectedDeveloper(e.target.value)}
              className="filter-select"
              disabled={loadingMembers}
            >
              <option value="all">
                {selectedTeam === 'all' ? 'All Developers' : 'All Team Members'}
              </option>
              {dropdownDevelopers.map(dev => (
                <option key={dev} value={dev}>{dev}</option>
              ))}
            </select>
          </div>
          
          <div className="filter-group">
            <label htmlFor="timeframe-filter">Time Frame:</label>
            <select 
              id="timeframe-filter"
              value={timeFrame} 
              onChange={(e) => setTimeFrame(e.target.value)}
              className="filter-select"
            >
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="60">Last 60 days</option>
              <option value="90">Last 90 days</option>
              <option value="180">Last 6 months</option>
              <option value="365">Last year</option>
              <option value="custom">Custom Range</option>
            </select>
          </div>
        </div>
        
        {timeFrame === 'custom' && (
          <div className="filter-row">
            <div className="filter-group">
              <label htmlFor="from-date">From:</label>
              <input 
                id="from-date"
                type="date" 
                value={customFromDate} 
                onChange={(e) => setCustomFromDate(e.target.value)}
                className="filter-input"
              />
            </div>
            
            <div className="filter-group">
              <label htmlFor="to-date">To:</label>
              <input 
                id="to-date"
                type="date" 
                value={customToDate} 
                onChange={(e) => setCustomToDate(e.target.value)}
                className="filter-input"
              />
            </div>
          </div>
        )}
      </div>

      <div className="stats-tabs" role="tablist" aria-label="Developer statistics metric groups">
        <button
          type="button"
          className={`stats-tab ${activeStatsTab === 'ai' ? 'active' : ''}`}
          onClick={() => setActiveStatsTab('ai')}
          role="tab"
          aria-selected={activeStatsTab === 'ai'}
        >
          AI Metrics
        </button>
        <button
          type="button"
          className={`stats-tab ${activeStatsTab === 'other' ? 'active' : ''}`}
          onClick={() => setActiveStatsTab('other')}
          role="tab"
          aria-selected={activeStatsTab === 'other'}
        >
          Other Metrics
        </button>
      </div>

      <div style={{ display: activeStatsTab === 'ai' ? '' : 'none' }}>
        <AiCapabilityLadderSection
          fromDate={
            timeFrame === 'custom' && customFromDate
              ? customFromDate
              : (() => { const d = new Date(); d.setDate(d.getDate() - parseInt(timeFrame || '30', 10)); return d.toISOString().split('T')[0]!; })()
          }
          toDate={
            timeFrame === 'custom' && customToDate
              ? customToDate
              : new Date().toISOString().split('T')[0]!
          }
          areaPath={teams.find(t => t.id === selectedTeam)?.areaPath || undefined}
        />
      </div>

      {activeStatsTab === 'ai' && (
      <div className="stats-section eslint-section">
        <h3>
          <button
            type="button"
            className="collapse-button"
            onClick={() => setIsEslintCollapsed(!isEslintCollapsed)}
            aria-label={isEslintCollapsed ? 'Expand section' : 'Collapse section'}
          >
            {isEslintCollapsed ? '▶' : '▼'}
          </button>
          MaxView ESLint Burn-down
          <div
            className="info-icon"
            onClick={() => setShowEslintInfo(!showEslintInfo)}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setShowEslintInfo(!showEslintInfo);
              }
            }}
            role="button"
            tabIndex={0}
            aria-label="Show information about this section"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z" />
              <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z" />
            </svg>
          </div>
        </h3>

        {showEslintInfo && (
          <div className="info-tooltip">
            <button type="button" className="info-close" onClick={() => setShowEslintInfo(false)} aria-label="Close information">
              ×
            </button>
            <p>
              <strong>What this section shows:</strong>
              <br />
              ESLint issue counts from the nightly <code>mv-nightly-runs-workflow</code> pipeline artifact (<code>eslint-summary.json</code>).
              Each point is the latest run in that period where the artifact was published — pipeline pass/fail (red X) does not matter, only that the file exists.
            </p>
            <p>
              <strong>How to interpret:</strong>
              <br />
              Use <strong>Weekly</strong> during active cleanup sprints, <strong>Monthly</strong> for steady progress reviews, and <strong>Quarterly</strong> for longer-term reporting.
              The date range follows the Time Frame filter at the top of this page.
            </p>
          </div>
        )}

        {!isEslintCollapsed && (
          <div className="filter-actions eslint-filter-actions">
            <div className="filter-group">
              <label htmlFor="eslint-granularity">View by:</label>
              <select
                id="eslint-granularity"
                value={eslintGranularity}
                onChange={e => setEslintGranularity(e.target.value as EslintBurnDownGranularity)}
                className="filter-select"
              >
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
              </select>
            </div>
            <button
              type="button"
              onClick={fetchEslintBurnDown}
              disabled={eslintLoading || (timeFrame === 'custom' && (!customFromDate || !customToDate))}
              className="load-stats-button"
            >
              {eslintLoading ? 'Loading...' : eslintHasLoaded ? 'Refresh ESLint Burn-down' : 'Load ESLint Burn-down'}
            </button>
          </div>
        )}

        {!isEslintCollapsed && (showEslintNotification || eslintLoading) && (
          <div className={`background-notification ${eslintLoading ? 'loading' : eslintError ? 'error' : 'success'}`}>
            {eslintLoading && <div className="notification-spinner"></div>}
            <span className="notification-text">{eslintLoading ? 'Loading MaxView ESLint burn-down from pipeline artifacts...' : eslintNotificationMessage}</span>
            {!eslintLoading && (
              <button
                className="notification-close"
                onClick={() => setShowEslintNotification(false)}
                aria-label="Close notification"
              >
                ×
              </button>
            )}
          </div>
        )}

        {!isEslintCollapsed && !eslintHasLoaded && !eslintLoading && (
          <p className="placeholder-text">
            Click <strong>Load ESLint Burn-down</strong> to pull nightly pipeline artifacts for the selected time frame.
          </p>
        )}

        {!isEslintCollapsed && eslintHasLoaded && eslintBurnDown && (
          <div className="eslint-summary">
            <div className="eslint-summary-header">
              <div>
                <div className="eslint-summary-title">
                  {eslintBurnDown.latest?.issueCount.toLocaleString() ?? '—'} current issue{(eslintBurnDown.latest?.issueCount ?? 0) === 1 ? '' : 's'}
                </div>
                <div className="eslint-summary-meta">
                  {eslintBurnDown.definitionName} · build {eslintBurnDown.latest?.buildNumber ?? '—'} ·{' '}
                  {eslintBurnDown.latest ? new Date(eslintBurnDown.latest.capturedAt).toLocaleString() : 'No artifact data'}
                </div>
                {eslintBurnDown.summary.issueReduction !== null && eslintBurnDown.summary.startingIssueCount !== null && (
                  <div className="eslint-summary-delta">
                    {eslintBurnDown.summary.issueReduction >= 0 ? '▼' : '▲'} {Math.abs(eslintBurnDown.summary.issueReduction).toLocaleString()} issues
                    {eslintBurnDown.summary.reductionPercent !== null ? ` (${eslintBurnDown.summary.reductionPercent}%)` : ''} since {eslintBurnDown.from}
                  </div>
                )}
              </div>
              <div className={`eslint-health-badge ${(eslintBurnDown.latest?.totalErrors ?? 0) > 0 ? 'has-errors' : (eslintBurnDown.latest?.totalWarnings ?? 0) > 0 ? 'has-warnings' : 'clean'}`}>
                {(eslintBurnDown.latest?.totalErrors ?? 0) > 0 ? 'Errors found' : (eslintBurnDown.latest?.totalWarnings ?? 0) > 0 ? 'Warnings only' : 'Clean'}
              </div>
            </div>

            <div className="eslint-metric-grid">
              <div className="eslint-metric-card">
                <span className="eslint-metric-value">{eslintBurnDown.latest?.totalErrors.toLocaleString() ?? '—'}</span>
                <span className="eslint-metric-label">Errors</span>
              </div>
              <div className="eslint-metric-card">
                <span className="eslint-metric-value">{eslintBurnDown.latest?.totalWarnings.toLocaleString() ?? '—'}</span>
                <span className="eslint-metric-label">Warnings</span>
              </div>
              <div className="eslint-metric-card">
                <span className="eslint-metric-value">{eslintBurnDown.latest?.fixableCount.toLocaleString() ?? '—'}</span>
                <span className="eslint-metric-label">Auto-fixable</span>
              </div>
              <div className="eslint-metric-card">
                <span className="eslint-metric-value">{eslintBurnDown.latest?.filesWithProblems.toLocaleString() ?? '—'}</span>
                <span className="eslint-metric-label">Files with issues</span>
              </div>
            </div>

            <div className="eslint-run-meta">
              {eslintBurnDown.summary.buildsWithArtifact} run{eslintBurnDown.summary.buildsWithArtifact === 1 ? '' : 's'} with eslint-summary.json
              {' '}({eslintBurnDown.summary.buildsScanned} pipeline runs checked, {eslintBurnDown.from} to {eslintBurnDown.to})
            </div>

            {eslintChartData.length === 0 ? (
              <p className="placeholder-text">
                {eslintBurnDown.summary.hint ??
                  'No ESLint pipeline artifacts found in the selected date range.'}
              </p>
            ) : (
              <div className="eslint-burndown-chart-container" aria-label="ESLint issue burn-down line chart">
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={eslintChartData} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
                    <CartesianGrid stroke="var(--border-color)" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="periodLabel"
                      tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                      interval="preserveStartEnd"
                      angle={-30}
                      textAnchor="end"
                      height={56}
                    />
                    <YAxis
                      allowDecimals={false}
                      tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                      width={56}
                      tickFormatter={value => Number(value).toLocaleString()}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'var(--card-bg)',
                        border: '1px solid var(--border-color)',
                        borderRadius: 8,
                        color: 'var(--text-primary)',
                      }}
                      labelFormatter={(_label, payload) => {
                        const point = payload?.[0]?.payload as EslintBurnDownPoint | undefined;
                        if (!point) return '';
                        return `${point.periodLabel} · build ${point.buildNumber}`;
                      }}
                      formatter={(value, name) => [Number(value).toLocaleString(), name]}
                    />
                    <Legend wrapperStyle={{ color: 'var(--text-primary)' }} />
                    <Line type="monotone" dataKey="totalErrors" name="Errors" stroke="#e74c3c" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                    <Line type="monotone" dataKey="totalWarnings" name="Warnings" stroke="#f39c12" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                    <Line type="monotone" dataKey="filesWithProblems" name="Files with issues" stroke="var(--accent-color)" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        )}
      </div>
      )}

      {activeStatsTab === 'ai' && (
      <div className="stats-section ai-adoption-section">
        <h3>
          <button
            type="button"
            className="collapse-button"
            onClick={() => setIsAiAdoptionCollapsed(!isAiAdoptionCollapsed)}
            aria-label={isAiAdoptionCollapsed ? 'Expand section' : 'Collapse section'}
          >
            {isAiAdoptionCollapsed ? '▶' : '▼'}
          </button>
          AI Skill Usage Trends
          <div
            className="info-icon"
            onClick={() => setShowAiAdoptionInfo(!showAiAdoptionInfo)}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setShowAiAdoptionInfo(!showAiAdoptionInfo);
              }
            }}
            role="button"
            tabIndex={0}
            aria-label="Show information about this section"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z" />
              <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z" />
            </svg>
          </div>
        </h3>

        {showAiAdoptionInfo && (
          <div className="info-tooltip">
            <button type="button" className="info-close" onClick={() => setShowAiAdoptionInfo(false)} aria-label="Close information">
              ×
            </button>
            <p>
              <strong>What this section shows:</strong>
              <br />
              High-level weekly usage of <strong>Design Doc Kickoff</strong> (design-doc commits linked to work items) and{' '}
              <strong>PR comment resolutions</strong> (agent-evals metrics per PR), using the same team, developer, and date filters as the rest of this page.
            </p>
            <p>
              <strong>How to interpret:</strong>
              <br />
              Each point is a calendar week (Monday–Sunday). Lines show event counts in that week after filters are applied — not adoption %.
            </p>
            <p>
              <strong>Note:</strong> Use the load button here to fetch the underlying kickoff and PR resolution data directly. Detailed grids live in Other Metrics.
            </p>
          </div>
        )}

        {!isAiAdoptionCollapsed && (
          <div className="filter-actions">
            <button
              type="button"
              onClick={refreshAiAdoptionTrends}
              disabled={kickoffLoading || prResolutionLoading || (timeFrame === 'custom' && (!customFromDate || !customToDate))}
              className="load-stats-button"
            >
              {kickoffLoading || prResolutionLoading
                ? 'Loading...'
                : kickoffHasLoaded || prResolutionHasLoaded
                  ? 'Refresh AI Skill Trends'
                  : 'Load AI Skill Trends'}
            </button>
          </div>
        )}

        {!isAiAdoptionCollapsed && (kickoffLoading || prResolutionLoading || showKickoffNotification || showPrResolutionNotification) && (
          <div className={`background-notification ${kickoffLoading || prResolutionLoading ? 'loading' : kickoffError || prResolutionError ? 'error' : 'success'}`}>
            {(kickoffLoading || prResolutionLoading) && <div className="notification-spinner"></div>}
            <span className="notification-text">
              {kickoffLoading || prResolutionLoading
                ? 'Loading AI skill trend data in background...'
                : kickoffError || prResolutionError
                  ? `Error: ${kickoffError ?? prResolutionError}`
                  : 'AI skill trend data loaded successfully!'}
            </span>
            {!kickoffLoading && !prResolutionLoading && (
              <button
                className="notification-close"
                onClick={() => {
                  setShowKickoffNotification(false);
                  setShowPrResolutionNotification(false);
                }}
                aria-label="Close notification"
              >
                ×
              </button>
            )}
          </div>
        )}

        {!isAiAdoptionCollapsed && (!kickoffHasLoaded || !prResolutionHasLoaded) && !kickoffLoading && !prResolutionLoading && (
          <p className="placeholder-text">
            Click <strong>Load AI Skill Trends</strong> to load both <strong>Design Doc Kickoff</strong> and <strong>PR comment resolutions</strong> data. Current: Design Doc Kickoff{' '}
            {kickoffHasLoaded ? 'loaded' : 'not loaded'}, PR resolutions {prResolutionHasLoaded ? 'loaded' : 'not loaded'}.
          </p>
        )}

        {!isAiAdoptionCollapsed && kickoffHasLoaded && prResolutionHasLoaded && aiAdoptionChartData.length === 0 && (
          <p className="placeholder-text">No kickoff or PR resolution events in the selected range for the current filters.</p>
        )}

        {!isAiAdoptionCollapsed && kickoffHasLoaded && prResolutionHasLoaded && aiAdoptionChartData.length > 0 && (
          <div className="ai-adoption-chart-container" aria-label="AI skill usage weekly line chart">
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={aiAdoptionChartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                <CartesianGrid stroke="var(--border-color)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="weekKey"
                  tickFormatter={wk => formatWeekLabel(wk)}
                  tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                  interval="preserveStartEnd"
                  angle={-30}
                  textAnchor="end"
                  height={56}
                />
                <YAxis allowDecimals={false} tick={{ fill: 'var(--text-secondary)', fontSize: 11 }} width={36} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'var(--card-bg)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 8,
                    color: 'var(--text-primary)',
                  }}
                  labelFormatter={wk => `Week of ${formatWeekLabel(String(wk))}`}
                />
                <Legend wrapperStyle={{ color: 'var(--text-primary)' }} />
                <Line type="monotone" dataKey="designDocCount" name="Design doc kickoffs" stroke="var(--accent-color)" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                <Line type="monotone" dataKey="prResolutionCount" name="PR resolutions" stroke="var(--text-secondary)" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
      )}

      {activeStatsTab === 'ai' && (
      <div className="stats-section pr-cycle-section">
        <h3>
          <button
            type="button"
            className="collapse-button"
            onClick={() => setIsPrCycleCollapsed(!isPrCycleCollapsed)}
            aria-label={isPrCycleCollapsed ? 'Expand section' : 'Collapse section'}
          >
            {isPrCycleCollapsed ? '▶' : '▼'}
          </button>
          PR Cycle Time Trend
          <div
            className="info-icon"
            onClick={() => setShowPrCycleInfo(!showPrCycleInfo)}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setShowPrCycleInfo(!showPrCycleInfo);
              }
            }}
            role="button"
            tabIndex={0}
            aria-label="Show information about this section"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z" />
              <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z" />
            </svg>
          </div>
        </h3>

        {showPrCycleInfo && (
          <div className="info-tooltip">
            <button type="button" className="info-close" onClick={() => setShowPrCycleInfo(false)} aria-label="Close information">
              ×
            </button>
            <p>
              <strong>What this section shows:</strong>
              <br />
              Weekly average time PRs spent open (from creation to merge) for the developers and time frame selected. As the team uses AI more, you should see this trend decrease.
            </p>
            {prCycleTimeSynopsis && (
              <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '10px 14px', margin: '8px 0' }}>
                <p style={{ margin: '0 0 6px 0' }}>
                  <strong>Current snapshot:</strong> {prCycleTimeSynopsis.headline}
                </p>
                <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.875em' }}>
                  {prCycleTimeSynopsis.detail}
                </p>
              </div>
            )}
            <p>
              <strong>How to interpret:</strong>
              <br />
              Each point represents a calendar week (Monday–Sunday). The chart tracks three signals:
            </p>
            <ul>
              <li>
                <strong>Opened PRs avg (days):</strong> Grouped by the week each PR was <em>created</em>. Includes both active (still open) and completed PRs — active PRs are measured from creation to today, so this line can rise when PRs sit unmerged. Use it to spot trends in how long newly-opened work is taking.
              </li>
              <li>
                <strong>Completed PRs avg (days):</strong> Grouped by the week each PR was <em>merged or closed</em>. Only includes finished work, so this is the most accurate measure of actual cycle time. Use it to evaluate true delivery speed over time.
              </li>
              <li>
                <strong>Completed PRs merged (count):</strong> The number of PRs that closed in each week, shown on the right axis. Use this alongside the averages to understand whether a spike in cycle time reflects a few slow PRs or a broad slowdown.
              </li>
            </ul>
            <p>
              <strong>Note:</strong> This chart uses the same underlying PR Time data as the Pull Request Time section. Use the load button here to fetch it directly.
            </p>
          </div>
        )}

        {!isPrCycleCollapsed && (
          <div className="filter-actions">
            <button
              type="button"
              onClick={fetchPullRequestTimeStats}
              disabled={prTimeLoading || (timeFrame === 'custom' && (!customFromDate || !customToDate))}
              className="load-stats-button"
            >
              {prTimeLoading ? 'Loading...' : prTimeHasLoaded ? 'Refresh PR Cycle Trend' : 'Load PR Cycle Trend'}
            </button>
          </div>
        )}

        {!isPrCycleCollapsed && (showPrTimeNotification || prTimeLoading) && (
          <div className={`background-notification ${prTimeLoading ? 'loading' : prTimeError ? 'error' : 'success'}`}>
            {prTimeLoading && <div className="notification-spinner"></div>}
            <span className="notification-text">{prTimeLoading ? 'Loading pull request time statistics in background...' : prTimeNotificationMessage}</span>
            {!prTimeLoading && (
              <button
                className="notification-close"
                onClick={() => setShowPrTimeNotification(false)}
                aria-label="Close notification"
              >
                ×
              </button>
            )}
          </div>
        )}

        {!isPrCycleCollapsed && !prTimeHasLoaded && !prTimeLoading && (
          <p className="placeholder-text">
            Click <strong>Load PR Cycle Trend</strong> to fetch PR cycle-time data for the selected filters.
          </p>
        )}

        {!isPrCycleCollapsed && prTimeHasLoaded && prCycleTimeChartData.length === 0 && (
          <p className="placeholder-text">No PR cycle-time data found for the selected filters.</p>
        )}

        {!isPrCycleCollapsed && prTimeHasLoaded && prCycleTimeChartData.length > 0 && (
          <div className="pr-cycle-chart-container" aria-label="PR cycle time weekly trend line chart">
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={prCycleTimeChartData} margin={{ top: 8, right: 48, left: 0, bottom: 8 }}>
                <CartesianGrid stroke="var(--border-color)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="weekKey"
                  tickFormatter={wk => formatWeekLabel(wk)}
                  tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                  interval="preserveStartEnd"
                  angle={-30}
                  textAnchor="end"
                  height={56}
                />
                {/* Left axis — cycle time in days */}
                <YAxis
                  yAxisId="days"
                  allowDecimals={true}
                  tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                  width={42}
                  tickFormatter={v => `${v}d`}
                />
                {/* Right axis — PR count */}
                <YAxis
                  yAxisId="count"
                  orientation="right"
                  allowDecimals={false}
                  tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                  width={36}
                  tickFormatter={v => String(v)}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'var(--card-bg)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 8,
                    color: 'var(--text-primary)',
                  }}
                  labelFormatter={wk => `Week of ${formatWeekLabel(String(wk))}`}
                  formatter={(value, name) => {
                    if (name === 'Completed PRs merged') return [value != null ? `${value} PRs` : '—', name];
                    return [value != null ? `${value} days` : '—', name];
                  }}
                />
                <Legend wrapperStyle={{ color: 'var(--text-primary)' }} />
                <Line
                  yAxisId="days"
                  type="monotone"
                  dataKey="avgCycleTimeDays"
                  name="Opened PRs avg (days)"
                  stroke="var(--accent-color)"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                  connectNulls
                />
                <Line
                  yAxisId="days"
                  type="monotone"
                  dataKey="completedAvgCycleTimeDays"
                  name="Completed PRs avg (days)"
                  stroke="var(--text-secondary)"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                  connectNulls
                />
                <Line
                  yAxisId="count"
                  type="monotone"
                  dataKey="completedPrCount"
                  name="Completed PRs merged"
                  stroke="var(--error-color)"
                  strokeWidth={2}
                  strokeDasharray="5 3"
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
      )}

      {activeStatsTab === 'ai' && (
      <div className="stats-section ai-code-tag-section">
        <h3>
          <button
            type="button"
            className="collapse-button"
            onClick={() => setIsAiCodeTagCollapsed(!isAiCodeTagCollapsed)}
            aria-label={isAiCodeTagCollapsed ? 'Expand section' : 'Collapse section'}
          >
            {isAiCodeTagCollapsed ? '▶' : '▼'}
          </button>
          AI Code Tag Trend
          <div
            className="info-icon"
            onClick={() => setShowAiCodeTagInfo(!showAiCodeTagInfo)}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setShowAiCodeTagInfo(!showAiCodeTagInfo);
              }
            }}
            role="button"
            tabIndex={0}
            aria-label="Show information about this section"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z" />
              <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z" />
            </svg>
          </div>
        </h3>

        {showAiCodeTagInfo && (
          <div className="info-tooltip">
            <button type="button" className="info-close" onClick={() => setShowAiCodeTagInfo(false)} aria-label="Close information">
              ×
            </button>
            <p>
              <strong>What this section shows:</strong>
              <br />
              Weekly counts for work items that have reached an in-progress-or-later state, split by whether the current work item has the <code>ai-code</code> tag.
            </p>
            <p>
              <strong>How to interpret:</strong>
              <br />
              Each point is grouped by the work item's latest changed date. As AI-assisted coding becomes more common, the <strong>ai-code tagged</strong> line should trend up while <strong>without ai-code</strong> trends down.
            </p>
          </div>
        )}

        {!isAiCodeTagCollapsed && aiCodeTagChartData.length === 0 && (
          <p className="placeholder-text">No in-progress-or-later work items found for the selected filters and time frame.</p>
        )}

        {!isAiCodeTagCollapsed && aiCodeTagChartData.length > 0 && (
          <div className="ai-code-tag-chart-container" aria-label="AI code tag weekly trend line chart">
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={aiCodeTagChartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                <CartesianGrid stroke="var(--border-color)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="weekKey"
                  tickFormatter={wk => formatWeekLabel(wk)}
                  tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                  interval="preserveStartEnd"
                  angle={-30}
                  textAnchor="end"
                  height={56}
                />
                <YAxis allowDecimals={false} tick={{ fill: 'var(--text-secondary)', fontSize: 11 }} width={36} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'var(--card-bg)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 8,
                    color: 'var(--text-primary)',
                  }}
                  labelFormatter={wk => `Week of ${formatWeekLabel(String(wk))}`}
                  formatter={(value, name) => [value != null ? `${value} work items` : '—', name]}
                />
                <Legend wrapperStyle={{ color: 'var(--text-primary)' }} />
                <Line type="monotone" dataKey="aiCodeCount" name="ai-code tagged" stroke="var(--accent-color)" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                <Line type="monotone" dataKey="nonAiCodeCount" name="without ai-code" stroke="var(--text-secondary)" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
      )}

      {activeStatsTab === 'other' && (
      <div className="stats-section">
        <h3>          <button 
            className="collapse-button"
            onClick={() => setIsChangesCollapsed(!isChangesCollapsed)}
            aria-label={isChangesCollapsed ? 'Expand section' : 'Collapse section'}
          >
            {isChangesCollapsed ? '▶' : '▼'}
          </button>          Due Date Changes by Developer
          <div 
            className="info-icon" 
            onClick={() => setShowChangesInfo(!showChangesInfo)}
            role="button"
            aria-label="Show information about this section"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
              <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
            </svg>
          </div>
        </h3>
        
        {showChangesInfo && (
          <div className="info-tooltip">
            <button 
              className="info-close" 
              onClick={() => setShowChangesInfo(false)}
              aria-label="Close information"
            >
              ×
            </button>
            <p>
              <strong>What this section shows:</strong><br />
              How many times due dates were changed on PBIs, TBIs, and Bugs owned by each developer.
              Each change is counted against whoever was the <em>assigned owner</em> of the work item at the time the due date was modified — regardless of who made the change.
            </p>
            <p>
              <strong>How to interpret:</strong><br />
              • <strong>Bar width:</strong> Relative number of changes compared to the developer with the most changes<br />
              • <strong>Total Changes:</strong> Total due date changes on items owned by this developer<br />
              • <strong>Reasons:</strong> Breakdown of why due dates were changed
            </p>
          </div>
        )}
        
        {!isChangesCollapsed && (
          <div className="filter-actions">
            <button 
              onClick={fetchDueDateStats} 
              disabled={loading || (timeFrame === 'custom' && (!customFromDate || !customToDate))}
              className="load-stats-button"
            >
              {loading ? 'Loading...' : hasLoaded ? 'Refresh Statistics' : 'Load Statistics'}
            </button>
          </div>
        )}
        
        {!isChangesCollapsed && (showNotification || loading) && (
          <div className={`background-notification ${loading ? 'loading' : error ? 'error' : 'success'}`}>
            {loading && <div className="notification-spinner"></div>}
            <span className="notification-text">{loading ? 'Loading statistics in background...' : notificationMessage}</span>
            {!loading && (
              <button 
                className="notification-close" 
                onClick={() => setShowNotification(false)}
                aria-label="Close notification"
              >
                ×
              </button>
            )}
          </div>
        )}
        
        {!isChangesCollapsed && !hasLoaded && !loading && (
          <p className="placeholder-text">Select filters and click "Load Statistics" to view due date change statistics.</p>
        )}
        
        {!isChangesCollapsed && hasLoaded && !loading && filteredStats.length === 0 && (
          <p className="placeholder-text">No due date changes found for the selected filters.</p>
        )}
        
        {!isChangesCollapsed && hasLoaded && !loading && filteredStats.length > 0 && (() => {
          // Pre-compute per-developer filtered reasons and totals (excluding Initialize entries)
          const cardsData = filteredStats.map(devStats => {
            const filteredReasons = Object.entries(devStats.reasonBreakdown)
              .filter(([reason]) => !/^initializ/i.test(reason));
            const displayTotal = filteredReasons.reduce((sum, [, c]) => sum + c, 0);
            return { devStats, filteredReasons, displayTotal };
          });
          const maxChanges = cardsData.reduce((m, { displayTotal }) => Math.max(m, displayTotal), 0);

          return (
            <div className="developer-stats-list">
              {cardsData.map(({ devStats, filteredReasons, displayTotal }, index) => {
                const devKey = `changes-${devStats.developer}`;
                const isCollapsed = collapsedReasons.has(devKey);
                const barPct = maxChanges > 0 ? (displayTotal / maxChanges) * 100 : 0;
                
                return (
                  <div key={index} className="developer-stat-card">
                    <div className="developer-header">
                      <span className="developer-name">{devStats.developer}</span>
                      <span className="total-changes">{displayTotal} changes</span>
                    </div>

                    <div className="changes-bar-container">
                      <div
                        className="changes-bar"
                        style={{ width: `${barPct}%` }}
                        title={`${displayTotal} due date change${displayTotal !== 1 ? 's' : ''}`}
                      >
                        {barPct > 20 && <span className="changes-bar-label">{displayTotal}</span>}
                      </div>
                    </div>
                    
                    <div className="reason-breakdown">
                      <h4>
                        <button 
                          className="collapse-button-small"
                          onClick={() => {
                            const newSet = new Set(collapsedReasons);
                            if (isCollapsed) {
                              newSet.delete(devKey);
                            } else {
                              newSet.add(devKey);
                            }
                            setCollapsedReasons(newSet);
                          }}
                          aria-label={isCollapsed ? 'Expand reasons' : 'Collapse reasons'}
                        >
                          {isCollapsed ? '▶' : '▼'}
                        </button>
                        Reasons:
                      </h4>
                      {!isCollapsed && (
                        <ul className="reason-list">
                          {filteredReasons
                            .sort(([, a], [, b]) => b - a)
                            .map(([reason, count], idx) => {
                              const reasonPct = displayTotal > 0 ? (count / displayTotal) * 100 : 0;
                              return (
                                <li key={idx} className="reason-item">
                                  <span className="reason-text">{reason}</span>
                                  <div className="reason-bar-wrap">
                                    <div className="reason-bar" style={{ width: `${reasonPct}%` }} />
                                  </div>
                                  <span className="reason-count">{count}</span>
                                </li>
                              );
                            })}
                        </ul>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()}
      </div>
      )}

      {activeStatsTab === 'other' && (
      <div className="stats-section">
        <h3>
          <button 
            className="collapse-button"
            onClick={() => setIsHitRateCollapsed(!isHitRateCollapsed)}
            aria-label={isHitRateCollapsed ? 'Expand section' : 'Collapse section'}
          >
            {isHitRateCollapsed ? '▶' : '▼'}
          </button>
          Due Date Hit Rate
          <div 
            className="info-icon" 
            onClick={() => setShowHitRateInfo(!showHitRateInfo)}
            role="button"
            aria-label="Show information about this section"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
              <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
            </svg>
          </div>
        </h3>
        
        {showHitRateInfo && (
          <div className="info-tooltip">
            <button 
              className="info-close" 
              onClick={() => setShowHitRateInfo(false)}
              aria-label="Close information"
            >
              ×
            </button>
            <p>
              <strong>What this section shows:</strong><br />
              Whether developers completed work items on or before their due dates without changing the due date.
            </p>
            <p>
              <strong>How to interpret:</strong><br />
              • <strong>No Changes (Hit):</strong> Work items that transitioned from working states (In Progress, Committed, In Pull Request) to completion 
              (Ready for Test, In Test, or Done) on or before the due date with no due date changes<br />
              • <strong>Missed Due Date:</strong> Work items that had due date changes OR completed after the due date<br />
              • <strong>Hit Rate %:</strong> Percentage of work items completed on time without date changes
            </p>
            <p>
              <strong>Note:</strong> Work items still in progress with future due dates and no changes are not counted 
              as hits or misses - they're included in total work items but are pending completion.
            </p>
          </div>
        )}
        
        {!isHitRateCollapsed && (
          <div className="filter-actions">
            <button 
              onClick={fetchDueDateHitRate} 
              disabled={hitRateLoading || (timeFrame === 'custom' && (!customFromDate || !customToDate))}
              className="load-stats-button"
            >
              {hitRateLoading ? 'Loading...' : hitRateHasLoaded ? 'Refresh Hit Rate' : 'Load Hit Rate'}
            </button>
          </div>
        )}
        
        {!isHitRateCollapsed && (showHitRateNotification || hitRateLoading) && (
          <div className={`background-notification ${hitRateLoading ? 'loading' : hitRateError ? 'error' : 'success'}`}>
            {hitRateLoading && <div className="notification-spinner"></div>}
            <span className="notification-text">{hitRateLoading ? 'Loading hit rate statistics in background...' : hitRateNotificationMessage}</span>
            {!hitRateLoading && (
              <button 
                className="notification-close" 
                onClick={() => setShowHitRateNotification(false)}
                aria-label="Close notification"
              >
                ×
              </button>
            )}
          </div>
        )}
        
        {!isHitRateCollapsed && !hitRateHasLoaded && !hitRateLoading && (
          <p className="placeholder-text">Click "Load Hit Rate" to view statistics on due date changes per developer.</p>
        )}
        
        {!isHitRateCollapsed && hitRateHasLoaded && !hitRateLoading && filteredHitRateStats.length === 0 && (
          <p className="placeholder-text">No work items with due dates found for the selected filters.</p>
        )}
        
        {!isHitRateCollapsed && hitRateHasLoaded && !hitRateLoading && filteredHitRateStats.length > 0 && (
          <div className="developer-stats-list">
            {filteredHitRateStats.map((stats, index) => {
              
              return (
                <div key={index} className="developer-stat-card">
                  <div className="developer-header">
                    <span className="developer-name">{stats.developer}</span>
                    <span className="total-changes">{stats.totalWorkItems} work items</span>
                  </div>
                  
                  <div className="hit-rate-summary">
                    <div className="hit-rate-bar-container">
                      <div 
                        className="hit-rate-bar hit"
                        style={{ width: `${stats.hitRate}%` }}
                      >
                        {stats.hitRate > 15 && `${stats.hitRate.toFixed(1)}%`}
                      </div>
                      <div 
                        className="hit-rate-bar miss"
                        style={{ width: `${stats.missedDueDate > 0 ? ((stats.missedDueDate / (stats.hitDueDate + stats.missedDueDate)) * 100) : 0}%` }}
                      >
                        {((stats.missedDueDate / (stats.hitDueDate + stats.missedDueDate || 1)) * 100) > 15 && `${((stats.missedDueDate / (stats.hitDueDate + stats.missedDueDate)) * 100).toFixed(1)}%`}
                      </div>
                      <div 
                        className="hit-rate-bar in-progress"
                        style={{ width: `${100 - stats.hitRate - ((stats.missedDueDate / (stats.hitDueDate + stats.missedDueDate || 1)) * 100)}%` }}
                      >
                      </div>
                    </div>
                    
                    <div className="hit-rate-details">
                      <div className="hit-rate-stat">
                        <span className="stat-label hit">No Changes (Hit):</span>
                        <span className="stat-value">{stats.hitDueDate}</span>
                      </div>
                      <div className="hit-rate-stat">
                        <span className="stat-label miss">Missed Due Date:</span>
                        <span className="stat-value">{stats.missedDueDate}</span>
                      </div>
                    </div>
                  </div>
                  
                  {stats.workItemDetails.length > 0 && (
                    <details className="work-item-details">
                      <summary>View Work Items ({stats.workItemDetails.length})</summary>
                      <ul className="work-item-list">
                        {stats.workItemDetails.map((item, idx) => {
                          const resolvedItem = resolveWorkItem(item.id, item.title, item.workItemType);
                          const typeIcon = getWorkItemTypeIcon(resolvedItem.workItemType);
                          const uniqueReasons = Array.from(new Set(item.dueDateChangeReasons ?? []));
                          return (
                            <li 
                              key={idx} 
                              className={`work-item ${item.status}${onSelectItem ? ' clickable' : ''}`}
                              onClick={() => { if (onSelectItem) onSelectItem(resolvedItem); }}
                              role={onSelectItem ? 'button' : undefined}
                              tabIndex={onSelectItem ? 0 : undefined}
                            >
                              <span className="work-item-id">
                                <span className="work-item-type-icon" title={item.workItemType}>{typeIcon}</span>
                                #{item.id}
                              </span>
                              <span className="work-item-title">{item.title}</span>
                              <span className="work-item-dates">Due: {item.dueDate}</span>
                              <span className={`work-item-status ${item.status}`}>
                                {item.status === 'hit' ? '✓ Hit' : item.status === 'in-progress' ? `⏳ ${item.completionDate}` : `✗ ${item.completionDate}`}
                              </span>
                              {item.status === 'miss' && uniqueReasons.length > 0 && (
                                <ul className="due-date-change-reasons">
                                  {uniqueReasons.map((reason, rIdx) => (
                                    <li key={rIdx} className="due-date-change-reason">{reason}</li>
                                  ))}
                                </ul>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      )}

      {activeStatsTab === 'other' && (
      <div className="stats-section">
        <h3>
          <button 
            className="collapse-button"
            onClick={() => setIsPrTimeCollapsed(!isPrTimeCollapsed)}
            aria-label={isPrTimeCollapsed ? 'Expand section' : 'Collapse section'}
          >
            {isPrTimeCollapsed ? '▶' : '▼'}
          </button>
          Pull Request Time
          <div 
            className="info-icon" 
            onClick={() => setShowPrTimeInfo(!showPrTimeInfo)}
            role="button"
            aria-label="Show information about this section"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
              <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
            </svg>
          </div>
        </h3>
        
        {showPrTimeInfo && (
          <div className="info-tooltip">
            <button 
              className="info-close" 
              onClick={() => setShowPrTimeInfo(false)}
              aria-label="Close information"
            >
              ×
            </button>
            <p>
              <strong>What this section shows:</strong><br />
              Pull requests opened by each developer within the selected time frame — both completed and currently active PRs.
            </p>
            <p>
              <strong>How to interpret:</strong><br />
              • <strong>Total PRs:</strong> All PRs opened by the developer in the time frame (active + completed)<br />
              • <strong>Active:</strong> PRs still open; time is measured from creation to now<br />
              • <strong>Average Time in PR:</strong> Average days from PR creation to merge (or today for active PRs)<br />
              • <strong>Total Time in PR:</strong> Sum of all days across all PRs
            </p>
            <p>
              <strong>Note:</strong> The time frame filters on when each PR was <em>created</em> (not closed), so all PRs a developer opened in the window are included regardless of whether they've merged yet.
            </p>
          </div>
        )}
        
        {!isPrTimeCollapsed && (
          <div className="filter-actions">
            <button 
              onClick={fetchPullRequestTimeStats} 
              disabled={prTimeLoading || (timeFrame === 'custom' && (!customFromDate || !customToDate))}
              className="load-stats-button"
            >
              {prTimeLoading ? 'Loading...' : prTimeHasLoaded ? 'Refresh PR Time' : 'Load PR Time'}
            </button>
          </div>
        )}
        
        {!isPrTimeCollapsed && (showPrTimeNotification || prTimeLoading) && (
          <div className={`background-notification ${prTimeLoading ? 'loading' : prTimeError ? 'error' : 'success'}`}>
            {prTimeLoading && <div className="notification-spinner"></div>}
            <span className="notification-text">{prTimeLoading ? 'Loading pull request time statistics in background...' : prTimeNotificationMessage}</span>
            {!prTimeLoading && (
              <button 
                className="notification-close" 
                onClick={() => setShowPrTimeNotification(false)}
                aria-label="Close notification"
              >
                ×
              </button>
            )}
          </div>
        )}
        
        {(() => {
          console.log('PR Time Render Conditions:', {
            isPrTimeCollapsed,
            prTimeHasLoaded,
            prTimeLoading,
            filteredPrTimeStatsLength: filteredPrTimeStats.length,
            prTimeStatsLength: prTimeStats.length
          });
          return null;
        })()}
        
        {!isPrTimeCollapsed && !prTimeHasLoaded && !prTimeLoading && (
          <p className="placeholder-text">Click "Load PR Time" to view pull request state time statistics.</p>
        )}
        
        {!isPrTimeCollapsed && prTimeHasLoaded && !prTimeLoading && filteredPrTimeStats.length === 0 && (
          <p className="placeholder-text">
            No work items in pull request state found for the selected filters.
            <br />
            <small style={{color: 'var(--text-secondary)'}}>
              Total loaded: {prTimeStats.length}, After filtering: {filteredPrTimeStats.length}
            </small>
          </p>
        )}
        
        {!isPrTimeCollapsed && prTimeHasLoaded && !prTimeLoading && filteredPrTimeStats.length > 0 && (
          <div className="developer-stats-list">
            {filteredPrTimeStats.map((stats, index) => {
              const hasOverduePr = stats.workItemDetails.some(item => item.timeInPullRequestDays > 2 && item.isActive);
              const overdueCountPr = stats.workItemDetails.filter(item => item.timeInPullRequestDays > 2 && item.isActive).length;
              return (
                <div key={index} className={`developer-stat-card${hasOverduePr ? ' has-overdue' : ''}`}>
                  <div className="developer-header">
                    <span className="developer-name">{stats.developer}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {hasOverduePr && (
                        <span className="overdue-card-indicator" title={`${overdueCountPr} PR${overdueCountPr !== 1 ? 's' : ''} open longer than 2 days`}>
                          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M8.982 1.566a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 5.995A.905.905 0 0 1 8 5zm.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/>
                          </svg>
                          {overdueCountPr} overdue
                        </span>
                      )}
                      <span className="total-changes">
                        {stats.totalItemsInPullRequest} PRs
                        {(stats.totalActivePullRequests ?? 0) > 0 && (
                          <> · <span style={{ color: 'var(--accent-color)' }}>{stats.totalActivePullRequests} active</span></>
                        )}
                      </span>
                    </div>
                  </div>
                  
                  <div className="pr-time-summary">
                    <div className="pr-time-details">
                      <div className="pr-time-stat">
                        <span className="stat-label">Avg Time in PR:</span>
                        <span className="stat-value">{stats.averageTimeInPullRequest.toFixed(1)} days</span>
                      </div>
                      <div className="pr-time-stat">
                        <span className="stat-label">Total Time:</span>
                        <span className="stat-value">{stats.totalTimeInPullRequest.toFixed(1)} days</span>
                      </div>
                      {(stats.totalCompletedPullRequests ?? 0) > 0 && (
                        <div className="pr-time-stat">
                          <span className="stat-label">Completed:</span>
                          <span className="stat-value">{stats.totalCompletedPullRequests}</span>
                        </div>
                      )}
                    </div>
                  </div>
                  
                  {stats.workItemDetails.length > 0 && (
                    <details className="work-item-details">
                      <summary>View Pull Requests ({stats.workItemDetails.length})</summary>
                      <ul className="work-item-list">
                        {stats.workItemDetails.map((item, idx) => {
                          const isPrOverdue = item.timeInPullRequestDays > 2 && !!item.isActive;
                          return (
                            <li key={idx} className={`work-item${isPrOverdue ? ' overdue' : ''}`}>
                              <span className="work-item-id">
                                {item.isActive && (
                                  <span
                                    className="pr-active-badge"
                                    title="Active PR"
                                    style={{ marginRight: 4, color: 'var(--accent-color)', fontWeight: 600, fontSize: '0.75em' }}
                                  >
                                    OPEN
                                  </span>
                                )}
                                {item.prUrl ? (
                                  <a
                                    href={item.prUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="pr-link"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    PR #{item.id}
                                  </a>
                                ) : (
                                  `PR #${item.id}`
                                )}
                              </span>
                              <span className="work-item-title">{item.title}</span>
                              <span className="work-item-dates">
                                {item.enteredPullRequestDate} → {item.exitedPullRequestDate}
                              </span>
                              <span className="work-item-pr-time">
                                {item.timeInPullRequestDays.toFixed(1)} days
                              </span>
                              {isPrOverdue && (
                                <span className="overdue-warning-badge" title="In pull request for more than 2 days">
                                  <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
                                    <path d="M8.982 1.566a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 5.995A.905.905 0 0 1 8 5zm.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/>
                                  </svg>
                                  &gt;2 days
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      )}

      {activeStatsTab === 'other' && (
      <div className="stats-section">
        <h3>
          <button 
            className="collapse-button"
            onClick={() => setIsQaBugCollapsed(!isQaBugCollapsed)}
            aria-label={isQaBugCollapsed ? 'Expand section' : 'Collapse section'}
          >
            {isQaBugCollapsed ? '▶' : '▼'}
          </button>
          QA Bug Statistics
          <div 
            className="info-icon" 
            onClick={() => setShowQaBugInfo(!showQaBugInfo)}
            role="button"
            aria-label="Show information about this section"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
              <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
            </svg>
          </div>
        </h3>
        
        {showQaBugInfo && (
          <div className="info-tooltip">
            <button 
              className="info-close" 
              onClick={() => setShowQaBugInfo(false)}
              aria-label="Close information"
            >
              ×
            </button>
            <p>
              <strong>What this section shows:</strong><br />
              Bugs found in QA testing for PBIs created by developers.
            </p>
            <p>
              <strong>How to interpret:</strong><br />
              • <strong>Total PBIs:</strong> Number of Product Backlog Items created by the developer<br />
              • <strong>Total Bugs:</strong> Number of bugs linked to those PBIs<br />
              • <strong>Avg Bugs/PBI:</strong> Average number of bugs per PBI (lower is better)
            </p>
          </div>
        )}
        
        {!isQaBugCollapsed && (
          <div className="filter-actions">
            <button 
              onClick={fetchQABugStats} 
              disabled={qaBugLoading || (timeFrame === 'custom' && (!customFromDate || !customToDate))}
              className="load-stats-button"
            >
              {qaBugLoading ? 'Loading...' : qaBugHasLoaded ? 'Refresh QA Bugs' : 'Load QA Bugs'}
            </button>
          </div>
        )}
        
        {!isQaBugCollapsed && (showQaBugNotification || qaBugLoading) && (
          <div className={`background-notification ${qaBugLoading ? 'loading' : qaBugError ? 'error' : 'success'}`}>
            {qaBugLoading && <div className="notification-spinner"></div>}
            <span className="notification-text">{qaBugLoading ? 'Loading QA bug statistics in background...' : qaBugNotificationMessage}</span>
            {!qaBugLoading && (
              <button 
                className="notification-close" 
                onClick={() => setShowQaBugNotification(false)}
                aria-label="Close notification"
              >
                ×
              </button>
            )}
          </div>
        )}
        
        {!isQaBugCollapsed && !qaBugHasLoaded && !qaBugLoading && (
          <p className="placeholder-text">Click "Load QA Bugs" to view QA bug statistics.</p>
        )}
        
        {!isQaBugCollapsed && qaBugHasLoaded && !qaBugLoading && filteredQaBugStats.length === 0 && (
          <p className="placeholder-text">
            No QA bug data found for the selected filters.
            <br />
            <small style={{color: 'var(--text-secondary)'}}>
              Total loaded: {qaBugStats.length}, After filtering: {filteredQaBugStats.length}
            </small>
          </p>
        )}
        
        {!isQaBugCollapsed && qaBugHasLoaded && !qaBugLoading && filteredQaBugStats.length > 0 && (
          <div className="developer-stats-list">
            {filteredQaBugStats.map((stats, index) => {
              
              return (
                <div key={index} className="developer-stat-card">
                  <div className="developer-header">
                    <span className="developer-name">{stats.developer}</span>
                    <span className="total-changes">{stats.totalPBIs} PBIs</span>
                  </div>
                  
                  <div className="pr-time-summary">
                    <div className="pr-time-details">
                      <div className="pr-time-stat">
                        <span className="stat-label">Total Bugs:</span>
                        <span className="stat-value">{stats.totalBugs}</span>
                      </div>
                      <div className="pr-time-stat">
                        <span className="stat-label">Avg Bugs/PBI:</span>
                        <span className="stat-value">{stats.averageBugsPerPBI.toFixed(1)}</span>
                      </div>
                    </div>
                  </div>
                  
                  {stats.pbiDetails.length > 0 && (
                    <details className="work-item-details">
                      <summary>View PBIs with Bugs ({stats.pbiDetails.length})</summary>
                      <div className="qa-bug-pbi-list">
                        {stats.pbiDetails.map((pbi, idx) => {
                          const resolvedPbi = resolveWorkItem(pbi.id, pbi.title, 'Product Backlog Item');
                          const pbiKey = `qabug-pbi-${stats.developer}-${pbi.id}`;
                          const isPbiExpanded = !collapsedQaBug.has(pbiKey);
                          
                          return (
                            <div key={idx} className="qa-bug-pbi-card">
                              <div className="qa-bug-pbi-header">
                                <div className="qa-bug-pbi-info">
                                  <span 
                                    className={`work-item-id${onSelectItem ? ' clickable' : ''}`}
                                    onClick={() => { if (onSelectItem) onSelectItem(resolvedPbi); }}
                                    role={onSelectItem ? 'button' : undefined}
                                    tabIndex={onSelectItem ? 0 : undefined}
                                  >
                                    #{pbi.id}
                                  </span>
                                  <span className="qa-bug-pbi-title">{pbi.title}</span>
                                </div>
                                <div className="qa-bug-pbi-actions">
                                  <span className={`bug-count-badge ${pbi.bugCount > 3 ? 'high' : pbi.bugCount > 1 ? 'medium' : 'low'}`}>
                                    {pbi.bugCount} {pbi.bugCount === 1 ? 'Bug' : 'Bugs'}
                                  </span>
                                  {pbi.bugs.length > 0 && (
                                    <button 
                                      className="expand-bugs-btn"
                                      onClick={() => {
                                        const newCollapsed = new Set(collapsedQaBug);
                                        if (isPbiExpanded) {
                                          newCollapsed.add(pbiKey);
                                        } else {
                                          newCollapsed.delete(pbiKey);
                                        }
                                        setCollapsedQaBug(newCollapsed);
                                      }}
                                      aria-label={isPbiExpanded ? 'Hide bugs' : 'Show bugs'}
                                    >
                                      {isPbiExpanded ? '▼' : '▶'}
                                    </button>
                                  )}
                                </div>
                              </div>
                              
                              {pbi.bugs.length > 0 && isPbiExpanded && (
                                <div className="qa-bug-details-list">
                                  {pbi.bugs.map((bug, bugIdx) => (
                                    <div key={bugIdx} className={`qa-bug-item state-${bug.state.toLowerCase().replace(/\s+/g, '-')}`}>
                                      <div className="qa-bug-icon">🐛</div>
                                      <div className="qa-bug-content">
                                        <div className="qa-bug-id-title">
                                          <span className="qa-bug-id">#{bug.id}</span>
                                          <span className="qa-bug-title">{bug.title}</span>
                                        </div>
                                        <span className={`qa-bug-state state-${bug.state.toLowerCase().replace(/\s+/g, '-')}`}>
                                          {bug.state}
                                        </span>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      )}

      {/* Design Doc Kickoff Usage Section */}
      {activeStatsTab === 'other' && (
      <div className="stats-section">
        <h3>
          <button
            className="collapse-button"
            onClick={() => setIsKickoffCollapsed(!isKickoffCollapsed)}
            aria-label={isKickoffCollapsed ? 'Expand section' : 'Collapse section'}
          >
            {isKickoffCollapsed ? '▶' : '▼'}
          </button>
          Design Doc Kickoff Usage
          <div
            className="info-icon"
            onClick={() => setShowKickoffInfo(!showKickoffInfo)}
            role="button"
            aria-label="Show information about this section"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
              <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
            </svg>
          </div>
        </h3>

        {showKickoffInfo && (
          <div className="info-tooltip">
            <button className="info-close" onClick={() => setShowKickoffInfo(false)} aria-label="Close information">×</button>
            <p>
              <strong>What this section shows:</strong><br />
              How many PBIs, TBIs, and Bugs each developer had in the selected window, and how many of those had a design document kicked off via <code>/design-doc-kickoff</code> (detected by markdown files committed under <code>design-doc/</code> in the MaxView repository).
            </p>
            <p>
              <strong>How to interpret:</strong><br />
              • <strong>Kickoffs Used:</strong> Work items with a design-doc file committed in the time window<br />
              • <strong>Total Work Items:</strong> All PBI/TBI/Bug items changed in the window for this developer<br />
              • <strong>Adoption bar:</strong> Percentage of work items that went through /design-doc-kickoff<br />
              • Developer is inferred from the PR linked to the work item, falling back to Assigned To
            </p>
          </div>
        )}

        {!isKickoffCollapsed && (
          <div className="filter-actions">
            <button
              onClick={fetchDesignDocKickoffStats}
              disabled={kickoffLoading || (timeFrame === 'custom' && (!customFromDate || !customToDate))}
              className="load-stats-button"
            >
              {kickoffLoading ? 'Loading...' : kickoffHasLoaded ? 'Refresh Kickoff Stats' : 'Load Kickoff Stats'}
            </button>
          </div>
        )}

        {!isKickoffCollapsed && (showKickoffNotification || kickoffLoading) && (
          <div className={`background-notification ${kickoffLoading ? 'loading' : kickoffError ? 'error' : 'success'}`}>
            {kickoffLoading && <div className="notification-spinner"></div>}
            <span className="notification-text">
              {kickoffLoading ? 'Loading design doc kickoff statistics in background...' : kickoffNotificationMessage}
            </span>
            {!kickoffLoading && (
              <button className="notification-close" onClick={() => setShowKickoffNotification(false)} aria-label="Close notification">×</button>
            )}
          </div>
        )}

        {!isKickoffCollapsed && !kickoffHasLoaded && !kickoffLoading && (
          <p className="placeholder-text">Click "Load Kickoff Stats" to view /design-doc-kickoff usage per developer.</p>
        )}

        {!isKickoffCollapsed && kickoffHasLoaded && !kickoffLoading && filteredKickoffStats.length === 0 && (
          <p className="placeholder-text">No design-doc kickoff events found for the selected filters.</p>
        )}

        {!isKickoffCollapsed && kickoffHasLoaded && !kickoffLoading && filteredKickoffStats.length > 0 && (
          <div className="developer-stats-list">
            {filteredKickoffStats.map((stats, index) => (
              <div key={index} className="developer-stat-card">
                <div className="developer-header">
                  <span className="developer-name">{stats.developer}</span>
                  <span className="total-changes">{stats.kickoffCount} / {stats.totalWorkItems} items</span>
                </div>

                <div className="hit-rate-summary">
                  <div className="hit-rate-bar-container">
                    <div
                      className="hit-rate-bar hit"
                      style={{ width: `${Math.min(stats.adoptionRate, 100)}%` }}
                    >
                      {stats.adoptionRate > 15 && `${stats.adoptionRate.toFixed(1)}%`}
                    </div>
                    <div
                      className="hit-rate-bar in-progress"
                      style={{ width: `${Math.max(0, 100 - stats.adoptionRate)}%` }}
                    />
                  </div>

                  <div className="hit-rate-details">
                    <div className="hit-rate-stat">
                      <span className="stat-label hit">Kickoffs Used:</span>
                      <span className="stat-value">{stats.kickoffCount}</span>
                    </div>
                    <div className="hit-rate-stat">
                      <span className="stat-label">Total Work Items:</span>
                      <span className="stat-value">{stats.totalWorkItems}</span>
                    </div>
                  </div>
                </div>

                {stats.kickoffDetails.length > 0 && (
                  <details className="work-item-details">
                    <summary>View Kickoffs ({stats.kickoffDetails.length})</summary>
                    <ul className="work-item-list">
                      {stats.kickoffDetails.map((detail, idx) => {
                        const resolvedKickoff = resolveWorkItem(detail.workItemId, detail.title, detail.workItemType);
                        const typeIcon = getWorkItemTypeIcon(detail.workItemType);
                        return (
                          <li
                            key={idx}
                            className={`work-item${onSelectItem ? ' clickable' : ''}`}
                            onClick={() => { if (onSelectItem) onSelectItem(resolvedKickoff); }}
                            role={onSelectItem ? 'button' : undefined}
                            tabIndex={onSelectItem ? 0 : undefined}
                          >
                            <span className="work-item-id">
                              <span className="work-item-type-icon" title={detail.workItemType}>{typeIcon}</span>
                              #{detail.workItemId}
                            </span>
                            <span className="work-item-title">{detail.title}</span>
                            <span className="work-item-dates">Kicked off: {detail.commitDate}</span>
                            {detail.prId && (
                              <span className="work-item-pr-time">PR #{detail.prId}</span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      )}

      {/* In Progress Time Section */}
      {activeStatsTab === 'other' && (
      <div className="stats-section">
        <h3>
          <button
            className="collapse-button"
            onClick={() => setIsInProgressCollapsed(!isInProgressCollapsed)}
            aria-label={isInProgressCollapsed ? 'Expand section' : 'Collapse section'}
          >
            {isInProgressCollapsed ? '▶' : '▼'}
          </button>
          Time In Progress
          <div
            className="info-icon"
            onClick={() => setShowInProgressInfo(!showInProgressInfo)}
            role="button"
            aria-label="Show information about this section"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
              <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
            </svg>
          </div>
        </h3>

        {showInProgressInfo && (
          <div className="info-tooltip">
            <button className="info-close" onClick={() => setShowInProgressInfo(false)} aria-label="Close information">×</button>
            <p>
              <strong>What this section shows:</strong><br />
              Total and average number of days each developer's work items spent in the "In Progress" state within the selected date window.
            </p>
            <p>
              <strong>How to interpret:</strong><br />
              • <strong>Avg Days In Progress:</strong> Average across all items that entered In Progress<br />
              • <strong>Total Days:</strong> Sum of all In Progress days<br />
              • Items marked ⏳ are still currently in progress
            </p>
          </div>
        )}

        {!isInProgressCollapsed && (
          <div className="filter-actions">
            <button
              onClick={fetchInProgressStats}
              disabled={inProgressLoading || (timeFrame === 'custom' && (!customFromDate || !customToDate))}
              className="load-stats-button"
            >
              {inProgressLoading ? 'Loading...' : inProgressHasLoaded ? 'Refresh In Progress' : 'Load In Progress'}
            </button>
          </div>
        )}

        {!isInProgressCollapsed && (showInProgressNotification || inProgressLoading) && (
          <div className={`background-notification ${inProgressLoading ? 'loading' : inProgressError ? 'error' : 'success'}`}>
            {inProgressLoading && <div className="notification-spinner"></div>}
            <span className="notification-text">{inProgressLoading ? 'Loading in-progress statistics in background...' : inProgressNotificationMessage}</span>
            {!inProgressLoading && (
              <button className="notification-close" onClick={() => setShowInProgressNotification(false)} aria-label="Close notification">×</button>
            )}
          </div>
        )}

        {!isInProgressCollapsed && !inProgressHasLoaded && !inProgressLoading && (
          <p className="placeholder-text">Click "Load In Progress" to view time spent in progress per developer.</p>
        )}

        {!isInProgressCollapsed && inProgressHasLoaded && !inProgressLoading && filteredInProgressStats.length === 0 && (
          <p className="placeholder-text">No in-progress data found for the selected filters.</p>
        )}

        {!isInProgressCollapsed && inProgressHasLoaded && !inProgressLoading && filteredInProgressStats.length > 0 && (
          <div className="developer-stats-list">
            {filteredInProgressStats.map((stats, index) => {
            const hasOverdueInProgress = stats.workItemDetails.some(item => item.daysInProgress > 5 && item.isCurrentlyInProgress);
            const overdueCountInProgress = stats.workItemDetails.filter(item => item.daysInProgress > 5 && item.isCurrentlyInProgress).length;
            return (
              <div key={index} className={`developer-stat-card${hasOverdueInProgress ? ' has-overdue' : ''}`}>
                <div className="developer-header">
                  <span className="developer-name">{stats.developer}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {hasOverdueInProgress && (
                      <span className="overdue-card-indicator" title={`${overdueCountInProgress} item${overdueCountInProgress !== 1 ? 's' : ''} in progress longer than 5 days`}>
                        <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M8.982 1.566a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 5.995A.905.905 0 0 1 8 5zm.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/>
                        </svg>
                        {overdueCountInProgress} overdue
                      </span>
                    )}
                    <span className="total-changes">{stats.totalItemsInProgress} items</span>
                  </div>
                </div>

                <div className="pr-time-summary">
                  <div className="pr-time-details">
                    <div className="pr-time-stat">
                      <span className="stat-label">Avg Days In Progress:</span>
                      <span className="stat-value">{stats.averageDaysInProgress.toFixed(1)} days</span>
                    </div>
                    <div className="pr-time-stat">
                      <span className="stat-label">Total Days:</span>
                      <span className="stat-value">{stats.totalDaysInProgress.toFixed(1)} days</span>
                    </div>
                  </div>
                </div>

                {stats.workItemDetails.length > 0 && (
                  <details className="work-item-details">
                    <summary>View Work Items ({stats.workItemDetails.length})</summary>
                    <ul className="work-item-list">
                      {stats.workItemDetails.map((item, idx) => {
                        const resolvedInProgress = resolveWorkItem(item.id, item.title, item.workItemType);
                        const isOverdue = item.daysInProgress > 5 && item.isCurrentlyInProgress;
                        return (
                          <li
                            key={idx}
                            className={`work-item${onSelectItem ? ' clickable' : ''}${isOverdue ? ' overdue' : ''}`}
                            onClick={() => { if (onSelectItem) onSelectItem(resolvedInProgress); }}
                            role={onSelectItem ? 'button' : undefined}
                            tabIndex={onSelectItem ? 0 : undefined}
                          >
                            <span className="work-item-id">#{item.id}</span>
                            <span className="work-item-title">{item.title}</span>
                            <span className="work-item-dates">
                              {item.enteredInProgressDate} → {item.exitedInProgressDate ?? 'present'}
                            </span>
                            <span className="work-item-pr-time">
                              {item.isCurrentlyInProgress ? '⏳ ' : ''}{item.daysInProgress.toFixed(1)} days
                            </span>
                            {isOverdue && (
                              <span className="overdue-warning-badge" title="In progress for more than 5 days">
                                <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
                                  <path d="M8.982 1.566a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 5.995A.905.905 0 0 1 8 5zm.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/>
                                </svg>
                                &gt;5 days
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                )}
              </div>
            );
          })}
          </div>
        )}
      </div>
      )}

      {/* Pull Request Feedback Section */}
      {activeStatsTab === 'other' && (
      <div className="stats-section">
        <h3>
          <button
            className="collapse-button"
            onClick={() => setIsPrFeedbackCollapsed(!isPrFeedbackCollapsed)}
            aria-label={isPrFeedbackCollapsed ? 'Expand section' : 'Collapse section'}
          >
            {isPrFeedbackCollapsed ? '▶' : '▼'}
          </button>
          Pull Request Feedback
          <div
            className="info-icon"
            onClick={() => setShowPrFeedbackInfo(!showPrFeedbackInfo)}
            role="button"
            aria-label="Show information about this section"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
              <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
            </svg>
          </div>
        </h3>

        {showPrFeedbackInfo && (
          <div className="info-tooltip">
            <button className="info-close" onClick={() => setShowPrFeedbackInfo(false)} aria-label="Close information">×</button>
            <p>
              <strong>What this section shows:</strong><br />
              How much feedback each developer has given on other people's pull requests within the selected time frame.
            </p>
            <p>
              <strong>How to interpret:</strong><br />
              • <strong>PRs Reviewed:</strong> Number of unique PRs where the developer left comments or voted<br />
              • <strong>Comments Given:</strong> Total non-system comments left across all reviewed PRs<br />
              • <strong>Approvals / Rejections:</strong> Vote counts on PRs they reviewed
            </p>
            <p>
              <strong>Note:</strong> Only PRs created within the selected time frame are included. Comments on your own PRs are excluded.
            </p>
          </div>
        )}

        {!isPrFeedbackCollapsed && (
          <div className="filter-actions">
            <button
              onClick={fetchPullRequestFeedbackStats}
              disabled={prFeedbackLoading || (timeFrame === 'custom' && (!customFromDate || !customToDate))}
              className="load-stats-button"
            >
              {prFeedbackLoading ? 'Loading...' : prFeedbackHasLoaded ? 'Refresh PR Feedback' : 'Load PR Feedback'}
            </button>
          </div>
        )}

        {!isPrFeedbackCollapsed && (showPrFeedbackNotification || prFeedbackLoading) && (
          <div className={`background-notification ${prFeedbackLoading ? 'loading' : prFeedbackError ? 'error' : 'success'}`}>
            {prFeedbackLoading && <div className="notification-spinner"></div>}
            <span className="notification-text">
              {prFeedbackLoading ? 'Loading pull request feedback statistics in background...' : prFeedbackNotificationMessage}
            </span>
            {!prFeedbackLoading && (
              <button className="notification-close" onClick={() => setShowPrFeedbackNotification(false)} aria-label="Close notification">×</button>
            )}
          </div>
        )}

        {!isPrFeedbackCollapsed && !prFeedbackHasLoaded && !prFeedbackLoading && (
          <p className="placeholder-text">Click "Load PR Feedback" to view how much feedback each developer gives on pull requests.</p>
        )}

        {!isPrFeedbackCollapsed && prFeedbackHasLoaded && !prFeedbackLoading && filteredPrFeedbackStats.length === 0 && (
          <p className="placeholder-text">No pull request feedback found for the selected filters.</p>
        )}

        {!isPrFeedbackCollapsed && prFeedbackHasLoaded && !prFeedbackLoading && filteredPrFeedbackStats.length > 0 && (() => {
          const maxComments = Math.max(...filteredPrFeedbackStats.map(s => s.totalCommentsGiven), 1);
          return (
            <div className="developer-stats-list">
              {filteredPrFeedbackStats.map((stats, index) => (
                <div key={index} className="developer-stat-card">
                  <div className="developer-header">
                    <span className="developer-name">{stats.developer}</span>
                    <span className="total-changes">{stats.totalPRsReviewed} PRs reviewed</span>
                  </div>

                  {/* Comment bar */}
                  <div className="changes-bar-container" style={{ marginBottom: 12 }}>
                    <div
                      className="changes-bar"
                      style={{ width: `${(stats.totalCommentsGiven / maxComments) * 100}%` }}
                      title={`${stats.totalCommentsGiven} comments`}
                    >
                      {(stats.totalCommentsGiven / maxComments) * 100 > 20 && (
                        <span className="changes-bar-label">{stats.totalCommentsGiven}</span>
                      )}
                    </div>
                  </div>

                  <div className="pr-feedback-summary">
                    <div className="pr-feedback-stat">
                      <span className="stat-label">Comments Given:</span>
                      <span className="stat-value">{stats.totalCommentsGiven}</span>
                    </div>
                    <div className="pr-feedback-stat">
                      <span className="stat-label pr-feedback-approvals">Approvals:</span>
                      <span className="stat-value">{stats.totalApprovalsGiven}</span>
                    </div>
                    <div className="pr-feedback-stat">
                      <span className="stat-label pr-feedback-rejections">Rejections:</span>
                      <span className="stat-value">{stats.totalRejectionsGiven}</span>
                    </div>
                  </div>

                  {stats.prDetails.length > 0 && (
                    <details className="work-item-details">
                      <summary>View Reviewed PRs ({stats.prDetails.length})</summary>
                      <ul className="work-item-list">
                        {stats.prDetails.map((pr, idx) => {
                          const { label: voteLabel, className: voteClass } = getVoteLabel(pr.vote);
                          return (
                            <li key={idx} className="work-item pr-feedback-row">
                              <span className="work-item-id">
                                <a href={pr.prUrl} target="_blank" rel="noreferrer" className="pr-link" onClick={e => e.stopPropagation()}>
                                  PR #{pr.prId}
                                </a>
                              </span>
                              <span className="work-item-title">{pr.title}</span>
                              <span className="work-item-dates">by {pr.creator} · {pr.repositoryName}</span>
                              <div className="pr-feedback-row-right">
                                {pr.commentsGiven > 0 && (
                                  <span className="pr-feedback-comment-count" title={`${pr.commentsGiven} comment${pr.commentsGiven !== 1 ? 's' : ''}`}>
                                    💬 {pr.commentsGiven}
                                  </span>
                                )}
                                {pr.vote !== 0 && (
                                  <span className={`pr-vote-badge ${voteClass}`}>{voteLabel}</span>
                                )}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </details>
                  )}
                </div>
              ))}
            </div>
          );
        })()}
      </div>
      )}

      {/* PR resolution metrics (agent-evals) */}
      {activeStatsTab === 'other' && (
      <div className="stats-section">
        <h3>
          <button
            className="collapse-button"
            onClick={() => setIsPrResolutionCollapsed(!isPrResolutionCollapsed)}
            aria-label={isPrResolutionCollapsed ? 'Expand section' : 'Collapse section'}
          >
            {isPrResolutionCollapsed ? '▶' : '▼'}
          </button>
          PR comment resolutions (eval runs)
          <div
            className="info-icon"
            onClick={() => setShowPrResolutionInfo(!showPrResolutionInfo)}
            role="button"
            aria-label="Show information about this section"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
              <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
            </svg>
          </div>
        </h3>

        {showPrResolutionInfo && (
          <div className="info-tooltip">
            <button className="info-close" onClick={() => setShowPrResolutionInfo(false)} aria-label="Close information">×</button>
            <p>
              <strong>What this section shows:</strong><br />
              Aggregated PR comment resolution data from <code>pr-resolution-metrics.json</code> files under the MaxView repo{' '}
              <code>agent-evals/runs</code>, for the selected date range. Each row in those files is tied to a PR; developers are the{' '}
              <strong>PR author</strong> (ADO <code>createdBy.displayName</code>), not the eval run folder name.
            </p>
            <p>
              <strong>How to interpret:</strong><br />
              • <strong>Comments (total):</strong> Sum of <code>total</code> review comments in the metrics snapshots<br />
              • <strong>Accepted / Won{"'"}t fix / Snoozed:</strong> Counts from the same snapshots<br />
              • <strong>Acceptance rate:</strong> <code>accepted / total</code> across loaded snapshots
            </p>
          </div>
        )}

        {!isPrResolutionCollapsed && (
          <div className="filter-actions">
            <button
              onClick={fetchPrResolutionMetricsStats}
              disabled={prResolutionLoading || (timeFrame === 'custom' && (!customFromDate || !customToDate))}
              className="load-stats-button"
            >
              {prResolutionLoading ? 'Loading...' : prResolutionHasLoaded ? 'Refresh PR resolutions' : 'Load PR resolutions'}
            </button>
          </div>
        )}

        {!isPrResolutionCollapsed && (showPrResolutionNotification || prResolutionLoading) && (
          <div className={`background-notification ${prResolutionLoading ? 'loading' : prResolutionError ? 'error' : 'success'}`}>
            {prResolutionLoading && <div className="notification-spinner"></div>}
            <span className="notification-text">
              {prResolutionLoading ? 'Loading PR resolution metrics in background...' : prResolutionNotificationMessage}
            </span>
            {!prResolutionLoading && (
              <button className="notification-close" onClick={() => setShowPrResolutionNotification(false)} aria-label="Close notification">×</button>
            )}
          </div>
        )}

        {!isPrResolutionCollapsed && !prResolutionHasLoaded && !prResolutionLoading && (
          <p className="placeholder-text">{`Click "Load PR resolutions" to aggregate apply-pr-fix style metrics from agent-evals JSON.`}</p>
        )}

        {!isPrResolutionCollapsed && prResolutionHasLoaded && !prResolutionLoading && filteredPrResolutionStats.length === 0 && (
          <p className="placeholder-text">No PR resolution metrics found for the selected filters.</p>
        )}

        {!isPrResolutionCollapsed && prResolutionHasLoaded && !prResolutionLoading && filteredPrResolutionStats.length > 0 && (() => {
          const maxTotal = Math.max(...filteredPrResolutionStats.map(s => s.totalComments), 1);
          return (
            <div className="developer-stats-list">
              {filteredPrResolutionStats.map((stats, index) => (
                <div key={index} className="developer-stat-card">
                  <div className="developer-header">
                    <span className="developer-name">{stats.developer}</span>
                    <span className="total-changes">{stats.prCount} PR{stats.prCount !== 1 ? 's' : ''}</span>
                  </div>

                  <div className="changes-bar-container" style={{ marginBottom: 12 }}>
                    <div
                      className="changes-bar"
                      style={{ width: `${(stats.totalComments / maxTotal) * 100}%` }}
                      title={`${stats.totalComments} comments`}
                    >
                      {(stats.totalComments / maxTotal) * 100 > 20 && (
                        <span className="changes-bar-label">{stats.totalComments}</span>
                      )}
                    </div>
                  </div>

                  <div className="pr-resolution-summary">
                    <div className="pr-resolution-stat">
                      <span className="stat-label">Comments (total):</span>
                      <span className="stat-value">{stats.totalComments}</span>
                    </div>
                    <div className="pr-resolution-stat">
                      <span className="stat-label">Accepted:</span>
                      <span className="stat-value">{stats.accepted}</span>
                    </div>
                    <div className="pr-resolution-stat">
                      <span className="stat-label">Won{"'"}t fix:</span>
                      <span className="stat-value">{stats.wontfix}</span>
                    </div>
                    <div className="pr-resolution-stat">
                      <span className="stat-label">Snoozed:</span>
                      <span className="stat-value">{stats.snoozed}</span>
                    </div>
                    <div className="pr-resolution-stat">
                      <span className="stat-label">Acceptance rate:</span>
                      <span className="stat-value">{(stats.acceptanceRate * 100).toFixed(1)}%</span>
                    </div>
                  </div>

                  {Object.keys(stats.byCategory).length > 0 && (
                    <details className="work-item-details" style={{ marginTop: 8 }}>
                      <summary>By category</summary>
                      <ul className="work-item-list">
                        {Object.entries(stats.byCategory).map(([cat, b]) => (
                          <li key={cat} className="work-item">
                            <span className="work-item-title">{cat}</span>
                            <span className="work-item-dates">
                              total {b.total} · accepted {b.accepted} · won{"'"}t fix {b.wontfix}
                              {b.snoozed > 0 ? ` · snoozed ${b.snoozed}` : ''}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}

                  {stats.prDetails.length > 0 && (
                    <details className="work-item-details">
                      <summary>View PR snapshots ({stats.prDetails.length})</summary>
                      <ul className="work-item-list">
                        {stats.prDetails.map((row, idx) => (
                          <li key={idx} className="work-item pr-resolution-row">
                            <span className="work-item-id">
                              {row.prUrl ? (
                                <a href={row.prUrl} target="_blank" rel="noreferrer" className="pr-link" onClick={e => e.stopPropagation()}>
                                  PR #{row.prId}
                                </a>
                              ) : (
                                <span>PR #{row.prId}</span>
                              )}
                            </span>
                            <span className="work-item-title">{row.prTitle}</span>
                            <span className="work-item-dates">{row.date}{row.repositoryName ? ` · ${row.repositoryName}` : ''}</span>
                            <span className="pr-resolution-row-metrics">
                              total {row.total} · ✓ {row.accepted} · ✗ {row.wontfix}
                              {row.snoozed > 0 ? ` · snoozed ${row.snoozed}` : ''}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              ))}
            </div>
          );
        })()}
      </div>
      )}
    </div>
  );
};
