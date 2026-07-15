import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { startOfMonth, endOfMonth } from 'date-fns';
import { useWorkItems } from './useWorkItems';
import { env } from '../config/env';
import type { WorkItem } from '../types/workitem';
import type { MyPermissionsResponse } from '../../shared/types/rbac';

export type ThemeMode = 'light' | 'dark' | 'amergis';

const isThemeMode = (value: string | null): value is ThemeMode => (
  value === 'light' || value === 'dark' || value === 'amergis'
);

interface AuthenticatedUser {
  name: string;
  email?: string;
}

interface DueDateChange {
  workItemId: number;
  workItemTitle: string;
  oldDueDate: string | null;
  newDueDate: string | null;
}

export interface Team {
  project: string;
  areaPath: string;
  displayName: string;
}

function parseTeamsEnv(): { availableProjects: string[]; availableAreaPaths: string[]; availableTeams: Team[] } {
  const projects = new Set<string>();
  const areaPaths = new Set<string>();
  const teams: Team[] = [];
  env.VITE_TEAMS.split('~~~').forEach((team: string) => {
    const [project, areaPath] = team.trim().split('|');
    if (project) projects.add(project);
    if (areaPath) areaPaths.add(areaPath);
    if (project && areaPath) {
      const segments = areaPath.split('/');
      const displayName = segments[segments.length - 1];
      teams.push({ project, areaPath, displayName });
    }
  });
  return {
    availableProjects: Array.from(projects).sort(),
    availableAreaPaths: Array.from(areaPaths).sort(),
    availableTeams: teams,
  };
}

