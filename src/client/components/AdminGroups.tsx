import React, { useState, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  useGroupsWithMembers,
  useGroupWithMembers,
  useCreateGroup,
  useUpdateGroup,
  useDeleteGroup,
  useSetGroupMembers,
} from '../hooks/useGroups';
import { useUsers } from '../hooks/useRbac';
import type { AppGroup } from '../../shared/types/groups';
import styles from './AdminGroups.module.css';

// ── Schemas ───────────────────────────────────────────────────────────────

const groupSchema = z.object({
  name: z.string().min(1, 'Name is required').max(64, 'Name must be 64 characters or less'),
  description: z.string().max(256, 'Description must be 256 characters or less').optional(),
});

type GroupFormValues = z.infer<typeof groupSchema>;

// ── CreateEditGroupModal ──────────────────────────────────────────────────

interface CreateEditGroupModalProps {
  group?: AppGroup;
  onClose: () => void;
}

const CreateEditGroupModal: React.FC<CreateEditGroupModalProps> = ({ group, onClose }) => {
  const createGroup = useCreateGroup();
  const updateGroup = useUpdateGroup();
  const isEdit = !!group;

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<GroupFormValues>({
    resolver: zodResolver(groupSchema),
    defaultValues: {
      name: group?.name ?? '',
      description: group?.description ?? '',
    },
  });

  const onSubmit = async (values: GroupFormValues) => {
    try {
      if (isEdit) {
        await updateGroup.mutateAsync({ id: group!.id, ...values });
      } else {
        await createGroup.mutateAsync({ name: values.name, description: values.description });
      }
      onClose();
    } catch {
      // error displayed via mutation.error below
    }
  };

  const isPending = createGroup.isPending || updateGroup.isPending;
  const mutationError = createGroup.error ?? updateGroup.error;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="group-modal-title">
      <div className={styles.modal}>
        <div className={styles.modalHeader}>
          <h2 className={styles.modalTitle} id="group-modal-title">
            {isEdit ? 'Edit Group' : 'Create Group'}
          </h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit(onSubmit)}>
          <div className={styles.modalBody}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="group-name">
                Name *
              </label>
              <input
                id="group-name"
                className={styles.input}
                {...register('name')}
                placeholder="e.g. backend-team, design-reviewers"
                autoFocus
              />
              {errors.name && <span className={styles.fieldError}>{errors.name.message}</span>}
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="group-desc">
                Description <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span>
              </label>
              <textarea
                id="group-desc"
                className={styles.textarea}
                {...register('description')}
                placeholder="Describe the purpose of this group…"
                rows={3}
              />
              {errors.description && (
                <span className={styles.fieldError}>{errors.description.message}</span>
              )}
            </div>

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
                  : 'Create Group'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// ── DeleteConfirmModal ────────────────────────────────────────────────────

interface DeleteConfirmModalProps {
  group: AppGroup;
  onClose: () => void;
}

