import { WorkItem, DeveloperDueDateStats, DueDateHitRateStats, PullRequestTimeStats, QABugStats, InProgressTimeStats, DesignDocKickoffStats } from '../types/workitem';
import './DevStats.css';
import { useState, useMemo, useEffect } from 'react';

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

  // Info tooltip state
  const [showChangesInfo, setShowChangesInfo] = useState(false);
  const [showHitRateInfo, setShowHitRateInfo] = useState(false);
  const [showPrTimeInfo, setShowPrTimeInfo] = useState(false);
  const [showQaBugInfo, setShowQaBugInfo] = useState(false);
  const [showInProgressInfo, setShowInProgressInfo] = useState(false);
  const [showKickoffInfo, setShowKickoffInfo] = useState(false);
  
  // Collapse state for sections — all default to collapsed for better visibility
  const [isChangesCollapsed, setIsChangesCollapsed] = useState(true);
  const [isHitRateCollapsed, setIsHitRateCollapsed] = useState(true);
  const [isPrTimeCollapsed, setIsPrTimeCollapsed] = useState(true);
  const [isQaBugCollapsed, setIsQaBugCollapsed] = useState(true);
  const [isInProgressCollapsed, setIsInProgressCollapsed] = useState(true);
  const [isKickoffCollapsed, setIsKickoffCollapsed] = useState(true);
  const [collapsedReasons, setCollapsedReasons] = useState<Set<string>>(new Set());
  const [collapsedQaBug, setCollapsedQaBug] = useState<Set<string>>(new Set());
  
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
    
    const devList = Array.from(devSet).sort();
    console.log('DevStats - Developers from all stats:', devList);
    return devList;
  }, [dueDateStats, hitRateStats, prTimeStats]);

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
                          const fullWorkItem = workItems.find(wi => wi.id === item.id);
                          const typeIcon = getWorkItemTypeIcon(item.workItemType || fullWorkItem?.workItemType || '');
                          const uniqueReasons = Array.from(new Set(item.dueDateChangeReasons ?? []));
                          return (
                            <li 
                              key={idx} 
                              className={`work-item ${item.status}${onSelectItem && fullWorkItem ? ' clickable' : ''}`}
                              onClick={() => {
                                if (onSelectItem && fullWorkItem) {
                                  onSelectItem(fullWorkItem);
                                }
                              }}
                              role={onSelectItem && fullWorkItem ? 'button' : undefined}
                              tabIndex={onSelectItem && fullWorkItem ? 0 : undefined}
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
              Time spent by developers in the "In Pull Request" state for their work items.
            </p>
            <p>
              <strong>How to interpret:</strong><br />
              • <strong>Total Items in PR:</strong> Number of work items that went through the "In Pull Request" state<br />
              • <strong>Average Time in PR:</strong> Average days spent in pull request state<br />
              • <strong>Total Time in PR:</strong> Sum of all days spent across all items
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
              
              return (
                <div key={index} className="developer-stat-card">
                  <div className="developer-header">
                    <span className="developer-name">{stats.developer}</span>
                    <span className="total-changes">{stats.totalItemsInPullRequest} items</span>
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
                    </div>
                  </div>
                  
                  {stats.workItemDetails.length > 0 && (
                    <details className="work-item-details">
                      <summary>View Work Items ({stats.workItemDetails.length})</summary>
                      <ul className="work-item-list">
                        {stats.workItemDetails.map((item, idx) => {
                          const fullWorkItem = workItems.find(wi => wi.id === item.id);
                          return (
                            <li 
                              key={idx} 
                              className={`work-item${onSelectItem && fullWorkItem ? ' clickable' : ''}`}
                              onClick={() => {
                                if (onSelectItem && fullWorkItem) {
                                  onSelectItem(fullWorkItem);
                                }
                              }}
                              role={onSelectItem && fullWorkItem ? 'button' : undefined}
                              tabIndex={onSelectItem && fullWorkItem ? 0 : undefined}
                            >
                              <span className="work-item-id">#{item.id}</span>
                              <span className="work-item-title">{item.title}</span>
                              <span className="work-item-dates">
                                PR: {item.enteredPullRequestDate} → {item.exitedPullRequestDate}
                              </span>
                              <span className="work-item-pr-time">
                                {item.timeInPullRequestDays.toFixed(1)} days
                              </span>
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
                          const fullWorkItem = workItems.find(wi => wi.id === pbi.id);
                          const pbiKey = `qabug-pbi-${stats.developer}-${pbi.id}`;
                          const isPbiExpanded = !collapsedQaBug.has(pbiKey);
                          
                          return (
                            <div key={idx} className="qa-bug-pbi-card">
                              <div className="qa-bug-pbi-header">
                                <div className="qa-bug-pbi-info">
                                  <span 
                                    className={`work-item-id${onSelectItem && fullWorkItem ? ' clickable' : ''}`}
                                    onClick={() => {
                                      if (onSelectItem && fullWorkItem) {
                                        onSelectItem(fullWorkItem);
                                      }
                                    }}
                                    role={onSelectItem && fullWorkItem ? 'button' : undefined}
                                    tabIndex={onSelectItem && fullWorkItem ? 0 : undefined}
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

      {/* Design Doc Kickoff Usage Section */}
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
                        const fullWorkItem = workItems.find(wi => wi.id === detail.workItemId);
                        const typeIcon = getWorkItemTypeIcon(detail.workItemType);
                        return (
                          <li
                            key={idx}
                            className={`work-item${onSelectItem && fullWorkItem ? ' clickable' : ''}`}
                            onClick={() => { if (onSelectItem && fullWorkItem) onSelectItem(fullWorkItem); }}
                            role={onSelectItem && fullWorkItem ? 'button' : undefined}
                            tabIndex={onSelectItem && fullWorkItem ? 0 : undefined}
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

      {/* In Progress Time Section */}
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
            {filteredInProgressStats.map((stats, index) => (
              <div key={index} className="developer-stat-card">
                <div className="developer-header">
                  <span className="developer-name">{stats.developer}</span>
                  <span className="total-changes">{stats.totalItemsInProgress} items</span>
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
                        const fullWorkItem = workItems.find(wi => wi.id === item.id);
                        return (
                          <li
                            key={idx}
                            className={`work-item${onSelectItem && fullWorkItem ? ' clickable' : ''}`}
                            onClick={() => { if (onSelectItem && fullWorkItem) onSelectItem(fullWorkItem); }}
                            role={onSelectItem && fullWorkItem ? 'button' : undefined}
                            tabIndex={onSelectItem && fullWorkItem ? 0 : undefined}
                          >
                            <span className="work-item-id">#{item.id}</span>
                            <span className="work-item-title">{item.title}</span>
                            <span className="work-item-dates">
                              {item.enteredInProgressDate} → {item.exitedInProgressDate ?? 'present'}
                            </span>
                            <span className="work-item-pr-time">
                              {item.isCurrentlyInProgress ? '⏳ ' : ''}{item.daysInProgress.toFixed(1)} days
                            </span>
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
    </div>
  );
};
