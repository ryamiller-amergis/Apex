import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  useApproveProjectAccessRequest,
  usePlatformAdminPendingAssignments,
  usePlatformAdminAccessRequests,
  usePlatformAdminAssignments,
  usePlatformAdminMenuConfigs,
  usePlatformAdminProjects,
  usePlatformAdminUsers,
  usePlatformAdminGroups,
  useRemovePlatformAdminPendingAssignment,
  useRejectProjectAccessRequest,
  useSetPlatformAdminAssignments,
  useSetPlatformAdminMenuConfig,
} from '../hooks/usePlatformAdmin';
import {
  useFeatureFlagsList,
  useCreateFeatureFlag,
  useUpdateFeatureFlag,
  useDeleteFeatureFlag,
  useAddFlagRule,
  useRemoveFlagRule,
  useFlagAudit,
} from '../hooks/usePlatformAdminFeatureFlags';
import { UserMenu } from './UserMenu';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import type { ThemeMode } from '../hooks/useAppShell';
import { CONFIGURABLE_MENU_ITEMS, type MenuItemKey } from '../../shared/types/menuSettings';
import type {
  PendingProjectAssignment,
  PlatformAdminAccessRequest,
  PlatformAdminUser,
  PlatformAdminGroup,
  ProjectAssignmentGroup,
} from '../../shared/types/platformAdmin';
import type { FeatureFlagRule, FeatureFlagWithRules, FlagLifecycle, FlagRuleType } from '../../shared/types/featureFlags';
import styles from './PlatformAdmin.module.css';

const MENU_ITEM_KEYS = CONFIGURABLE_MENU_ITEMS.map((item) => item.key) as [MenuItemKey, ...MenuItemKey[]];

const menuSchema = z.object({
  enabledViews: z.array(z.enum(MENU_ITEM_KEYS)),
});

type MenuFormValues = z.infer<typeof menuSchema>;

type PlatformAdminTab = 'access' | 'menu' | 'flags';

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong';
}

function getUserLabel(user: Pick<PlatformAdminUser, 'userId' | 'displayName' | 'email'>): string {
  return user.displayName || user.email || user.userId;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  cells.push(current.trim());
  return cells;
}

function parseImportEntries(fileText: string): string[] {
  const lines = fileText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const firstLineCells = parseCsvLine(lines[0]);
  const importColumnIndex = firstLineCells.findIndex((cell) => {
    const normalized = cell.trim().toLowerCase();
    return normalized === 'email' || normalized === 'userid' || normalized === 'user_id';
  });

  if (importColumnIndex >= 0) {
    return lines
      .slice(1)
      .map((line) => parseCsvLine(line)[importColumnIndex]?.trim() ?? '')
      .filter(Boolean);
  }

  return lines
    .map((line) => parseCsvLine(line)[0]?.trim() ?? '')
    .filter(Boolean);
}

function readTextFile(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read import file'));
    reader.readAsText(file);
  });
}

function isEmailEntry(entry: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.trim());
}

function formatImportMessage(importedCount: number, pendingCount: number): string {
  const importedLabel = `${importedCount} user${importedCount === 1 ? '' : 's'}`;
  if (pendingCount === 0) return `Imported ${importedLabel}.`;

  return `Imported ${importedLabel}, ${pendingCount} pending first login.`;
}

interface PlatformAdminProps {
  onBackToProjects: () => void;
  user: { name: string; email?: string } | null;
  theme: ThemeMode;
  hasUnreadChangelog: boolean;
  onThemeChange: (theme: ThemeMode) => void;
  onOpenChangelog: () => void;
  onLogout: () => void;
}

