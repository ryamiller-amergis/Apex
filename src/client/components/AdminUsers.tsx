import React, { useState, useMemo } from 'react';
import { useUsers, useRoles, useAssignRole, useRemoveRole, useAssignProjectRole, useRemoveProjectRole } from '../hooks/useRbac';
import type { RoleWithPermissions } from '../../shared/types/rbac';
import styles from './AdminUsers.module.css';

function formatLastSeen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function getInitial(displayName: string | null, email: string | null): string {
  const source = displayName ?? email ?? '?';
  return source[0].toUpperCase();
}

interface AdminUsersProps {
  selectedProject?: string;
}

export const AdminUsers: React.FC<AdminUsersProps> = ({ selectedProject = '' }) => {
  const [search, setSearch] = useState('');
  const [pendingAssign, setPendingAssign] = useState<Record<string, string>>({});
  const [pendingProjectAssign, setPendingProjectAssign] = useState<Record<string, string>>({});

  const { data: users = [], isLoading: usersLoading, error: usersError } = useUsers(selectedProject);
  const { data: roles = [], isLoading: rolesLoading } = useRoles();

  const assignRole = useAssignRole();
  const removeRole = useRemoveRole();
  const assignProjectRole = useAssignProjectRole();
  const removeProjectRole = useRemoveProjectRole();

  const hasProject = Boolean(selectedProject);

  const rolesByName = useMemo<Record<string, RoleWithPermissions>>(() => {
    const map: Record<string, RoleWithPermissions> = {};
    roles.forEach(r => { map[r.name] = r; });
    return map;
  }, [roles]);

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter(u =>
      (u.displayName?.toLowerCase().includes(q) ?? false) ||
      (u.email?.toLowerCase().includes(q) ?? false),
    );
  }, [users, search]);

  const handleAssignRole = (oid: string) => {
    const roleId = pendingAssign[oid];
    if (!roleId) return;
    assignRole.mutate(
      { oid, roleId },
      { onSuccess: () => setPendingAssign(prev => { const n = { ...prev }; delete n[oid]; return n; }) },
    );
  };

  const handleRemoveRole = (oid: string, roleName: string) => {
    const role = rolesByName[roleName];
    if (!role) return;
    removeRole.mutate({ oid, roleId: role.id });
  };

  const handleAssignProjectRole = (oid: string) => {
    const roleId = pendingProjectAssign[oid];
    if (!roleId || !selectedProject) return;
    assignProjectRole.mutate(
      { oid, project: selectedProject, roleId },
      { onSuccess: () => setPendingProjectAssign(prev => { const n = { ...prev }; delete n[oid]; return n; }) },
    );
  };

  const handleRemoveProjectRole = (oid: string, roleName: string) => {
    const role = rolesByName[roleName];
    if (!role || !selectedProject) return;
    removeProjectRole.mutate({ oid, project: selectedProject, roleId: role.id });
  };

  if (usersLoading || rolesLoading) {
    return (
      <div className={styles.container}>
        <div className={styles['page-header']}>
          <h1 className={styles.title}>User Management</h1>
        </div>
        <div className={styles.loading}>
          <div className={styles['loading-spinner']} aria-hidden="true" />
          <span>Loading users…</span>
        </div>
      </div>
    );
  }

  if (usersError) {
    return (
      <div className={styles.container}>
        <div className={styles['page-header']}>
          <h1 className={styles.title}>User Management</h1>
        </div>
        <div className={styles['error-banner']}>
          <svg viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <circle cx="9" cy="9" r="7.5" />
            <path d="M9 5.5v4M9 12.5v.5" strokeLinecap="round" />
          </svg>
          Failed to load users. Please try refreshing the page.
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles['page-header']}>
        <div>
          <h1 className={styles.title}>User Management</h1>
          <p className={styles.subtitle}>
            {users.length} user{users.length !== 1 ? 's' : ''} · assign and manage roles
          </p>
        </div>
      </div>

      <div className={styles.toolbar}>
        <div className={styles['search-wrap']}>
          <svg className={styles['search-icon']} viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <circle cx="7.5" cy="7.5" r="5" />
            <path d="M13 13l2.5 2.5" strokeLinecap="round" />
          </svg>
          <input
            className={styles['search-input']}
            type="text"
            placeholder="Search by name or email…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            aria-label="Search users"
          />
          {search && (
            <button
              className={styles['search-clear']}
              onClick={() => setSearch('')}
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>
        <div className={styles['result-count']} aria-live="polite">
          {search && `${filteredUsers.length} result${filteredUsers.length !== 1 ? 's' : ''}`}
        </div>
      </div>

      {filteredUsers.length === 0 ? (
        <div className={styles.empty}>
          <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
            <circle cx="22" cy="20" r="10" strokeWidth="2" />
            <path d="M8 40a14 14 0 0128 0" strokeWidth="2" strokeLinecap="round" />
            <path d="M32 32l10 10M42 32l-10 10" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <p>{search ? `No users match "${search}"` : 'No users found.'}</p>
        </div>
      ) : (
        <div className={styles['table-wrap']}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.th}>Display Name</th>
                <th className={styles.th}>Email</th>
                <th className={styles.th}>Last Seen</th>
                <th className={styles.th}>Assigned Roles</th>
                <th className={styles.th}>Add Role</th>
                {hasProject && (
                  <th className={styles.th}>Project Roles ({selectedProject})</th>
                )}
                {hasProject && (
                  <th className={styles.th}>Add Project Role</th>
                )}
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map(user => {
                const isAssigning = assignRole.isPending;
                const isRemoving = removeRole.isPending;
                const selectedRoleId = pendingAssign[user.oid] ?? '';
                const availableRoles = roles.filter(r => !user.roles.includes(r.name));
                const projectRoles = user.projectRoles ?? [];
                const selectedProjectRoleId = pendingProjectAssign[user.oid] ?? '';
                const availableProjectRoles = roles.filter(r => !projectRoles.includes(r.name));
                const isAssigningProject = assignProjectRole.isPending;
                const isRemovingProject = removeProjectRole.isPending;

                return (
                  <tr key={user.oid} className={styles.tr}>
                    <td className={styles.td}>
                      <div className={styles['user-cell']}>
                        <span className={styles.avatar} aria-hidden="true">
                          {getInitial(user.displayName, user.email)}
                        </span>
                        <span className={styles['user-name']}>
                          {user.displayName ?? <em className={styles.unnamed}>No name</em>}
                        </span>
                      </div>
                    </td>

                    <td className={styles.td}>
                      <span className={styles.email}>{user.email ?? '—'}</span>
                    </td>

                    <td className={styles.td}>
                      <span
                        className={styles['last-seen']}
                        title={user.lastSeenAt ? new Date(user.lastSeenAt).toLocaleString() : undefined}
                      >
                        {formatLastSeen(user.lastSeenAt)}
                      </span>
                    </td>

                    <td className={styles.td}>
                      <div className={styles.badges}>
                        {user.roles.length === 0 ? (
                          <span className={styles['no-roles']}>None</span>
                        ) : (
                          user.roles.map(roleName => (
                            <span
                              key={roleName}
                              className={`${styles.badge} ${styles[`badge--${roleName}`] ?? styles['badge--default']}`}
                            >
                              {roleName}
                              <button
                                className={styles['badge-remove']}
                                onClick={() => handleRemoveRole(user.oid, roleName)}
                                disabled={isRemoving || !rolesByName[roleName]}
                                title={`Remove role "${roleName}"`}
                                aria-label={`Remove role ${roleName} from ${user.displayName ?? user.email}`}
                              >
                                ×
                              </button>
                            </span>
                          ))
                        )}
                      </div>
                    </td>

                    <td className={styles.td}>
                      <div className={styles['action-row']}>
                        <select
                          className={styles['role-select']}
                          value={selectedRoleId}
                          onChange={e =>
                            setPendingAssign(prev => ({ ...prev, [user.oid]: e.target.value }))
                          }
                          disabled={isAssigning || availableRoles.length === 0}
                          aria-label={`Select role to assign to ${user.displayName ?? user.email}`}
                        >
                          <option value="">
                            {availableRoles.length === 0 ? 'All roles assigned' : 'Select role…'}
                          </option>
                          {availableRoles.map(r => (
                            <option key={r.id} value={r.id}>{r.name}</option>
                          ))}
                        </select>
                        <button
                          className={styles['assign-btn']}
                          onClick={() => handleAssignRole(user.oid)}
                          disabled={!selectedRoleId || isAssigning}
                          aria-label={`Assign selected role to ${user.displayName ?? user.email}`}
                        >
                          {isAssigning ? '…' : 'Assign'}
                        </button>
                      </div>
                    </td>

                    {hasProject && (
                      <td className={styles.td}>
                        <div
                          className={styles.badges}
                          data-testid={`project-roles-${user.oid}`}
                        >
                          {projectRoles.length === 0 ? (
                            <span className={styles['no-roles']}>None</span>
                          ) : (
                            projectRoles.map(roleName => (
                              <span
                                key={roleName}
                                className={`${styles['badge-project']} ${styles[`badge--${roleName}`] ?? styles['badge--default']}`}
                              >
                                {roleName}
                                <button
                                  className={styles['badge-remove']}
                                  onClick={() => handleRemoveProjectRole(user.oid, roleName)}
                                  disabled={isRemovingProject || !rolesByName[roleName]}
                                  title={`Remove project role "${roleName}"`}
                                  aria-label={`Remove project role ${roleName} from ${user.displayName ?? user.email}`}
                                >
                                  ×
                                </button>
                              </span>
                            ))
                          )}
                        </div>
                      </td>
                    )}

                    {hasProject && (
                      <td className={styles.td}>
                        <div className={styles['action-row']}>
                          <select
                            className={styles['role-select']}
                            value={selectedProjectRoleId}
                            onChange={e =>
                              setPendingProjectAssign(prev => ({ ...prev, [user.oid]: e.target.value }))
                            }
                            disabled={isAssigningProject || availableProjectRoles.length === 0}
                            aria-label={`Select project role to assign to ${user.displayName ?? user.email}`}
                          >
                            <option value="">
                              {availableProjectRoles.length === 0 ? 'All roles assigned' : 'Select role…'}
                            </option>
                            {availableProjectRoles.map(r => (
                              <option key={r.id} value={r.id}>{r.name}</option>
                            ))}
                          </select>
                          <button
                            className={styles['assign-btn']}
                            onClick={() => handleAssignProjectRole(user.oid)}
                            disabled={!selectedProjectRoleId || isAssigningProject}
                            aria-label={`Assign project role to ${user.displayName ?? user.email}`}
                          >
                            {isAssigningProject ? '…' : 'Assign'}
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