const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({ group, onClose }) => {
  const deleteGroup = useDeleteGroup();

  const handleDelete = async () => {
    try {
      await deleteGroup.mutateAsync(group.id);
      onClose();
    } catch {
      // error displayed via deleteGroup.error below
    }
  };

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="delete-modal-title">
      <div className={`${styles.modal} ${styles.confirmModal}`}>
        <div className={styles.modalHeader}>
          <h2 className={styles.modalTitle} id="delete-modal-title">
            Delete Group
          </h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className={styles.modalBody}>
          <p className={styles.confirmText}>
            Are you sure you want to delete the group <strong>{group.name}</strong>? This action
            cannot be undone.
          </p>

          {deleteGroup.error && <div className={styles.error}>{deleteGroup.error.message}</div>}
        </div>

        <div className={styles.modalFooter}>
          <button className={styles.btnCancel} onClick={onClose}>
            Cancel
          </button>
          <button
            className={styles.btnDanger}
            onClick={handleDelete}
            disabled={deleteGroup.isPending}
          >
            {deleteGroup.isPending ? 'Deleting…' : 'Delete Group'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── GroupMembersModal ─────────────────────────────────────────────────────

function getMemberInitial(displayName: string | null, email: string | null): string {
  const source = displayName ?? email ?? '?';
  return source[0].toUpperCase();
}

interface GroupMembersModalProps {
  group: AppGroup;
  onClose: () => void;
}

const GroupMembersModal: React.FC<GroupMembersModalProps> = ({ group, onClose }) => {
  const { data: groupWithMembers, isLoading: isLoadingGroup } = useGroupWithMembers(group.id);
  const { data: users = [], isLoading: isLoadingUsers } = useUsers();
  const setMembers = useSetGroupMembers();

  const [memberSearch, setMemberSearch] = useState('');
  const [selectedOid, setSelectedOid] = useState('');

  const members = groupWithMembers?.members ?? [];

  const memberOids = useMemo(() => new Set(members.map((m) => m.userId)), [members]);

  const nonMembers = useMemo(
    () => users.filter((u) => !memberOids.has(u.oid)),
    [users, memberOids],
  );

  const filteredMembers = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return members;
    return members.filter(
      (m) =>
        (m.displayName?.toLowerCase().includes(q) ?? false) ||
        (m.email?.toLowerCase().includes(q) ?? false),
    );
  }, [members, memberSearch]);

  const handleAdd = () => {
    if (!selectedOid) return;
    const newUserIds = [...Array.from(memberOids), selectedOid];
    setMembers.mutate(
      { groupId: group.id, userIds: newUserIds },
      { onSuccess: () => setSelectedOid('') },
    );
  };

  const handleRemove = (userId: string) => {
    const newUserIds = Array.from(memberOids).filter((id) => id !== userId);
    setMembers.mutate({ groupId: group.id, userIds: newUserIds });
  };

  const isLoading = isLoadingGroup || isLoadingUsers;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="members-modal-title">
      <div className={`${styles.modal} ${styles.membersModal}`}>
        <div className={styles.modalHeader}>
          <div>
            <h2 className={styles.modalTitle} id="members-modal-title">
              Members — {group.name}
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
              disabled={isLoading || setMembers.isPending || nonMembers.length === 0}
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
              disabled={!selectedOid || isLoading || setMembers.isPending}
              aria-label="Add selected user to group"
            >
              {setMembers.isPending ? 'Adding…' : 'Add'}
            </button>
          </div>

          {setMembers.error && <div className={styles.error}>{setMembers.error.message}</div>}

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
            <p className={styles.emptyMembers}>Loading members…</p>
          ) : filteredMembers.length === 0 ? (
            <p className={styles.emptyMembers}>
              {memberSearch ? `No members match "${memberSearch}"` : 'No members assigned yet.'}
            </p>
          ) : (
            <div className={styles.memberList}>
              {filteredMembers.map((m) => (
                <div key={m.userId} className={styles.memberItem}>
                  <span className={styles.memberAvatar} aria-hidden="true">
                    {getMemberInitial(m.displayName, m.email)}
                  </span>
                  <div className={styles.memberInfo}>
                    <span className={styles.memberName}>
                      {m.displayName ?? <em>No name</em>}
                    </span>
                    {m.email && <span className={styles.memberEmail}>{m.email}</span>}
                  </div>
                  <button
                    className={styles.removeBtn}
                    onClick={() => handleRemove(m.userId)}
                    disabled={setMembers.isPending}
                    title={`Remove ${m.displayName ?? m.email} from group`}
                    aria-label={`Remove ${m.displayName ?? m.email} from ${group.name}`}
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

// ── AdminGroups (main) ────────────────────────────────────────────────────

export const AdminGroups: React.FC = () => {
  const { data: groups = [], isLoading } = useGroupsWithMembers();

  const [showCreate, setShowCreate] = useState(false);
  const [editingGroup, setEditingGroup] = useState<AppGroup | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<AppGroup | null>(null);
  const [managingMembersGroup, setManagingMembersGroup] = useState<AppGroup | null>(null);

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <div className={styles.pageHeader}>
          <div>
            <h1 className={styles.pageTitle}>Groups</h1>
            <p className={styles.pageSubtitle}>Manage user groups for approvals and team organization.</p>
          </div>
          <button className={styles.btnPrimary} onClick={() => setShowCreate(true)}>
            + Create Group
          </button>
        </div>

        {isLoading ? (
          <div className={styles.loading}>Loading groups…</div>
        ) : groups.length === 0 ? (
          <div className={styles.empty}>
            <p>No groups found. Create one to get started.</p>
          </div>
        ) : (
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.th}>Name</th>
                  <th className={styles.th}>Description</th>
                  <th className={styles.th}>Members</th>
                  <th className={styles.th}>Created</th>
                  <th className={styles.th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <tr key={group.id} className={styles.tr}>
                    <td className={styles.td}>
                      <span className={styles.nameCell}>{group.name}</span>
                    </td>
                    <td className={styles.td}>
                      <span className={styles.descCell}>{group.description ?? '—'}</span>
                    </td>
                    <td className={styles.td}>
                      <span className={styles.countCell}>{group.members.length}</span>
                    </td>
                    <td className={styles.td}>
                      {new Date(group.createdAt).toLocaleDateString()}
                    </td>
                    <td className={styles.td}>
                      <div className={styles.actions}>
                        <button
                          className={styles.btnAction}
                          onClick={() => setManagingMembersGroup(group)}
                          title="Manage members"
                        >
                          Members
                        </button>
                        <button
                          className={styles.btnAction}
                          onClick={() => setEditingGroup(group)}
                          title="Edit group"
                        >
                          Edit
                        </button>
                        <button
                          className={`${styles.btnAction} ${styles.btnActionDanger}`}
                          onClick={() => setDeletingGroup(group)}
                          title="Delete group"
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

      {showCreate && <CreateEditGroupModal onClose={() => setShowCreate(false)} />}
      {editingGroup && (
        <CreateEditGroupModal group={editingGroup} onClose={() => setEditingGroup(null)} />
      )}
      {deletingGroup && (
        <DeleteConfirmModal group={deletingGroup} onClose={() => setDeletingGroup(null)} />
      )}
      {managingMembersGroup && (
        <GroupMembersModal
          group={managingMembersGroup}
          onClose={() => setManagingMembersGroup(null)}
        />
      )}
    </div>
  );
};