export const PlatformAdmin: React.FC<PlatformAdminProps> = ({
  onBackToProjects,
  user,
  theme,
  hasUnreadChangelog,
  onThemeChange,
  onOpenChangelog,
  onLogout,
}) => {
  const [selectedMenuProject, setSelectedMenuProject] = useState<string>('');
  const [activeTab, setActiveTab] = useState<PlatformAdminTab>('access');
  const [assignmentSavedProject, setAssignmentSavedProject] = useState<string | null>(null);
  const [menuSavedProject, setMenuSavedProject] = useState<string | null>(null);

  const {
    data: projects = [],
    isLoading: projectsLoading,
    isError: projectsIsError,
    error: projectsError,
  } = usePlatformAdminProjects();
  const {
    data: assignments = [],
    isLoading: assignmentsLoading,
    isError: assignmentsIsError,
    error: assignmentsError,
  } = usePlatformAdminAssignments();
  const {
    data: menuConfigs = [],
    isLoading: menuConfigsLoading,
    isError: menuConfigsIsError,
    error: menuConfigsError,
  } = usePlatformAdminMenuConfigs();
  const {
    data: availableUsers = [],
    isLoading: usersLoading,
    isError: usersIsError,
    error: usersError,
  } = usePlatformAdminUsers();
  const {
    data: accessRequests = [],
    isLoading: accessRequestsLoading,
    isError: accessRequestsIsError,
    error: accessRequestsError,
  } = usePlatformAdminAccessRequests('pending');
  const setAssignments = useSetPlatformAdminAssignments();
  const setMenuConfig = useSetPlatformAdminMenuConfig();
  const approveAccessRequest = useApproveProjectAccessRequest();
  const rejectAccessRequest = useRejectProjectAccessRequest();

  const projectNames = useMemo(() => {
    return projects.map((project) => project.name);
  }, [projects]);

  const assignmentsByProject = useMemo(() => {
    return new Map(assignments.map((group) => [group.project, group]));
  }, [assignments]);

  const emptyAssignmentsByProject = useMemo(() => {
    return new Map(projectNames.map((project) => [project, { project, users: [] }]));
  }, [projectNames]);

  const menuConfigByProject = useMemo(() => {
    return new Map(menuConfigs.map((config) => [config.project, config]));
  }, [menuConfigs]);

  const loadError = projectsError ?? assignmentsError ?? menuConfigsError ?? usersError ?? accessRequestsError;
  const mutationError = setAssignments.error ?? setMenuConfig.error ?? approveAccessRequest.error ?? rejectAccessRequest.error;
  const isLoading = projectsLoading || assignmentsLoading || menuConfigsLoading || usersLoading || accessRequestsLoading;
  const hasLoadError = projectsIsError || assignmentsIsError || menuConfigsIsError || usersIsError || accessRequestsIsError;

  const handleSaveAssignments = useCallback(async (project: string, userIds: string[], pendingEmails?: string[]) => {
    setAssignmentSavedProject(null);
    await setAssignments.mutateAsync({ project, userIds, pendingEmails });
    setAssignmentSavedProject(project);
  }, [setAssignments]);

  const handleSaveMenuConfig = useCallback(async (project: string, enabledViews: MenuItemKey[]) => {
    setMenuSavedProject(null);
    await setMenuConfig.mutateAsync({ project, enabledViews });
    setMenuSavedProject(project);
  }, [setMenuConfig]);

  const handleApproveAccessRequest = useCallback(async (requestId: string) => {
    await approveAccessRequest.mutateAsync({ requestId });
  }, [approveAccessRequest]);

  const handleRejectAccessRequest = useCallback(async (requestId: string) => {
    await rejectAccessRequest.mutateAsync({ requestId });
  }, [rejectAccessRequest]);

  useEffect(() => {
    if (selectedMenuProject && projectNames.includes(selectedMenuProject)) return;
    setSelectedMenuProject(projectNames[0] ?? '');
  }, [projectNames, selectedMenuProject]);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button type="button" className={styles.backButton} onClick={onBackToProjects}>
          Back to projects
        </button>
        <div>
          <p className={styles.eyebrow}>Super admin</p>
          <h1 className={styles.title}>Platform Admin</h1>
          <p className={styles.subtitle}>
            Manage project access and per-project navigation without selecting an in-project context.
          </p>
        </div>
        <div className={styles.headerActions}>
          <UserMenu
            onOpenChangelog={onOpenChangelog}
            onThemeChange={onThemeChange}
            onLogout={onLogout}
            theme={theme}
            user={user}
            hasUnreadChangelog={hasUnreadChangelog}
          />
        </div>
      </header>

      {hasLoadError && (
        <div className={styles.error} role="alert">
          {formatError(loadError)}
        </div>
      )}
      {mutationError && (
        <div className={styles.error} role="alert">
          {formatError(mutationError)}
        </div>
      )}

      {isLoading ? (
        <div className={styles.loading}>Loading platform admin settings...</div>
      ) : projectNames.length === 0 ? (
        <div className={styles.emptyState}>
          <h2>No projects available</h2>
          <p>Projects will appear here once the platform can load the project catalog.</p>
        </div>
      ) : (
        <main className={styles.content}>
          <div className={styles.tabBar} role="tablist" aria-label="Platform admin sections">
            <button
              type="button"
              role="tab"
              id="platform-admin-tab-access"
              aria-selected={activeTab === 'access'}
              aria-controls="platform-admin-panel-access"
              className={`${styles.tabButton} ${activeTab === 'access' ? styles.tabButtonActive : ''}`}
              onClick={() => setActiveTab('access')}
            >
              Access &amp; Users
              {accessRequests.length > 0 && (
                <span className={styles.tabBadge} aria-label={`${accessRequests.length} pending requests`}>
                  {accessRequests.length}
                </span>
              )}
            </button>
            <button
              type="button"
              role="tab"
              id="platform-admin-tab-menu"
              aria-selected={activeTab === 'menu'}
              aria-controls="platform-admin-panel-menu"
              className={`${styles.tabButton} ${activeTab === 'menu' ? styles.tabButtonActive : ''}`}
              onClick={() => setActiveTab('menu')}
            >
              Menu Visibility
            </button>
            <button
              type="button"
              role="tab"
              id="platform-admin-tab-flags"
              aria-selected={activeTab === 'flags'}
              aria-controls="platform-admin-panel-flags"
              className={`${styles.tabButton} ${activeTab === 'flags' ? styles.tabButtonActive : ''}`}
              onClick={() => setActiveTab('flags')}
            >
              Feature Flags
            </button>
          </div>

          {activeTab === 'access' && (
            <div
              id="platform-admin-panel-access"
              role="tabpanel"
              aria-labelledby="platform-admin-tab-access"
              className={styles.tabPanel}
            >
              <AccessRequestsSection
                requests={accessRequests}
                isApproving={approveAccessRequest.isPending}
                isRejecting={rejectAccessRequest.isPending}
                onApprove={handleApproveAccessRequest}
                onReject={handleRejectAccessRequest}
              />

              <section className={styles.section} aria-labelledby="user-project-access-title">
                <div className={styles.sectionHeader}>
                  <div>
                    <h2 id="user-project-access-title" className={styles.sectionTitle}>User-Project Access</h2>
                    <p className={styles.sectionHint}>
                      Search users who have logged in, select one or more per project, or import a CSV/TXT list of emails or user IDs.
                    </p>
                  </div>
                </div>
                <div className={styles.assignmentGrid}>
                  {projectNames.map((project) => {
                    const group = assignmentsByProject.get(project) ?? emptyAssignmentsByProject.get(project)!;
                    return (
                      <AssignmentCard
                        key={project}
                        group={group}
                        availableUsers={availableUsers}
                        isSaving={setAssignments.isPending}
                        wasSaved={assignmentSavedProject === project}
                        onSave={handleSaveAssignments}
                      />
                    );
                  })}
                </div>
              </section>
            </div>
          )}
          {activeTab === 'menu' && (
            <div
              id="platform-admin-panel-menu"
              role="tabpanel"
              aria-labelledby="platform-admin-tab-menu"
              className={styles.tabPanel}
            >
              <MenuVisibilitySection
                projectNames={projectNames}
                selectedProject={selectedMenuProject}
                enabledViews={menuConfigByProject.get(selectedMenuProject)?.enabledViews ?? []}
                isSaving={setMenuConfig.isPending}
                wasSaved={menuSavedProject === selectedMenuProject}
                onSelectProject={setSelectedMenuProject}
                onSave={handleSaveMenuConfig}
              />
            </div>
          )}
          {activeTab === 'flags' && (
            <div
              id="platform-admin-panel-flags"
              role="tabpanel"
              aria-labelledby="platform-admin-tab-flags"
              className={styles.tabPanel}
            >
              <FeatureFlagsSection />
            </div>
          )}
        </main>
      )}
    </div>
  );
};

