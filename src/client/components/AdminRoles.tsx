import React, { useState, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  useRoles,
  usePermissions,
  useCreateRole,
  useUpdateRole,
  useDeleteRole,
  useUpdateRolePermissions,
  useUsers,
  useAssignRole,
  useRemoveRole,
} from '../hooks/useRbac';
import type { AppPermission, RoleWithPermissions } from '../../shared/types/rbac';
import styles from './AdminRoles.module.css';

// ── Schemas ───────────────────────────────────────────────────────────────

const roleSchema = z.object({
  name: z.string().min(1, 'Name is required').max(64, 'Name must be 64 characters or less'),
  description: z.string().max(256, 'Description must be 256 characters or less').optional(),
  isDefault: z.boolean().optional(),
});

type RoleFormValues = z.infer<typeof roleSchema>;

// ── CreateEditRoleModal ───────────────────────────────────────────────────

interface CreateEditRoleModalProps {
  role?: RoleWithPermissions;
  onClose: () => void;
}

const CreateEditRoleModal: React.FC<CreateEditRoleModalProps> = ({ role, onClose }) => {
  const createRole = useCreateRole();
  const updateRole = useUpdateRole();
  const isEdit = !!role;

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<RoleFormValues>({
    resolver: zodResolver(roleSchema),
    defaultValues: {
      name: role?.name ?? '',
      description: role?.description ?? '',
      isDefault: role?.isDefault ?? false,
    },
  });

  const onSubmit = async (values: RoleFormValues) => {
    try {
      if (isEdit) {
        await updateRole.mutateAsync({ id: role!.id, ...values });
      } else {
        await createRole.mutateAsync({ name: values.name, description: values.description });
      }
      onClose();
    } catch {
      // error displayed via mutation.error below
    }
  };

  const isPending = createRole.isPending || updateRole.isPending;
  const mutationError = createRole.error ?? updateRole.error;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="role-modal-title">
      <div className={styles.modal}>
        <div className={styles.modalHeader}>
          <h2 className={styles.modalTitle} id="role-modal-title">
            {isEdit ? 'Edit Role' : 'Create Role'}
          </h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit(onSubmit)}>
          <div className={styles.modalBody}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="role-name">
                Name *
              </label>
              <input
                id="role-name"
                className={styles.input}
                {...register('name')}
                placeholder="e.g. developer, viewer"
                autoFocus
              />
              {errors.name && <span className={styles.fieldError}>{errors.name.message}</span>}
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="role-desc">
                Description <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span>
              </label>
              <textarea
                id="role-desc"
                className={styles.textarea}
                {...register('description')}
                placeholder="Describe what this role can do…"
                rows={3}
              />
              {errors.description && (
                <span className={styles.fieldError}>{errors.description.message}</span>
              )}
            </div>

            {isEdit && (
              <div className={styles.checkField}>
                <input
                  type="checkbox"
                  id="role-default"
                  className={styles.checkbox}
                  {...register('isDefault')}
                />
                <label htmlFor="role-default" className={styles.checkLabel}>
                  Set as default role for new users
                </label>
              </div>
            )}

            {mutationError && <div className={styles.error}>{mutationError.message}</div>}
          </div>

          <div className={styles.modalFooter}>
            <button type="button" className={styles.btnCancel} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className={styles.btnPrimary} disabled={isPending}>
              {isPending
                ? isEdit
                  ? 'Saving…'
                  : 'Creating…'
                : isEdit
                  ? 'Save Changes'
                  : 'Create Role'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// ── DeleteConfirmModal ────────────────────────────────────────────────────

interface DeleteConfirmModalProps {
  role: RoleWithPermissions;
  onClose: () => void;
}

const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({ role, onClose }) => {
  const deleteRole = useDeleteRole();

  const handleDelete = async () => {
    try {
      await deleteRole.mutateAsync(role.id);
      onClose();
    } catch {
      // error displayed via deleteRole.error below
    }
  };

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="delete-modal-title">
      <div className={`${styles.modal} ${styles.confirmModal}`}>
        <div className={styles.modalHeader}>
          <h2 className={styles.modalTitle} id="delete-modal-title">
            Delete Role
          </h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className={styles.modalBody}>
          <p className={styles.confirmText}>
            Are you sure you want to delete the role <strong>{role.name}</strong>? This action
            cannot be undone.
          </p>

          {role.isDefault && (
            <div className={styles.warning}>
              This is the default role. Default roles cannot be deleted. Remove the default flag
              first via Edit.
            </div>
          )}

          {deleteRole.error && <div className={styles.error}>{deleteRole.error.message}</div>}
        </div>

        <div className={styles.modalFooter}>
          <button className={styles.btnCancel} onClick={onClose}>
            Cancel
          </button>
          <button
            className={styles.btnDanger}
            onClick={handleDelete}
            disabled={deleteRole.isPending || role.isDefault}
          >
            {deleteRole.isPending ? 'Deleting…' : 'Delete Role'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── PermissionsModal ──────────────────────────────────────────────────────

interface PermissionsModalProps {
  role: RoleWithPermissions;
  allPermissions: AppPermission[];
  onClose: () => void;
}

const PermissionsModal: React.FC<PermissionsModalProps> = ({ role, allPermissions, onClose }) => {
  const updatePerms = useUpdateRolePermissions();

  const [selected, setSelected] = useState<Set<string>>(() => {
    const rolePermKeys = new Set(role.permissions);
    return new Set(allPermissions.filter((p) => rolePermKeys.has(p.key)).map((p) => p.id));
  });

  const grouped = useMemo(() => {
    const map = new Map<string, AppPermission[]>();
    for (const p of allPermissions) {
      const cat = p.category ?? 'Other';
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(p);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [allPermissions]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSave = async () => {
    try {
      await updatePerms.mutateAsync({ id: role.id, permissionIds: Array.from(selected) });
      onClose();
    } catch {
      // error displayed via updatePerms.error below
    }
  };

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="perms-modal-title">
      <div className={`${styles.modal} ${styles.permsModal}`}>
        <div className={styles.modalHeader}>
          <div>
            <h2 className={styles.modalTitle} id="perms-modal-title">
              Permissions — {role.name}
            </h2>
            <p className={styles.modalSubtitle}>
              {selected.size} of {allPermissions.length} selected
            </p>
          </div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className={styles.modalBody}>
          {grouped.length === 0 && (
            <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>No permissions defined.</p>
          )}

          {grouped.map(([category, perms]) => (
            <div key={category} className={styles.permGroup}>
              <div className={styles.permGroupHeader}>{category}</div>
              {perms.map((p) => (
                <label key={p.id} className={styles.permRow}>
                  <input
                    type="checkbox"
                    className={styles.checkbox}
                    checked={selected.has(p.id)}
                    onChange={() => toggle(p.id)}
                  />
                  <span className={styles.permKey}>{p.key}</span>
                  {p.description && <span className={styles.permDesc}>{p.description}</span>}
                </label>
              ))}
            </div>
          ))}

          {updatePerms.error && <div className={styles.error}>{updatePerms.error.message}</div>}
        </div>

        <div className={styles.modalFooter}>
          <button className={styles.btnCancel} onClick={onClose}>
            Cancel
          </button>
          <button className={styles.btnPrimary} onClick={handleSave} disabled={updatePerms.isPending}>
            {updatePerms.isPending ? 'Saving…' : 'Save Permissions'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── RoleMembersModal ──────────────────────────────────────────────────────

function getMemberInitial(displayName: string | null, email: string | null): string {
  const source = displayName ?? email ?? '?';
  return source[0].toUpperCase();
}

interface RoleMembersModalProps {
  role: RoleWithPermissions;
  onClose: () => void;
}

const RoleMembersModal: React.FC<RoleMembersModalProps> = ({ role, onClose }) => {
  const { data: users = [], isLoading } = useUsers();
  const assignRole = useAssignRole();
  const removeRole = useRemoveRole();

  const [selectedOid, setSelectedOid] = useState('');
  const [memberSearch, setMemberSearch] = useState('');

  const members = useMemo(
    () => users.filter((u) => u.roles.includes(role.name)),
    [users, role.name],
  );

  const nonMembers = useMemo(
    () => users.filter((u) => !u.roles.includes(role.name)),
    [users, role.name],
  );

  const filteredMembers = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return members;
    return members.filter(
      (u) =>
        (u.displayName?.toLowerCase().includes(q) ?? false) ||
        (u.email?.toLowerCase().includes(q) ?? false),
    );
  }, [members, memberSearch]);

  const handleAdd = () => {
    if (!selectedOid) return;
    assignRole.mutate(
      { oid: selectedOid, roleId: role.id },
      { onSuccess: () => setSelectedOid('') },
    );
  };

  const handleRemove = (oid: string) => {
    removeRole.mutate({ oid, roleId: role.id });
  };

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="members-modal-title">
      <div className={`${styles.modal} ${styles.membersModal}`}>
        <div className={styles.modalHeader}>
          <div>
            <h2 className={styles.modalTitle} id="members-modal-title">
              Members — {role.name}
            </h2>
            <p className={styles.modalSubtitle}>
              {members.length} member{members.length !== 1 ? 's' : ''}
            </p>
          </div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className={styles.modalBody}>
          {/* Add member */}
          <div className={styles.addMemberRow}>
            <select
              className={styles.memberSelect}
              value={selectedOid}
              onChange={(e) => setSelectedOid(e.target.value)}
              disabled={isLoading || assignRole.isPending || nonMembers.length === 0}
              aria-label="Select user to add"
            >
              <option value="">
                {isLoading
                  ? 'Loading users…'
                  : nonMembers.length === 0
                    ? 'All users are members'
                    : 'Add a user…'}
              </option>
              {nonMembers.map((u) => (
                <option key={u.oid} value={u.oid}>
                  {u.displayName ?? u.email ?? u.oid}
                </option>
              ))}
            </select>
            <button
              className={styles.btnPrimary}
              onClick={handleAdd}
              disabled={!selectedOid || isLoading || assignRole.isPending}
              aria-label="Add selected user to role"
            >
              {assignRole.isPending ? 'Adding…' : 'Add'}
            </button>
          </div>

          {assignRole.error && <div className={styles.error}>{assignRole.error.message}</div>}
          {removeRole.error && <div className={styles.error}>{removeRole.error.message}</div>}

          {/* Member search */}
          {members.length > 5 && (
            <input
              className={styles.memberSearch}
              type="text"
              placeholder="Filter members…"
              value={memberSearch}
              onChange={(e) => setMemberSearch(e.target.value)}
              aria-label="Filter members"
            />
          )}

          {/* Member list */}
          {isLoading ? (
            <p className={styles.emptyMembers}>Loading users…</p>
          ) : filteredMembers.length === 0 ? (
            <p className={styles.emptyMembers}>
              {memberSearch ? `No members match "${memberSearch}"` : 'No members assigned yet.'}
            </p>
          ) : (
            <div className={styles.memberList}>
              {filteredMembers.map((u) => (
                <div key={u.oid} className={styles.memberRow}>
                  <span className={styles.memberAvatar} aria-hidden="true">
                    {getMemberInitial(u.displayName, u.email)}
                  </span>
                  <div className={styles.memberInfo}>
                    <span className={styles.memberName}>
                      {u.displayName ?? <em>No name</em>}
                    </span>
                    {u.email && <span className={styles.memberEmail}>{u.email}</span>}
                  </div>
                  <button
                    className={`${styles.btnAction} ${styles.btnActionDanger}`}
                    onClick={() => handleRemove(u.oid)}
                    disabled={removeRole.isPending}
                    title={`Remove ${u.displayName ?? u.email} from role`}
                    aria-label={`Remove ${u.displayName ?? u.email} from ${role.name}`}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className={styles.modalFooter}>
          <button className={styles.btnCancel} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

// ── AdminRoles (main) ─────────────────────────────────────────────────────

export const AdminRoles: React.FC = () => {
  const { data: roles = [], isLoading } = useRoles();
  const { data: allPermissions = [] } = usePermissions();

  const [showCreate, setShowCreate] = useState(false);
  const [editingRole, setEditingRole] = useState<RoleWithPermissions | null>(null);
  const [deletingRole, setDeletingRole] = useState<RoleWithPermissions | null>(null);
  const [managingPermsRole, setManagingPermsRole] = useState<RoleWithPermissions | null>(null);
  const [managingMembersRole, setManagingMembersRole] = useState<RoleWithPermissions | null>(null);

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <div className={styles.pageHeader}>
          <div>
            <h1 className={styles.pageTitle}>Roles</h1>
            <p className={styles.pageSubtitle}>Manage roles and their assigned permissions.</p>
          </div>
          <button className={styles.btnPrimary} onClick={() => setShowCreate(true)}>
            + Create Role
          </button>
        </div>

        {isLoading ? (
          <div className={styles.loading}>Loading roles…</div>
        ) : roles.length === 0 ? (
          <div className={styles.empty}>
            <p>No roles found. Create one to get started.</p>
          </div>
        ) : (
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.th}>Name</th>
                  <th className={styles.th}>Description</th>
                  <th className={styles.th}>Default</th>
                  <th className={styles.th}>Permissions</th>
                  <th className={styles.th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {roles.map((role) => (
                  <tr key={role.id} className={styles.tr}>
                    <td className={styles.td}>
                      <span className={styles.roleName}>{role.name}</span>
                    </td>
                    <td className={styles.td}>
                      <span className={styles.roleDesc}>{role.description ?? '—'}</span>
                    </td>
                    <td className={styles.td}>
                      {role.isDefault ? <span className={styles.badge}>Default</span> : '—'}
                    </td>
                    <td className={styles.td}>
                      <span className={styles.permCount}>{role.permissions.length}</span>
                    </td>
                    <td className={styles.td}>
                      <div className={styles.actions}>
                        <button
                          className={styles.btnAction}
                          onClick={() => setManagingPermsRole(role)}
                          title="Manage permissions"
                        >
                          Permissions
                        </button>
                        <button
                          className={styles.btnAction}
                          onClick={() => setManagingMembersRole(role)}
                          title="Manage members"
                        >
                          Members
                        </button>
                        <button
                          className={styles.btnAction}
                          onClick={() => setEditingRole(role)}
                          title="Edit role"
                        >
                          Edit
                        </button>
                        <button
                          className={`${styles.btnAction} ${styles.btnActionDanger}`}
                          onClick={() => setDeletingRole(role)}
                          title="Delete role"
                          disabled={role.isDefault}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showCreate && <CreateEditRoleModal onClose={() => setShowCreate(false)} />}
      {editingRole && (
        <CreateEditRoleModal role={editingRole} onClose={() => setEditingRole(null)} />
      )}
      {deletingRole && (
        <DeleteConfirmModal role={deletingRole} onClose={() => setDeletingRole(null)} />
      )}
      {managingPermsRole && (
        <PermissionsModal
          role={managingPermsRole}
          allPermissions={allPermissions}
          onClose={() => setManagingPermsRole(null)}
        />
      )}
      {managingMembersRole && (
        <RoleMembersModal
          role={managingMembersRole}
          onClose={() => setManagingMembersRole(null)}
        />
      )}
    </div>
  );
};
