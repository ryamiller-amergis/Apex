import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { startOfMonth, endOfMonth } from 'date-fns';
import { useWorkItems } from './useWorkItems';
import { azureCostService } from '../services/azureCostService';
import { env } from '../config/env';
import type { WorkItem } from '../types/workitem';

const CURRENT_VERSION = '1.10.0';

interface DueDateChange {
  workItemId: number;
  workItemTitle: string;
  oldDueDate: string | null;
  newDueDate: string | null;
}

function parseTeamsEnv(): { availableProjects: string[]; availableAreaPaths: string[] } {
  const projects = new Set<string>();
  const areaPaths = new Set<string>();
  env.VITE_TEAMS.split('~~~').forEach((team: string) => {
    const [project, areaPath] = team.trim().split('|');
    if (project) projects.add(project);
    if (areaPath) areaPaths.add(areaPath);
  });
  return {
    availableProjects: Array.from(projects).sort(),
    availableAreaPaths: Array.from(areaPaths).sort(),
  };
}

export function useAppShell() {
  const queryClient = useQueryClient();
  const [currentDate] = useState(new Date());
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [selectedItem, setSelectedItem] = useState<WorkItem | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (localStorage.getItem('theme') as 'light' | 'dark') || 'dark');
  const [showChangelog, setShowChangelog] = useState(false);
  const [hasUnreadChangelog, setHasUnreadChangelog] = useState(() => localStorage.getItem('lastReadChangelogVersion') !== CURRENT_VERSION);
  const [isSaving, setIsSaving] = useState(false);
  const [pendingDueDateChange, setPendingDueDateChange] = useState<DueDateChange | null>(null);
  const [isChangingTeam, setIsChangingTeam] = useState(false);
  const originalDueDates = useRef<Map<number, string | undefined>>(new Map());

  const { availableProjects, availableAreaPaths } = useMemo(parseTeamsEnv, []);

  const [selectedProject, setSelectedProject] = useState<string>(() => localStorage.getItem('selectedProject') || availableProjects[0] || 'MaxView');
  const [selectedAreaPath, setSelectedAreaPath] = useState<string>(() => localStorage.getItem('selectedAreaPath') || availableAreaPaths[0] || 'MaxView');
  const currentTeamRef = useRef({ project: selectedProject, areaPath: selectedAreaPath });

  const startDate = useMemo(() => startOfMonth(currentDate), [currentDate]);
  const endDate = useMemo(() => endOfMonth(currentDate), [currentDate]);

  useEffect(() => {
    fetch('/auth/status', { credentials: 'include' })
      .then(r => r.json())
      .then(d => setIsAuthenticated(d.authenticated))
      .catch(() => setIsAuthenticated(false));
  }, []);

  const { workItems, loading, error, updateDueDate, refetch } = useWorkItems(
    startDate, endDate, selectedProject, selectedAreaPath, isAuthenticated === true
  );

  useEffect(() => { localStorage.setItem('selectedProject', selectedProject); }, [selectedProject]);
  useEffect(() => { localStorage.setItem('selectedAreaPath', selectedAreaPath); }, [selectedAreaPath]);
  useEffect(() => { document.documentElement.setAttribute('data-theme', theme); localStorage.setItem('theme', theme); }, [theme]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (isChangingTeam && !loading) {
      currentTeamRef.current = { project: selectedProject, areaPath: selectedAreaPath };
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsChangingTeam(false);
    }
  }, [isChangingTeam, loading, selectedProject, selectedAreaPath]);

  useEffect(() => {
    workItems.forEach(item => {
      if (!originalDueDates.current.has(item.id)) {
        originalDueDates.current.set(item.id, item.dueDate);
      }
    });
  }, [workItems]);

  // Prefetch background data
  useEffect(() => {
    if (!isAuthenticated || loading) return;
    const enc = encodeURIComponent;
    const delay = window.setTimeout(() => {
      queryClient.prefetchQuery({
        queryKey: ['releases', selectedProject, selectedAreaPath],
        queryFn: () => fetch(`/api/releases?project=${enc(selectedProject)}&areaPath=${enc(selectedAreaPath)}`, { credentials: 'include' }).then(r => r.ok ? r.json() : []),
        staleTime: 5 * 60 * 1000,
      });
      queryClient.prefetchQuery({
        queryKey: ['releaseEpics', selectedProject, selectedAreaPath],
        queryFn: () => fetch(`/api/releases/epics?project=${enc(selectedProject)}&areaPath=${enc(selectedAreaPath)}`, { credentials: 'include' }).then(r => r.ok ? r.json() : []),
        staleTime: 5 * 60 * 1000,
      });
      const stagger = window.setTimeout(() => {
        queryClient.prefetchQuery({ queryKey: ['azureSubscriptions'], queryFn: () => azureCostService.getSubscriptionsWithResourceGroups(), staleTime: 10 * 60 * 1000 });
        queryClient.prefetchQuery({ queryKey: ['azureDashboard'], queryFn: () => azureCostService.getDashboardData(5), staleTime: 5 * 60 * 1000 });
      }, 600);
      return () => window.clearTimeout(stagger);
    }, 2000);
    return () => window.clearTimeout(delay);
  }, [isAuthenticated, loading, selectedProject, selectedAreaPath, queryClient]);

  // Sync selectedItem with updated workItems
  useEffect(() => {
    if (selectedItem) {
      const updated = workItems.find(i => i.id === selectedItem.id);
      if (updated) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSelectedItem(updated);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workItems, selectedItem?.id]);

  const handleFieldUpdate = useCallback(async (id: number, field: string, value: unknown) => {
    setIsSaving(true);
    try {
      const res = await fetch(`/api/workitems/${id}/field`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, value, project: selectedProject, areaPath: selectedAreaPath }),
      });
      if (!res.ok) return;
      await new Promise(r => setTimeout(r, 800));
      if (refetch) await refetch();
      await new Promise(r => setTimeout(r, 300));
    } finally {
      setIsSaving(false);
    }
  }, [selectedProject, selectedAreaPath, refetch]);

  const handleDueDateChange = useCallback((id: number, newDueDate: string | null, reason?: string) => {
    const item = workItems.find(i => i.id === id);
    if (!item) return;
    const usesTargetDate = item.workItemType === 'Epic' || item.workItemType === 'Feature' || item.workItemType === 'Bug';
    if (usesTargetDate) return;
    const oldDueDate = item.dueDate || null;
    if (oldDueDate === newDueDate) return;
    if (reason) {
      originalDueDates.current.set(id, newDueDate || undefined);
      updateDueDate(id, newDueDate, reason);
      return;
    }
    setPendingDueDateChange({ workItemId: id, workItemTitle: item.title, oldDueDate, newDueDate });
  }, [workItems, updateDueDate]);

  const handleConfirmDueDateChange = useCallback(async (reason: string) => {
    if (!pendingDueDateChange) return;
    const { workItemId, newDueDate } = pendingDueDateChange;
    originalDueDates.current.set(workItemId, newDueDate || undefined);
    await updateDueDate(workItemId, newDueDate, reason);
    setPendingDueDateChange(null);
  }, [pendingDueDateChange, updateDueDate]);

  const handleMarkChangelogAsRead = useCallback(() => {
    localStorage.setItem('lastReadChangelogVersion', CURRENT_VERSION);
    setHasUnreadChangelog(false);
  }, []);

  const handleLogout = useCallback(async () => {
    try { await fetch('/auth/logout', { credentials: 'include' }); } catch { /* ignore */ }
    window.location.href = '/';
  }, []);

  const scheduledItems = useMemo(() => workItems.filter(i => i.dueDate || i.targetDate), [workItems]);
  const unscheduledItems = useMemo(() => workItems.filter(i => !i.dueDate && !i.targetDate), [workItems]);

  const changeProject = (project: string) => { setIsChangingTeam(true); setSelectedProject(project); };
  const changeAreaPath = (areaPath: string) => { setIsChangingTeam(true); setSelectedAreaPath(areaPath); };

  return {
    isAuthenticated,
    workItems,
    loading,
    error,
    isLoading: loading || isChangingTeam,
    isSaving,
    selectedItem,
    setSelectedItem,
    theme,
    toggleTheme: () => setTheme(p => p === 'light' ? 'dark' : 'light'),
    showChangelog,
    setShowChangelog,
    hasUnreadChangelog,
    handleMarkChangelogAsRead,
    handleLogout,
    selectedProject,
    selectedAreaPath,
    availableProjects,
    availableAreaPaths,
    changeProject,
    changeAreaPath,
    scheduledItems,
    unscheduledItems,
    pendingDueDateChange,
    setPendingDueDateChange,
    handleDueDateChange,
    handleConfirmDueDateChange,
    handleCancelDueDateChange: () => setPendingDueDateChange(null),
    handleFieldUpdate,
  };
}
