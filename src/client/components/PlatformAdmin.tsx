import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  useApproveProjectAccessRequest,
  usePlatformAdminAccessRequests,
  usePlatformAdminAssignments,
  usePlatformAdminMenuConfigs,
  usePlatformAdminProjects,
  usePlatformAdminUsers,
  useRejectProjectAccessRequest,
  useSetPlatformAdminAssignments,
  useSetPlatformAdminMenuConfig,
} from '../hooks/usePlatformAdmin';
import { CONFIGURABLE_MENU_ITEMS } from '../../shared/types/menuSettings';
import type { MenuItemKey } from '../../shared/types/menuSettings';
import type { PlatformAdminAccessRequest, PlatformAdminUser, ProjectAssignmentGroup } from '../../shared/types/platformAdmin';
import styles from './PlatformAdmin.module.css';

const menuSchema = z.object({
  enabledViews: z.array(z.enum(['calendar', 'planning', 'cloudcost', 'backlog'])),
});

type MenuFormValues = z.infer<typeof menuSchema>;

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

interface PlatformAdminProps {
  onBackToProjects: () => void;
}

export const PlatformAdmin: React.FC<PlatformAdminProps> = ({ onBackToProjects }) => {
  const [selectedMenuProject, setSelectedMenuProject] = useState<string>('');
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

  const handleSaveAssignments = useCallback(async (project: string, userIds: string[]) => {
    setAssignmentSavedProject(null);
    await setAssignments.mutateAsync({ project, userIds });
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

          <MenuVisibilitySection
            projectNames={projectNames}
            selectedProject={selectedMenuProject}
            enabledViews={menuConfigByProject.get(selectedMenuProject)?.enabledViews ?? []}
            isSaving={setMenuConfig.isPending}
            wasSaved={menuSavedProject === selectedMenuProject}
            onSelectProject={setSelectedMenuProject}
            onSave={handleSaveMenuConfig}
          />
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
  onSave: (project: string, userIds: string[]) => Promise<void>;
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

  useEffect(() => {
    setSelectedUserIds(currentUserIds);
    setSearchQuery('');
    setImportMessage(null);
  }, [currentUserIds]);

  const handleAddUser = (userId: string) => {
    setSelectedUserIds((prev) => (prev.includes(userId) ? prev : [...prev, userId]));
    setSearchQuery('');
    setImportMessage(null);
  };

  const handleRemoveUser = (userId: string) => {
    setSelectedUserIds((prev) => prev.filter((id) => id !== userId));
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
    let unmatchedCount = 0;
    const seenEntries = new Set<string>();

    entries.forEach((entry) => {
      const token = entry.trim();
      if (!token) return;
      const normalizedToken = token.toLowerCase();
      if (seenEntries.has(normalizedToken)) return;
      seenEntries.add(normalizedToken);

      const matchedUser = usersById.get(token) ?? usersByEmail.get(normalizedToken);
      if (matchedUser) {
        matchedIds.push(matchedUser.userId);
      } else {
        unmatchedCount += 1;
      }
    });

    const selected = new Set(selectedUserIds);
    const addedIds = matchedIds.filter((userId) => !selected.has(userId));
    setSelectedUserIds([...selectedUserIds, ...addedIds]);
    setImportMessage(
      `Imported ${addedIds.length} user${addedIds.length === 1 ? '' : 's'}${unmatchedCount > 0 ? `; ${unmatchedCount} unmatched` : ''}.`,
    );
  };

  const handleSubmitAssignments = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await onSave(group.project, selectedUserIds);
  };

  const pending = isSaving;
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
            disabled={pending || availableUsers.length === 0}
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
            Choose which configurable app views appear in navigation for each project.
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

export default PlatformAdmin;