interface AccessRequestsSectionProps {
  requests: PlatformAdminAccessRequest[];
  isApproving: boolean;
  isRejecting: boolean;
  onApprove: (requestId: string) => Promise<void>;
  onReject: (requestId: string) => Promise<void>;
}

const AccessRequestsSection: React.FC<AccessRequestsSectionProps> = ({
  requests,
  isApproving,
  isRejecting,
  onApprove,
  onReject,
}) => {
  const pending = isApproving || isRejecting;

  return (
    <section className={styles.section} aria-labelledby="access-requests-title">
      <div className={styles.sectionHeader}>
        <div>
          <h2 id="access-requests-title" className={styles.sectionTitle}>Access Requests</h2>
          <p className={styles.sectionHint}>
            Review project access requests from users who cannot yet see a project on the selector page.
          </p>
        </div>
        <span className={styles.countBadge}>{requests.length} pending</span>
      </div>

      {requests.length === 0 ? (
        <p className={styles.muted}>No pending access requests.</p>
      ) : (
        <div className={styles.requestList}>
          {requests.map((request) => (
            <article key={request.id} className={styles.requestCard}>
              <div className={styles.requestDetails}>
                <div>
                  <h3 className={styles.cardTitle}>{request.project}</h3>
                  <p className={styles.muted}>
                    Requested by {request.displayName || request.email || request.userId}
                  </p>
                  {request.email && <p className={styles.requestMeta}>{request.email}</p>}
                </div>
                <span className={styles.requestMeta}>
                  {new Date(request.requestedAt).toLocaleString()}
                </span>
              </div>
              <div className={styles.requestActions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={pending}
                  onClick={() => void onReject(request.id)}
                >
                  Reject
                </button>
                <button
                  type="button"
                  className={styles.primaryButton}
                  disabled={pending}
                  onClick={() => void onApprove(request.id)}
                >
                  Accept
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
};

interface AssignmentCardProps {
  group: ProjectAssignmentGroup;
  availableUsers: PlatformAdminUser[];
  isSaving: boolean;
  wasSaved: boolean;
  onSave: (project: string, userIds: string[], pendingEmails?: string[]) => Promise<void>;
}

const AssignmentCard: React.FC<AssignmentCardProps> = ({
  group,
  availableUsers,
  isSaving,
  wasSaved,
  onSave,
}) => {
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importedPendingEmails, setImportedPendingEmails] = useState<string[]>([]);
  const {
    data: pendingAssignments = [],
    isLoading: pendingAssignmentsLoading,
    isError: pendingAssignmentsIsError,
    error: pendingAssignmentsError,
  } = usePlatformAdminPendingAssignments(group.project);
  const removePendingAssignment = useRemovePlatformAdminPendingAssignment();
  const currentUserIds = useMemo(() => group.users.map((user) => user.userId), [group.users]);
  const usersById = useMemo(() => {
    const lookup = new Map<string, PlatformAdminUser>();
    group.users.forEach((user) => lookup.set(user.userId, user));
    availableUsers.forEach((user) => lookup.set(user.userId, user));
    return lookup;
  }, [availableUsers, group.users]);
  const usersByEmail = useMemo(() => {
    const lookup = new Map<string, PlatformAdminUser>();
    availableUsers.forEach((user) => {
      if (user.email) lookup.set(user.email.toLowerCase(), user);
    });
    return lookup;
  }, [availableUsers]);
  const selectedUsers = useMemo(() => {
    return selectedUserIds.map((userId) => usersById.get(userId) ?? { userId, displayName: userId, email: '' });
  }, [selectedUserIds, usersById]);
  const filteredUsers = useMemo(() => {
    const selected = new Set(selectedUserIds);
    const normalizedQuery = searchQuery.trim().toLowerCase();
    return availableUsers
      .filter((user) => !selected.has(user.userId))
      .filter((user) => {
        if (!normalizedQuery) return true;
        return [
          user.displayName,
          user.email,
          user.userId,
        ].some((value) => value.toLowerCase().includes(normalizedQuery));
      })
      .slice(0, 8);
  }, [availableUsers, searchQuery, selectedUserIds]);
  const savedPendingEmailSet = useMemo(() => {
    return new Set(pendingAssignments.map((assignment) => assignment.email.toLowerCase()));
  }, [pendingAssignments]);
  const pendingDisplayCount = pendingAssignments.length + importedPendingEmails.length;

  useEffect(() => {
    setSelectedUserIds(currentUserIds);
    setSearchQuery('');
    setImportMessage(null);
    setImportedPendingEmails([]);
  }, [currentUserIds, group.project]);

  const handleAddUser = (userId: string) => {
    setSelectedUserIds((prev) => (prev.includes(userId) ? prev : [...prev, userId]));
    setSearchQuery('');
    setImportMessage(null);
  };

  const handleRemoveUser = (userId: string) => {
    setSelectedUserIds((prev) => prev.filter((id) => id !== userId));
    setImportMessage(null);
  };

  const handleRemoveSavedPending = async (email: string) => {
    await removePendingAssignment.mutateAsync({ project: group.project, email });
  };

  const handleRemoveImportedPending = (email: string) => {
    setImportedPendingEmails((prev) => prev.filter((pendingEmail) => pendingEmail !== email));
    setImportMessage(null);
  };

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;

    const entries = parseImportEntries(await readTextFile(file));
    if (entries.length === 0) {
      setImportMessage('No import entries found.');
      return;
    }

    const matchedIds: string[] = [];
    const pendingEmailsToAdd: string[] = [];
    const seenEntries = new Set<string>();
    const knownPendingEmails = new Set([
      ...Array.from(savedPendingEmailSet),
      ...importedPendingEmails.map((email) => email.toLowerCase()),
    ]);

    entries.forEach((entry) => {
      const token = entry.trim();
      if (!token) return;
      const normalizedToken = token.toLowerCase();
      if (seenEntries.has(normalizedToken)) return;
      seenEntries.add(normalizedToken);

      const matchedUser = usersById.get(token) ?? usersByEmail.get(normalizedToken);
      if (matchedUser) {
        matchedIds.push(matchedUser.userId);
      } else if (isEmailEntry(token) && !knownPendingEmails.has(normalizedToken)) {
        pendingEmailsToAdd.push(normalizedToken);
        knownPendingEmails.add(normalizedToken);
      }
    });

    const selected = new Set(selectedUserIds);
    const addedIds = matchedIds.filter((userId) => !selected.has(userId));
    setSelectedUserIds([...selectedUserIds, ...addedIds]);
    setImportedPendingEmails((prev) => [...prev, ...pendingEmailsToAdd]);
    setImportMessage(formatImportMessage(addedIds.length, pendingEmailsToAdd.length));
  };

  const handleSubmitAssignments = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const pendingEmails = importedPendingEmails.length > 0 ? importedPendingEmails : undefined;
    await onSave(group.project, selectedUserIds, pendingEmails);
    setImportedPendingEmails([]);
    setImportMessage(null);
  };

  const pending = isSaving || removePendingAssignment.isPending;
  const hasSuggestions = filteredUsers.length > 0;

  return (
    <article className={styles.assignmentCard}>
      <div className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>{group.project}</h3>
        <span className={styles.countBadge}>{group.users.length} assigned</span>
      </div>

      <div className={styles.userList}>
        {group.users.length === 0 ? (
          <p className={styles.muted}>No users assigned yet.</p>
        ) : (
          group.users.map((user) => (
            <div key={user.userId} className={styles.userRow}>
              <div>
                <span className={styles.userName}>{user.displayName || user.email || user.userId}</span>
                {user.email && <span className={styles.userEmail}>{user.email}</span>}
              </div>
              <code className={styles.userId}>{user.userId}</code>
            </div>
          ))
        )}
      </div>

      <div className={styles.pendingSection} aria-label={`${group.project} pending first-login users`}>
        <div className={styles.pendingHeader}>
          <h4 className={styles.pendingTitle}>Pending first login</h4>
          <span className={styles.countBadge}>{pendingDisplayCount} pending</span>
        </div>
        {pendingAssignmentsLoading ? (
          <p className={styles.muted}>Loading pending assignments...</p>
        ) : pendingAssignmentsIsError ? (
          <p className={styles.fieldError}>{formatError(pendingAssignmentsError)}</p>
        ) : pendingDisplayCount === 0 ? (
          <p className={styles.muted}>No pending first-login assignments.</p>
        ) : (
          <div className={styles.pendingList}>
            {pendingAssignments.map((assignment: PendingProjectAssignment) => (
              <div key={assignment.id} className={styles.pendingRow}>
                <div>
                  <span className={styles.userName}>{assignment.email}</span>
                  <span className={styles.userEmail}>Awaiting first login</span>
                </div>
                <div className={styles.pendingActions}>
                  <span className={styles.pendingBadge}>Pending</span>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    disabled={pending}
                    onClick={() => void handleRemoveSavedPending(assignment.email)}
                    aria-label={`Remove pending ${assignment.email}`}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
            {importedPendingEmails.map((email) => (
              <div key={`imported-${email}`} className={styles.pendingRow}>
                <div>
                  <span className={styles.userName}>{email}</span>
                  <span className={styles.userEmail}>Will be pending after save</span>
                </div>
                <div className={styles.pendingActions}>
                  <span className={styles.pendingBadge}>Unsaved</span>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    disabled={pending}
                    onClick={() => handleRemoveImportedPending(email)}
                    aria-label={`Remove pending ${email}`}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <form className={styles.form} onSubmit={(event) => void handleSubmitAssignments(event)}>
        <label className={styles.label} htmlFor={`assignments-${group.project}`}>
          Add users
        </label>
        <div className={styles.selectedUserList} aria-label={`${group.project} selected users`}>
          {selectedUsers.length === 0 ? (
            <p className={styles.muted}>No users selected for this project.</p>
          ) : (
            selectedUsers.map((user) => (
              <span key={user.userId} className={styles.userChip}>
                <span>{getUserLabel(user)}</span>
                <button
                  type="button"
                  className={styles.chipRemoveButton}
                  onClick={() => handleRemoveUser(user.userId)}
                  disabled={pending}
                  aria-label={`Remove ${getUserLabel(user)}`}
                >
                  &times;
                </button>
              </span>
            ))
          )}
        </div>
        <input
          id={`assignments-${group.project}`}
          className={styles.input}
          type="search"
          value={searchQuery}
          placeholder="Search by name, email, or user ID"
          disabled={pending || availableUsers.length === 0}
          onChange={(event) => setSearchQuery(event.target.value)}
          autoComplete="off"
        />
        {availableUsers.length === 0 ? (
          <p className={styles.fieldWarning}>No logged-in users are available to assign yet.</p>
        ) : (
          <div className={styles.suggestionList} role="listbox" aria-label={`${group.project} matching users`}>
            {hasSuggestions ? (
              filteredUsers.map((user) => (
                <button
                  key={user.userId}
                  type="button"
                  className={styles.suggestionButton}
                  onClick={() => handleAddUser(user.userId)}
                  disabled={pending}
                  role="option"
                  aria-selected={false}
                >
                  <span className={styles.userName}>{getUserLabel(user)}</span>
                  {user.email && <span className={styles.userEmail}>{user.email}</span>}
                </button>
              ))
            ) : (
              <p className={styles.muted}>No matching users found.</p>
            )}
          </div>
        )}
        <div className={styles.importRow}>
          <label className={styles.secondaryButton} htmlFor={`assignment-import-${group.project}`}>
            Import CSV/TXT
          </label>
          <input
            id={`assignment-import-${group.project}`}
            className={styles.fileInput}
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            disabled={pending}
            onChange={(event) => void handleImportFile(event)}
          />
          <span className={styles.importHint}>One email or user ID per line, or CSV with email/userId column.</span>
        </div>
        {importMessage && <p className={styles.fieldWarning}>{importMessage}</p>}
        <div className={styles.formActions}>
          {wasSaved && <span className={styles.success}>Assignments saved</span>}
          <button type="submit" className={styles.primaryButton} disabled={pending}>
            {pending ? 'Saving...' : 'Save assignments'}
          </button>
        </div>
      </form>
    </article>
  );
};

interface MenuVisibilitySectionProps {
  projectNames: string[];
  selectedProject: string;
  enabledViews: MenuItemKey[];
  isSaving: boolean;
  wasSaved: boolean;
  onSelectProject: (project: string) => void;
  onSave: (project: string, enabledViews: MenuItemKey[]) => Promise<void>;
}

const MenuVisibilitySection: React.FC<MenuVisibilitySectionProps> = ({
  projectNames,
  selectedProject,
  enabledViews,
  isSaving,
  wasSaved,
  onSelectProject,
  onSave,
}) => {
  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { isSubmitting },
  } = useForm<MenuFormValues>({
    resolver: zodResolver(menuSchema),
    defaultValues: { enabledViews },
  });

  const watchedViews = watch('enabledViews') ?? [];

  useEffect(() => {
    reset({ enabledViews });
  }, [enabledViews, reset, selectedProject]);

  const onSubmit = async (values: MenuFormValues) => {
    if (!selectedProject) return;
    await onSave(selectedProject, values.enabledViews);
  };

  const pending = isSaving || isSubmitting;

  return (
    <section className={styles.section} aria-labelledby="menu-visibility-title">
      <div className={styles.sectionHeader}>
        <div>
          <h2 id="menu-visibility-title" className={styles.sectionTitle}>Menu Visibility</h2>
          <p className={styles.sectionHint}>
            Choose which app views appear in navigation for each project. Users still need the matching role permission (and Developer group for My Work).
          </p>
        </div>
      </div>

      <div className={styles.menuLayout}>
        <div className={styles.projectList} aria-label="Projects">
          {projectNames.map((project) => (
            <button
              key={project}
              type="button"
              className={`${styles.projectButton} ${selectedProject === project ? styles.projectButtonActive : ''}`}
              onClick={() => onSelectProject(project)}
            >
              {project}
            </button>
          ))}
        </div>

        <form className={styles.menuForm} onSubmit={(event) => void handleSubmit(onSubmit)(event)}>
          <h3 className={styles.cardTitle}>{selectedProject}</h3>
          <p className={styles.muted}>Unchecked views stay hidden for regular users on this project.</p>
          <div className={styles.checkboxList}>
            {CONFIGURABLE_MENU_ITEMS.map((item) => {
              const checked = watchedViews.includes(item.key);
              return (
                <label
                  key={item.key}
                  className={`${styles.checkboxRow} ${checked ? styles.checkboxRowChecked : ''}`}
                >
                  <input
                    type="checkbox"
                    value={item.key}
                    className={styles.checkbox}
                    disabled={pending}
                    {...register('enabledViews')}
                  />
                  <span>{item.label}</span>
                </label>
              );
            })}
          </div>
          <div className={styles.formActions}>
            {wasSaved && <span className={styles.success}>Menu visibility saved</span>}
            <button type="submit" className={styles.primaryButton} disabled={pending || !selectedProject}>
              {pending ? 'Saving...' : 'Save menu visibility'}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
};

const createFlagSchema = z.object({
  key: z
    .string()
    .min(1, 'Key is required')
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Must be kebab-case (e.g. my-feature)'),
  description: z.string().optional(),
});

type CreateFlagFormValues = z.infer<typeof createFlagSchema>;

interface TypeaheadOption {
  value: string;
  label: string;
  searchText: string;
}

interface TypeaheadMultiSelectProps {
  id: string;
  label: string;
  placeholder: string;
  options: TypeaheadOption[];
  selectedValues: string[];
  onChange: (values: string[]) => void;
  disabled?: boolean;
  emptyMessage?: string;
}

const TypeaheadMultiSelect: React.FC<TypeaheadMultiSelectProps> = ({
  id,
  label,
  placeholder,
  options,
  selectedValues,
  onChange,
  disabled = false,
  emptyMessage = 'No matches found.',
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const selectedSet = useMemo(() => new Set(selectedValues), [selectedValues]);
  const selectedOptions = useMemo(
    () => selectedValues.map((value) => {
      const option = options.find((entry) => entry.value === value);
      return { value, label: option?.label ?? value };
    }),
    [options, selectedValues],
  );
  const filteredOptions = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    return options
      .filter((option) => !selectedSet.has(option.value))
      .filter((option) => !normalizedQuery || option.searchText.toLowerCase().includes(normalizedQuery))
      .slice(0, 12);
  }, [options, searchQuery, selectedSet]);

  const handleAdd = (value: string) => {
    if (selectedSet.has(value)) return;
    onChange([...selectedValues, value]);
    setSearchQuery('');
  };

  const handleRemove = (value: string) => {
    onChange(selectedValues.filter((entry) => entry !== value));
  };

  return (
    <div className={styles.flagAddRuleTarget}>
      <label className={styles.label} htmlFor={id}>{label}</label>
      <div className={styles.selectedUserList} aria-label={`${label} selected`}>
        {selectedOptions.length === 0 ? (
          <p className={styles.muted}>None selected</p>
        ) : (
          selectedOptions.map((option) => (
            <span key={option.value} className={styles.userChip}>
              <span>{option.label}</span>
              <button
                type="button"
                className={styles.chipRemoveButton}
                onClick={() => handleRemove(option.value)}
                disabled={disabled}
                aria-label={`Remove ${option.label}`}
              >
                &times;
              </button>
            </span>
          ))
        )}
      </div>
      <input
        id={id}
        className={styles.input}
        type="search"
        value={searchQuery}
        placeholder={placeholder}
        disabled={disabled || options.length === 0}
        onChange={(event) => setSearchQuery(event.target.value)}
        autoComplete="off"
      />
      {options.length === 0 ? (
        <p className={styles.muted}>{emptyMessage}</p>
      ) : (
        <div className={styles.suggestionList} role="listbox" aria-label={`${label} matches`}>
          {filteredOptions.length > 0 ? (
            filteredOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={styles.suggestionButton}
                onClick={() => handleAdd(option.value)}
                disabled={disabled}
                role="option"
                aria-selected={false}
              >
                <span className={styles.userName}>{option.label}</span>
              </button>
            ))
          ) : (
            <p className={styles.muted}>{emptyMessage}</p>
          )}
        </div>
      )}
    </div>
  );
};

interface FlagTargetingCatalog {
  projects: string[];
  users: PlatformAdminUser[];
  groups: PlatformAdminGroup[];
}

const LIFECYCLE_OPTIONS: FlagLifecycle[] = ['active', 'stale', 'archived'];

const FeatureFlagsSection: React.FC = () => {
  const { data: flags = [], isLoading, isError, error } = useFeatureFlagsList();
  const { data: projectList = [] } = usePlatformAdminProjects();
  const { data: users = [] } = usePlatformAdminUsers();
  const { data: groups = [] } = usePlatformAdminGroups();
  const createFlag = useCreateFeatureFlag();
  const updateFlag = useUpdateFeatureFlag();
  const deleteFlag = useDeleteFeatureFlag();
  const [expandedFlagId, setExpandedFlagId] = useState<string | null>(null);
  const [auditFlagId, setAuditFlagId] = useState<string | null>(null);
  const [pendingDeleteFlag, setPendingDeleteFlag] = useState<FeatureFlagWithRules | null>(null);
  const targetingCatalog = useMemo<FlagTargetingCatalog>(() => ({
    projects: [...new Set(projectList.map((project) => project.name))].sort((a, b) => a.localeCompare(b)),
    users,
    groups,
  }), [projectList, users, groups]);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors: formErrors, isSubmitting },
  } = useForm<CreateFlagFormValues>({
    resolver: zodResolver(createFlagSchema),
    defaultValues: { key: '', description: '' },
  });

  const onCreateSubmit = async (values: CreateFlagFormValues) => {
    await createFlag.mutateAsync({
      key: values.key,
      description: values.description || undefined,
    });
    reset();
  };

  const handleToggleEnabled = (flag: FeatureFlagWithRules) => {
    void updateFlag.mutateAsync({ id: flag.id, enabled: !flag.enabled });
  };

  const handleLifecycleChange = (flag: FeatureFlagWithRules, lifecycle: FlagLifecycle) => {
    void updateFlag.mutateAsync({ id: flag.id, lifecycle });
  };

  const handleCleanupReadyChange = (flag: FeatureFlagWithRules, cleanupReady: boolean) => {
    void updateFlag.mutateAsync({ id: flag.id, cleanupReady });
  };

  const handleDeleteRequest = (flag: FeatureFlagWithRules) => {
    setPendingDeleteFlag(flag);
  };

  const handleConfirmDelete = () => {
    if (!pendingDeleteFlag) return;

    const flagId = pendingDeleteFlag.id;
    deleteFlag.mutate(
      { id: flagId },
      {
        onSuccess: () => {
          setPendingDeleteFlag(null);
          setExpandedFlagId((current) => (current === flagId ? null : current));
          setAuditFlagId((current) => (current === flagId ? null : current));
        },
      },
    );
  };

  if (isLoading) return <p className={styles.muted}>Loading feature flags...</p>;
  if (isError) return <p className={styles.fieldError}>{formatError(error)}</p>;

  return (
    <section className={styles.section} aria-labelledby="feature-flags-title">
      <div className={styles.sectionHeader}>
        <div>
          <h2 id="feature-flags-title" className={styles.sectionTitle}>Feature Flags</h2>
          <p className={styles.sectionHint}>
            Create, toggle, and manage targeting rules for feature flags across the platform.
          </p>
        </div>
        <span className={styles.countBadge}>{flags.length} flags</span>
      </div>

      <form className={styles.flagCreateForm} onSubmit={(e) => void handleSubmit(onCreateSubmit)(e)}>
        <h3 className={styles.cardTitle}>Create new flag</h3>
        <div className={styles.flagCreateFields}>
          <div className={styles.flagField}>
            <label className={styles.label} htmlFor="flag-key-input">Key</label>
            <input
              id="flag-key-input"
              className={styles.input}
              placeholder="my-new-feature"
              disabled={isSubmitting || createFlag.isPending}
              {...register('key')}
            />
            {formErrors.key && <p className={styles.fieldError}>{formErrors.key.message}</p>}
          </div>
          <div className={styles.flagField}>
            <label className={styles.label} htmlFor="flag-desc-input">Description (optional)</label>
            <input
              id="flag-desc-input"
              className={styles.input}
              placeholder="What this flag controls"
              disabled={isSubmitting || createFlag.isPending}
              {...register('description')}
            />
          </div>
          <button
            type="submit"
            className={styles.primaryButton}
            disabled={isSubmitting || createFlag.isPending}
          >
            {createFlag.isPending ? 'Creating...' : 'Create flag'}
          </button>
        </div>
        {createFlag.error && <p className={styles.fieldError}>{formatError(createFlag.error)}</p>}
      </form>

      {flags.length === 0 ? (
        <p className={styles.muted}>No feature flags yet. Create one above.</p>
      ) : (
        <div className={styles.flagList}>
          {flags.map((flag) => (
            <FlagCard
              key={flag.id}
              flag={flag}
              targetingCatalog={targetingCatalog}
              isExpanded={expandedFlagId === flag.id}
              showAudit={auditFlagId === flag.id}
              onToggleExpand={() => setExpandedFlagId(expandedFlagId === flag.id ? null : flag.id)}
              onToggleAudit={() => setAuditFlagId(auditFlagId === flag.id ? null : flag.id)}
              onToggleEnabled={() => handleToggleEnabled(flag)}
              onLifecycleChange={(lc) => handleLifecycleChange(flag, lc)}
              onCleanupReadyChange={(cr) => handleCleanupReadyChange(flag, cr)}
              onDelete={() => handleDeleteRequest(flag)}
            />
          ))}
        </div>
      )}

      {deleteFlag.error && !pendingDeleteFlag && (
        <p className={styles.fieldError}>{formatError(deleteFlag.error)}</p>
      )}

      {pendingDeleteFlag && (
        <ConfirmDeleteModal
          title="Delete Feature Flag"
          itemName={pendingDeleteFlag.key}
          description="Are you sure you want to permanently delete the feature flag"
          isPending={deleteFlag.isPending}
          onConfirm={handleConfirmDelete}
          onCancel={() => {
            if (!deleteFlag.isPending) {
              setPendingDeleteFlag(null);
              deleteFlag.reset();
            }
          }}
        />
      )}
    </section>
  );
};

interface FlagCardProps {
  flag: FeatureFlagWithRules;
  targetingCatalog: FlagTargetingCatalog;
  isExpanded: boolean;
  showAudit: boolean;
  onToggleExpand: () => void;
  onToggleAudit: () => void;
  onToggleEnabled: () => void;
  onLifecycleChange: (lifecycle: FlagLifecycle) => void;
  onCleanupReadyChange: (cleanupReady: boolean) => void;
  onDelete: () => void;
}

const FlagCard: React.FC<FlagCardProps> = ({
  flag,
  targetingCatalog,
  isExpanded,
  showAudit,
  onToggleExpand,
  onToggleAudit,
  onToggleEnabled,
  onLifecycleChange,
  onCleanupReadyChange,
  onDelete,
}) => {
  const addRule = useAddFlagRule();
  const removeRule = useRemoveFlagRule();
  const { data: auditEntries = [], isLoading: auditLoading } = useFlagAudit(showAudit ? flag.id : null);
  const [ruleType, setRuleType] = useState<FlagRuleType>('project');
  const [selectedTargets, setSelectedTargets] = useState<string[]>([]);

  const usersById = useMemo(() => {
    const lookup = new Map<string, PlatformAdminUser>();
    targetingCatalog.users.forEach((user) => lookup.set(user.userId, user));
    return lookup;
  }, [targetingCatalog.users]);

  const groupsById = useMemo(() => {
    const lookup = new Map<string, PlatformAdminGroup>();
    targetingCatalog.groups.forEach((group) => lookup.set(group.id, group));
    return lookup;
  }, [targetingCatalog.groups]);

  const hasEveryoneRule = useMemo(
    () => flag.rules.some((rule) => rule.type === 'everyone'),
    [flag.rules],
  );

  useEffect(() => {
    setSelectedTargets([]);
  }, [ruleType]);

  const targetOptions = useMemo<TypeaheadOption[]>(() => {
    if (ruleType === 'project') {
      return targetingCatalog.projects
        .filter((project) => !flag.rules.some((rule) => rule.type === 'project' && rule.value === project))
        .map((project) => ({
          value: project,
          label: project,
          searchText: project,
        }));
    }

    if (ruleType === 'user') {
      return targetingCatalog.users
        .filter((user) => !flag.rules.some((rule) => rule.type === 'user' && rule.value === user.userId))
        .map((user) => ({
          value: user.userId,
          label: getUserLabel(user),
          searchText: [user.displayName, user.email, user.userId].filter(Boolean).join(' '),
        }));
    }

    if (ruleType === 'group') {
      const seenNames = new Set<string>();
      const options: TypeaheadOption[] = [];

      targetingCatalog.groups.forEach((group) => {
        if (seenNames.has(group.name)) return;
        seenNames.add(group.name);

        const groupIds = targetingCatalog.groups
          .filter((entry) => entry.name === group.name)
          .map((entry) => entry.id);
        const allAdded = groupIds.every((groupId) =>
          flag.rules.some((rule) => rule.type === 'group' && rule.value === groupId),
        );
        if (allAdded) return;

        options.push({
          value: group.name,
          label: group.name,
          searchText: group.name,
        });
      });

      return options.sort((a, b) => a.label.localeCompare(b.label));
    }

    return [];
  }, [flag.rules, ruleType, targetingCatalog.groups, targetingCatalog.projects, targetingCatalog.users]);

  const formatRuleLabel = (rule: FeatureFlagRule): string | null => {
    if (!rule.value) return null;
    if (rule.type === 'user') {
      const user = usersById.get(rule.value);
      return user ? getUserLabel(user) : rule.value;
    }
    if (rule.type === 'group') {
      const group = groupsById.get(rule.value);
      if (!group) return rule.value;
      return group.project ? `${group.name} (${group.project})` : group.name;
    }
    return rule.value;
  };

  const handleAddRules = async () => {
    if (ruleType === 'everyone') {
      if (hasEveryoneRule) return;
      await addRule.mutateAsync({ flagId: flag.id, type: 'everyone' });
      return;
    }

    if (selectedTargets.length === 0) return;

    const payloads: Array<{ type: FlagRuleType; value?: string }> = [];

    if (ruleType === 'project' || ruleType === 'user') {
      selectedTargets.forEach((value) => {
        if (!flag.rules.some((rule) => rule.type === ruleType && rule.value === value)) {
          payloads.push({ type: ruleType, value });
        }
      });
    } else if (ruleType === 'group') {
      selectedTargets.forEach((groupName) => {
        targetingCatalog.groups
          .filter((group) => group.name === groupName)
          .forEach((group) => {
            if (!flag.rules.some((rule) => rule.type === 'group' && rule.value === group.id)) {
              payloads.push({ type: 'group', value: group.id });
            }
          });
      });
    }

    for (const payload of payloads) {
      await addRule.mutateAsync({ flagId: flag.id, ...payload });
    }

    setSelectedTargets([]);
  };

  const handleRemoveRule = (ruleId: string) => {
    void removeRule.mutateAsync({ flagId: flag.id, ruleId });
  };

  const rulePending = addRule.isPending;
  const canAddEveryone = ruleType === 'everyone' && !hasEveryoneRule;
  const canAddTargets = ruleType !== 'everyone' && selectedTargets.length > 0;

  return (
    <article className={styles.flagCard}>
      <div className={styles.flagCardHeader}>
        <div className={styles.flagCardMeta}>
          <code className={styles.flagKey}>{flag.key}</code>
          <span className={`${styles.lifecycleBadge} ${styles[`lifecycle_${flag.lifecycle}`]}`}>
            {flag.lifecycle}
          </span>
          {flag.cleanupReady && <span className={styles.cleanupBadge}>cleanup ready</span>}
        </div>
        <div className={styles.flagCardActions}>
          <label className={styles.toggleLabel}>
            <input
              type="checkbox"
              className={styles.toggleInput}
              checked={flag.enabled}
              onChange={onToggleEnabled}
            />
            <span className={`${styles.toggleTrack} ${flag.enabled ? styles.toggleTrackOn : ''}`}>
              <span className={styles.toggleThumb} />
            </span>
            <span className={styles.toggleText}>{flag.enabled ? 'On' : 'Off'}</span>
          </label>
          <button type="button" className={styles.secondaryButton} onClick={onDelete}>
            Delete
          </button>
        </div>
      </div>

      {flag.description && <p className={styles.muted}>{flag.description}</p>}

      <div className={styles.flagControls}>
        <div className={styles.flagField}>
          <label className={styles.label}>Lifecycle</label>
          <select
            className={styles.input}
            value={flag.lifecycle}
            onChange={(e) => onLifecycleChange(e.target.value as FlagLifecycle)}
          >
            {LIFECYCLE_OPTIONS.map((lc) => (
              <option key={lc} value={lc}>{lc}</option>
            ))}
          </select>
        </div>
        <label className={styles.checkboxRow}>
          <input
            type="checkbox"
            className={styles.checkbox}
            checked={flag.cleanupReady}
            onChange={(e) => onCleanupReadyChange(e.target.checked)}
          />
          <span>Cleanup ready</span>
        </label>
      </div>

      <div className={styles.flagExpandRow}>
        <button type="button" className={styles.secondaryButton} onClick={onToggleExpand}>
          {isExpanded ? 'Hide rules' : `Rules (${flag.rules.length})`}
        </button>
        <button type="button" className={styles.secondaryButton} onClick={onToggleAudit}>
          {showAudit ? 'Hide audit' : 'Audit log'}
        </button>
      </div>

      {isExpanded && (
        <div className={styles.flagRulesSection}>
          {flag.rules.length === 0 ? (
            <p className={styles.muted}>No targeting rules. Flag applies to no one (unless toggled with &quot;everyone&quot; rule).</p>
          ) : (
            <div className={styles.flagRuleList}>
              {flag.rules.map((rule) => {
                const ruleLabel = formatRuleLabel(rule);
                return (
                <div key={rule.id} className={styles.flagRuleRow}>
                  <span className={styles.flagRuleType}>{rule.type}</span>
                  {ruleLabel && (
                    <span className={styles.flagRuleValue}>{ruleLabel}</span>
                  )}
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => handleRemoveRule(rule.id)}
                    disabled={removeRule.isPending}
                  >
                    Remove
                  </button>
                </div>
                );
              })}
            </div>
          )}

          <div className={styles.flagAddRuleForm}>
            <div className={styles.flagAddRuleRow}>
              <div className={styles.flagField}>
                <label className={styles.label} htmlFor={`flag-rule-type-${flag.id}`}>Target type</label>
                <select
                  id={`flag-rule-type-${flag.id}`}
                  className={styles.input}
                  value={ruleType}
                  disabled={rulePending}
                  onChange={(event) => setRuleType(event.target.value as FlagRuleType)}
                >
                  <option value="everyone">everyone</option>
                  <option value="project">project</option>
                  <option value="user">user</option>
                  <option value="group">group</option>
                </select>
              </div>
              <button
                type="button"
                className={styles.primaryButton}
                disabled={rulePending || (!canAddEveryone && !canAddTargets)}
                onClick={() => void handleAddRules()}
              >
                {rulePending ? 'Adding...' : ruleType === 'everyone' ? 'Add rule' : 'Add rules'}
              </button>
            </div>

            {ruleType === 'project' && (
              <TypeaheadMultiSelect
                id={`flag-rule-projects-${flag.id}`}
                label="Projects"
                placeholder="Search projects"
                options={targetOptions}
                selectedValues={selectedTargets}
                onChange={setSelectedTargets}
                disabled={rulePending}
                emptyMessage="No matching projects found."
              />
            )}

            {ruleType === 'user' && (
              <TypeaheadMultiSelect
                id={`flag-rule-users-${flag.id}`}
                label="Users"
                placeholder="Search by name, email, or user ID"
                options={targetOptions}
                selectedValues={selectedTargets}
                onChange={setSelectedTargets}
                disabled={rulePending}
                emptyMessage="No matching users found."
              />
            )}

            {ruleType === 'group' && (
              <TypeaheadMultiSelect
                id={`flag-rule-groups-${flag.id}`}
                label="Groups"
                placeholder="Search group names"
                options={targetOptions}
                selectedValues={selectedTargets}
                onChange={setSelectedTargets}
                disabled={rulePending}
                emptyMessage="No matching groups found."
              />
            )}

            {ruleType === 'everyone' && hasEveryoneRule && (
              <p className={styles.muted}>An &quot;everyone&quot; rule already exists for this flag.</p>
            )}
          </div>
          {addRule.error && <p className={styles.fieldError}>{formatError(addRule.error)}</p>}
        </div>
      )}

      {showAudit && (
        <div className={styles.flagAuditSection}>
          {auditLoading ? (
            <p className={styles.muted}>Loading audit log...</p>
          ) : auditEntries.length === 0 ? (
            <p className={styles.muted}>No audit entries.</p>
          ) : (
            <div className={styles.flagAuditList}>
              {auditEntries.map((entry) => (
                <div key={entry.id} className={styles.flagAuditRow}>
                  <span className={styles.flagAuditAction}>{entry.action}</span>
                  <span className={styles.muted}>{entry.actorEmail ?? entry.actorId ?? 'system'}</span>
                  <span className={styles.muted}>{new Date(entry.createdAt).toLocaleString()}</span>
                  {entry.details && (
                    <code className={styles.flagAuditDetails}>{JSON.stringify(entry.details)}</code>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
};

export default PlatformAdmin;
