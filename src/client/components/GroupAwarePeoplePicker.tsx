import React, { useState, useRef, useMemo, useEffect } from 'react';
import type { GroupWithMembers } from '../../shared/types/groups';
import styles from './GroupAwarePeoplePicker.module.css';

export interface GroupAwarePeoplePickerProps {
  groups: GroupWithMembers[];
  availableUsers: Array<{ oid: string; displayName: string | null; email: string | null }>;
  selectedUserIds: string[];
  selectedGroupIds: string[];
  onUserIdsChange: (ids: string[]) => void;
  onGroupIdsChange: (ids: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
}

export const GroupAwarePeoplePicker: React.FC<GroupAwarePeoplePickerProps> = ({
  groups,
  availableUsers,
  selectedUserIds,
  selectedGroupIds,
  onUserIdsChange,
  onGroupIdsChange,
  disabled = false,
  placeholder = 'Search groups or people…',
}) => {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedGroupSet = useMemo(() => new Set(selectedGroupIds), [selectedGroupIds]);
  const selectedUserSet = useMemo(() => new Set(selectedUserIds), [selectedUserIds]);

  const filteredGroups = useMemo(() => {
    const q = query.toLowerCase().trim();
    return groups
      .filter((g) => !selectedGroupSet.has(g.id))
      .filter((g) => !q || g.name.toLowerCase().includes(q));
  }, [groups, selectedGroupSet, query]);

  const filteredUsers = useMemo(() => {
    const q = query.toLowerCase().trim();
    return availableUsers
      .filter((u) => !selectedUserSet.has(u.oid))
      .filter((u) => {
        if (!q) return true;
        return (
          u.displayName?.toLowerCase().includes(q) ||
          u.email?.toLowerCase().includes(q)
        );
      });
  }, [availableUsers, selectedUserSet, query]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const selectedGroupObjects = useMemo(
    () => groups.filter((g) => selectedGroupSet.has(g.id)),
    [groups, selectedGroupSet],
  );

  const selectedUserObjects = useMemo(
    () => availableUsers.filter((u) => selectedUserSet.has(u.oid)),
    [availableUsers, selectedUserSet],
  );

  const handleRemoveGroup = (groupId: string) => {
    onGroupIdsChange(selectedGroupIds.filter((id) => id !== groupId));
  };

  const handleRemoveUser = (userId: string) => {
    onUserIdsChange(selectedUserIds.filter((id) => id !== userId));
  };

  const handleSelectGroup = (groupId: string) => {
    onGroupIdsChange([...selectedGroupIds, groupId]);
    setQuery('');
    setOpen(false);
  };

  const handleSelectUser = (userId: string) => {
    onUserIdsChange([...selectedUserIds, userId]);
    setQuery('');
    setOpen(false);
  };

  const hasChips = selectedGroupObjects.length > 0 || selectedUserObjects.length > 0;
  const hasDropdownItems = filteredGroups.length > 0 || filteredUsers.length > 0;

  return (
    <div className={styles.wrapper} ref={wrapRef}>
      {hasChips ? (
        <div className={styles.chipList}>
          {selectedGroupObjects.map((g) => (
            <span key={`g-${g.id}`} className={`${styles.chip} ${styles.groupChip}`}>
              <span className={styles.groupIcon}>👥</span>
              {g.name}
              <button
                type="button"
                className={styles.chipRemove}
                onClick={() => handleRemoveGroup(g.id)}
                disabled={disabled}
                aria-label={`Remove group ${g.name}`}
              >
                ✕
              </button>
            </span>
          ))}
          {selectedUserObjects.map((u) => (
            <span key={`u-${u.oid}`} className={styles.chip}>
              {u.displayName || u.email || u.oid}
              <button
                type="button"
                className={styles.chipRemove}
                onClick={() => handleRemoveUser(u.oid)}
                disabled={disabled}
                aria-label={`Remove ${u.displayName || u.email || 'user'}`}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      ) : (
        <div className={styles.noSelection}>No groups or people selected</div>
      )}

      <input
        ref={inputRef}
        className={styles.searchInput}
        placeholder={placeholder}
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
      />

      {open && (
        <div className={styles.dropdown}>
          {!hasDropdownItems ? (
            <div className={styles.emptyState}>No matches found</div>
          ) : (
            <>
              {filteredGroups.length > 0 && (
                <>
                  <div className={styles.sectionHeader}>Groups</div>
                  {filteredGroups.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      className={styles.option}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        handleSelectGroup(g.id);
                      }}
                    >
                      <span className={styles.groupIcon}>👥</span>
                      <span className={styles.optionName}>{g.name}</span>
                      <span className={styles.optionDetail}>
                        {g.members.length} {g.members.length === 1 ? 'member' : 'members'}
                      </span>
                    </button>
                  ))}
                </>
              )}
              {filteredUsers.length > 0 && (
                <>
                  <div className={styles.sectionHeader}>People</div>
                  {filteredUsers.map((u) => (
                    <button
                      key={u.oid}
                      type="button"
                      className={styles.option}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        handleSelectUser(u.oid);
                      }}
                    >
                      <span className={styles.optionName}>{u.displayName || u.email || u.oid}</span>
                      {u.email && u.displayName && (
                        <span className={styles.optionDetail}>{u.email}</span>
                      )}
                    </button>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};