export function useAppShell() {
  const queryClient = useQueryClient();
  const [currentDate] = useState(new Date());
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [authenticatedUser, setAuthenticatedUser] = useState<AuthenticatedUser | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [userId, setUserId] = useState<string>('');
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [permissionsLoaded, setPermissionsLoaded] = useState(false);
  const [selectedItem, setSelectedItem] = useState<WorkItem | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const storedTheme = localStorage.getItem('theme');
    return isThemeMode(storedTheme) ? storedTheme : 'amergis';
  });
  const [showChangelog, setShowChangelog] = useState(false);
  const [hasUnreadChangelog, setHasUnreadChangelog] = useState(false);
  const [showChangelogOnLogin, setShowChangelogOnLogin] = useState(true);
  const [betaAnnouncementDismissed, setBetaAnnouncementDismissed] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [pendingDueDateChange, setPendingDueDateChange] = useState<DueDateChange | null>(null);
  const [isChangingTeam, setIsChangingTeam] = useState(false);
  const originalDueDates = useRef<Map<number, string | undefined>>(new Map());

  const { availableProjects, availableAreaPaths, availableTeams } = useMemo(parseTeamsEnv, []);

  const [selectedProject, setSelectedProject] = useState<string>(() => localStorage.getItem('selectedProject') || availableProjects[0] || 'MaxView');
  const [selectedAreaPath, setSelectedAreaPath] = useState<string>(() => localStorage.getItem('selectedAreaPath') || availableAreaPaths[0] || 'MaxView');
  const [selectedSkillSettingsId, setSelectedSkillSettingsId] = useState<string | null>(
    () => localStorage.getItem('selectedSkillSettingsId')
  );
  const currentTeamRef = useRef({ project: selectedProject, areaPath: selectedAreaPath });

  const startDate = useMemo(() => startOfMonth(currentDate), [currentDate]);
  const endDate = useMemo(() => endOfMonth(currentDate), [currentDate]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | null = null;

    const checkAuth = async () => {
      try {
        const r = await fetch('/auth/status', { credentials: 'include' });
        if (!r.ok) throw new Error(`auth status ${r.status}`);
        const d = await r.json();
        if (cancelled) return;
        setIsAuthenticated(d.authenticated);
        setAuthenticatedUser(d.authenticated ? d.user ?? null : null);
      } catch {
        if (cancelled) return;
        // Server may be restarting (nodemon) — retry instead of sending user to login.
        retryTimer = window.setTimeout(checkAuth, 2000);
      }
    };

    void checkAuth();
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    setPermissionsLoaded(false);
    const url = selectedProject
      ? `/api/me/permissions?project=${encodeURIComponent(selectedProject)}`
      : '/api/me/permissions';
    fetch(url, { credentials: 'include' })
      .then(r => r.ok ? (r.json() as Promise<MyPermissionsResponse>) : null)
      .then(d => {
        if (d) {
          setPermissions(d.permissions);
          setRoles(d.roles);
          setGroups(d.groups ?? []);
          setUserId(d.userId ?? '');
          setIsSuperAdmin(d.isSuperAdmin ?? false);
          setHasUnreadChangelog(d.changelogUnread);
          setShowChangelogOnLogin(d.showChangelogOnLogin);
          setBetaAnnouncementDismissed(d.betaAnnouncementDismissed);
          if (d.changelogUnread && d.showChangelogOnLogin) {
            setShowChangelog(true);
          }
        }
      })
      .catch(() => { /* ignore */ })
      .finally(() => setPermissionsLoaded(true));
  }, [isAuthenticated, selectedProject]);

  const { workItems, loading, error, updateDueDate, refetch } = useWorkItems(
    startDate, endDate, selectedProject, selectedAreaPath, isAuthenticated === true
  );

  useEffect(() => { localStorage.setItem('selectedProject', selectedProject); }, [selectedProject]);
  useEffect(() => { localStorage.setItem('selectedAreaPath', selectedAreaPath); }, [selectedAreaPath]);
  useEffect(() => {
    if (selectedSkillSettingsId) {
      localStorage.setItem('selectedSkillSettingsId', selectedSkillSettingsId);
    } else {
      localStorage.removeItem('selectedSkillSettingsId');
    }
  }, [selectedSkillSettingsId]);
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

  const can = useCallback((key: string) => isSuperAdmin || permissions.includes(key), [isSuperAdmin, permissions]);

  const isInAnyGroup = useCallback(
    (names: string[]) =>
      isSuperAdmin ||
      permissions.includes('admin:roles') ||
      roles.includes('admin') ||
      groups.some((g) => names.includes(g)),
    [isSuperAdmin, permissions, roles, groups],
  );

  const handleMarkChangelogAsRead = useCallback(() => {
    setHasUnreadChangelog(false);
    void fetch('/api/me/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ markChangelogRead: true }),
    });
  }, []);

  const handleDismissBetaAnnouncement = useCallback(() => {
    setBetaAnnouncementDismissed(true);
    void fetch('/api/me/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ dismissBetaAnnouncement: true }),
    });
  }, []);

  const handleToggleShowChangelogOnLogin = useCallback((show: boolean) => {
    setShowChangelogOnLogin(show);
    void fetch('/api/me/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ showChangelogOnLogin: show }),
    });
  }, []);

  const handleLogout = useCallback(async () => {
    sessionStorage.removeItem('agentHomeThreadId');
    try { await fetch('/auth/logout', { credentials: 'include' }); } catch { /* ignore */ }
    window.location.href = '/';
  }, []);

  const scheduledItems = useMemo(() => workItems.filter(i => i.dueDate || i.targetDate), [workItems]);
  const unscheduledItems = useMemo(() => workItems.filter(i => !i.dueDate && !i.targetDate), [workItems]);

  const changeProject = (project: string) => { setIsChangingTeam(true); setSelectedProject(project); setSelectedSkillSettingsId(null); };
  const changeAreaPath = (areaPath: string) => { setIsChangingTeam(true); setSelectedAreaPath(areaPath); };
  const changeSkillSettings = useCallback((id: string | null) => {
    setSelectedSkillSettingsId(id);
  }, []);

  return {
    isAuthenticated,
    authenticatedUser,
    permissions,
    roles,
    groups,
    userId,
    permissionsLoaded,
    can,
    isInAnyGroup,
    isSuperAdmin,
    isAdmin: isSuperAdmin || roles.includes('admin'),
    workItems,
    loading,
    error,
    isLoading: loading || isChangingTeam,
    isSaving,
    selectedItem,
    setSelectedItem,
    theme,
    setThemeMode: setTheme,
    toggleTheme: () => setTheme(p => p === 'light' ? 'dark' : p === 'dark' ? 'amergis' : 'light'),
    showChangelog,
    setShowChangelog,
    hasUnreadChangelog,
    showChangelogOnLogin,
    handleMarkChangelogAsRead,
    handleToggleShowChangelogOnLogin,
    betaAnnouncementDismissed,
    handleDismissBetaAnnouncement,
    handleLogout,
    selectedProject,
    selectedAreaPath,
    availableProjects,
    availableAreaPaths,
    availableTeams,
    changeProject,
    changeAreaPath,
    selectedSkillSettingsId,
    changeSkillSettings,
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
