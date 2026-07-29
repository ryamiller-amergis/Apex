import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ApexWorkItemType } from '../../shared/types/apexWorkItem';
import { useApexWorkItemOwners, useMaterializeFromPrd, useMaterializedItemIds } from '../hooks/useApexWorkItems';
import styles from './ApexMaterializeModal.module.css';

interface BacklogLeafItem {
  id: string;
  title: string;
  description?: string;
  type: 'PBI' | 'TBI';
  acceptanceCriteria?: string[];
}

interface BacklogFeature {
  id: string;
  title: string;
  items: BacklogLeafItem[];
}

interface BacklogEpic {
  id: string;
  title: string;
  features: BacklogFeature[];
}

export interface ApexMaterializeModalProps {
  prdId: string;
  prdTitle: string;
  backlog: { epics: BacklogEpic[] };
  onClose: () => void;
}

type Phase = 'select' | 'creating' | 'success';

export const ApexMaterializeModal: React.FC<ApexMaterializeModalProps> = ({
  prdId,
  prdTitle,
  backlog,
  onClose,
}) => {
  const navigate = useNavigate();
  const { data: owners = [] } = useApexWorkItemOwners();
  const { data: materializedData } = useMaterializedItemIds(prdId);
  const materializeMutation = useMaterializeFromPrd();

  const alreadyMaterialized = useMemo(
    () => new Set(materializedData?.backlogItemIds ?? []),
    [materializedData],
  );

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ownerId, setOwnerId] = useState<string>('');
  const [phase, setPhase] = useState<Phase>('select');
  const [createdCount, setCreatedCount] = useState(0);

  // Default to first owner
  useEffect(() => {
    if (owners.length > 0 && !ownerId) setOwnerId(owners[0].oid);
  }, [owners, ownerId]);

  // Pre-select all non-materialized leaves
  useEffect(() => {
    const allNew = backlog.epics
      .flatMap((e) => e.features)
      .flatMap((f) => f.items)
      .filter((i) => !alreadyMaterialized.has(i.id))
      .map((i) => i.id);
    setSelected(new Set(allNew));
  }, [backlog, alreadyMaterialized]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); },
    [onClose],
  );
  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const toggleItem = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleEpic = (epic: BacklogEpic) => {
    const leafIds = epic.features.flatMap((f) => f.items).filter((i) => !alreadyMaterialized.has(i.id)).map((i) => i.id);
    const allSelected = leafIds.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) leafIds.forEach((id) => next.delete(id));
      else leafIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const toggleFeature = (feature: BacklogFeature) => {
    const leafIds = feature.items.filter((i) => !alreadyMaterialized.has(i.id)).map((i) => i.id);
    const allSelected = leafIds.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) leafIds.forEach((id) => next.delete(id));
      else leafIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const selectedItems = useMemo(
    () =>
      backlog.epics
        .flatMap((e) =>
          e.features.flatMap((f) =>
            f.items.map((i) => ({
              ...i,
              epicId: e.id,
              epicTitle: e.title,
              featureId: f.id,
              featureTitle: f.title,
            })),
          ),
        )
        .filter((i) => selected.has(i.id)),
    [backlog, selected],
  );

  const handleCreate = async () => {
    if (!selectedItems.length || !ownerId) return;
    setPhase('creating');
    try {
      const items = selectedItems.map((i) => ({
        id: i.id,
        title: i.title,
        description: i.description ?? '',
        type: i.type as ApexWorkItemType,
        acceptanceCriteria: i.acceptanceCriteria ?? [],
        epicId: i.epicId,
        epicTitle: i.epicTitle,
        featureId: i.featureId,
        featureTitle: i.featureTitle,
      }));
      await materializeMutation.mutateAsync({ prdId, ownerId, items } as Parameters<typeof materializeMutation.mutateAsync>[0]);
      setCreatedCount(items.length);
      setPhase('success');
    } catch {
      setPhase('select');
    }
  };

  return (
    <div className={styles.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.modal} role="dialog" aria-modal aria-label="Create Work Items">

        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerText}>
            <h2 className={styles.title}>Create Work Items</h2>
            <p className={styles.subtitle}>
              Select backlog items from <em>{prdTitle}</em> to materialize as Apex Work Board cards.
            </p>
          </div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 14 14">
              <path d="M2 2l10 10M12 2L2 12" />
            </svg>
          </button>
        </div>

        {phase === 'creating' && (
          <div className={styles.progressState}>
            <span>Creating {selectedItems.length} work items…</span>
            <div className={styles.progressBar}><div className={styles.progressBarFill} /></div>
          </div>
        )}

        {phase === 'success' && (
          <div className={styles.successState}>
            <div className={styles.successIcon}>
              <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 22 22">
                <path d="M4 11l5 5 9-9" />
              </svg>
            </div>
            <div className={styles.successCount}>{createdCount}</div>
            <div className={styles.successText}>work items created on the board</div>
          </div>
        )}

        {phase === 'select' && (
          <>
            {/* Checklist + preview */}
            <div className={styles.body}>
              {/* Left: tree */}
              <div className={styles.left}>
                {backlog.epics.map((epic) => {
                  const epicLeaves = epic.features.flatMap((f) => f.items).filter((i) => !alreadyMaterialized.has(i.id));
                  const epicAllChecked = epicLeaves.length > 0 && epicLeaves.every((i) => selected.has(i.id));
                  const epicIndeterminate = epicLeaves.some((i) => selected.has(i.id)) && !epicAllChecked;
                  return (
                    <div key={epic.id} className={styles.epicGroup}>
                      <div className={styles.epicHeading}>
                        <input
                          type="checkbox"
                          className={styles.epicCheckbox}
                          checked={epicAllChecked}
                          ref={(el) => { if (el) el.indeterminate = epicIndeterminate; }}
                          onChange={() => toggleEpic(epic)}
                          aria-label={`Select all items in ${epic.title}`}
                        />
                        {epic.title}
                      </div>
                      {epic.features.map((feature) => {
                        const fLeaves = feature.items.filter((i) => !alreadyMaterialized.has(i.id));
                        const fAllChecked = fLeaves.length > 0 && fLeaves.every((i) => selected.has(i.id));
                        const fIndeterminate = fLeaves.some((i) => selected.has(i.id)) && !fAllChecked;
                        return (
                          <div key={feature.id} className={styles.featureGroup}>
                            <div className={styles.featureHeading}>
                              <input
                                type="checkbox"
                                className={styles.epicCheckbox}
                                checked={fAllChecked}
                                ref={(el) => { if (el) el.indeterminate = fIndeterminate; }}
                                onChange={() => toggleFeature(feature)}
                                aria-label={`Select all items in ${feature.title}`}
                              />
                              {feature.title}
                            </div>
                            <div className={styles.itemsList}>
                              {feature.items.map((item) => {
                                const done = alreadyMaterialized.has(item.id);
                                return (
                                  <div
                                    key={item.id}
                                    className={styles.itemRow}
                                    onClick={() => !done && toggleItem(item.id)}
                                  >
                                    <input
                                      type="checkbox"
                                      className={styles.itemCheckbox}
                                      checked={done || selected.has(item.id)}
                                      disabled={done}
                                      onChange={() => !done && toggleItem(item.id)}
                                      aria-label={item.title}
                                    />
                                    <span
                                      className={`${styles.itemType} ${
                                        item.type === 'PBI' ? styles.itemTypePBI
                                          : item.type === 'TBI' ? styles.itemTypeTBI
                                          : styles.itemTypeBug
                                      }`}
                                    >
                                      {item.type}
                                    </span>
                                    <span className={styles.itemTitle} style={{ opacity: done ? 0.5 : 1 }}>
                                      {item.title}
                                    </span>
                                    {done && <span className={styles.itemDoneBadge}>On board</span>}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>

              {/* Right: preview */}
              <div className={styles.right}>
                <div className={styles.previewLabel}>Preview ({selectedItems.length})</div>
                {selectedItems.length === 0 ? (
                  <div className={styles.previewEmpty}>Select items to preview</div>
                ) : (
                  selectedItems.slice(0, 20).map((i) => (
                    <div key={i.id} className={styles.previewCard}>
                      <div className={styles.previewCardType}>{i.type}</div>
                      <div className={styles.previewCardTitle}>{i.title}</div>
                    </div>
                  ))
                )}
                {selectedItems.length > 20 && (
                  <div className={styles.previewEmpty}>…and {selectedItems.length - 20} more</div>
                )}
              </div>
            </div>

            {/* Owner row */}
            <div className={styles.ownerRow}>
              <span className={styles.ownerLabel}>Assign to</span>
              <select
                className={styles.ownerSelect}
                value={ownerId}
                onChange={(e) => setOwnerId(e.target.value)}
              >
                {owners.map((o) => (
                  <option key={o.oid} value={o.oid}>{o.displayName}</option>
                ))}
              </select>
            </div>

            {/* Footer */}
            <div className={styles.footer}>
              <span className={styles.footerCount}>
                {selected.size} items selected
              </span>
              <button className={styles.btnSecondary} onClick={onClose}>Cancel</button>
              <button
                className={styles.btnPrimary}
                disabled={selected.size === 0 || !ownerId}
                onClick={handleCreate}
              >
                Create {selected.size > 0 ? selected.size : ''} Work Items
              </button>
            </div>
          </>
        )}

        {phase === 'success' && (
          <div className={styles.footer}>
            <div style={{ flex: 1 }} />
            <button className={styles.btnSecondary} onClick={onClose}>Close</button>
            <button className={styles.btnPrimary} onClick={() => navigate('/work-board')}>
              Open Work Board
            </button>
          </div>
        )}

      </div>
    </div>
  );
};
