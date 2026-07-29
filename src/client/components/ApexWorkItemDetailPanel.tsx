import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  AcceptanceCriterion,
  ApexWorkItemEvent,
  ApexWorkItemStatus,
} from '../../shared/types/apexWorkItem';
import { APEX_WORK_ITEM_STATUSES, STATUS_META } from '../../shared/types/apexWorkItem';
import { useApexWorkItem, useUpdateApexWorkItem, useMoveApexWorkItem, useApexWorkItemOwners } from '../hooks/useApexWorkItems';
import { formatGwtAcText } from '../utils/formatGwtAc';
import { formatUserStoryText } from '../utils/formatUserStory';
import styles from './ApexWorkItemDetailPanel.module.css';

const DEFAULT_DRAWER_WIDTH = 440;
const MIN_DRAWER_WIDTH = 360;
const MAX_DRAWER_WIDTH = 720;

const STATUS_COLOR_VARS: Record<ApexWorkItemStatus, string> = {
  idea:         'var(--status-idea)',
  ready:        'var(--status-ready)',
  'in-progress':'var(--status-in-progress)',
  review:       'var(--status-review)',
  done:         'var(--status-done)',
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ''}${parts[parts.length - 1][0] ?? ''}`.toUpperCase();
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return days < 30 ? `${days}d ago` : new Date(iso).toLocaleDateString();
}

const PencilIcon: React.FC = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
  </svg>
);

function eventDescription(ev: ApexWorkItemEvent): string {
  switch (ev.action) {
    case 'created': return 'created this item';
    case 'moved':
      return `moved from ${STATUS_META[ev.fromStatus!]?.label ?? ev.fromStatus} to ${STATUS_META[ev.toStatus!]?.label ?? ev.toStatus}`;
    case 'assigned': {
      const d = ev.details as { newOwner?: string };
      return `assigned owner to ${d.newOwner ?? 'someone'}`;
    }
    case 'updated': return 'updated this item';
    case 'ac_toggled': return 'toggled an acceptance check';
    case 'collaborators_updated': return 'updated collaborators';
    case 'linked': return 'linked a source';
    case 'unlinked': return 'unlinked a source';
    default: return ev.action;
  }
}

interface ApexWorkItemDetailPanelProps {
  itemId: string;
  onClose: () => void;
}

export const ApexWorkItemDetailPanel: React.FC<ApexWorkItemDetailPanelProps> = ({ itemId, onClose }) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const { data: item, isLoading } = useApexWorkItem(itemId);
  const { data: owners = [] } = useApexWorkItemOwners();
  const updateMutation = useUpdateApexWorkItem();
  const moveMutation = useMoveApexWorkItem();

  const [editingOwner, setEditingOwner] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [editingAc, setEditingAc] = useState(false);
  const [pendingOwnerId, setPendingOwnerId] = useState<string>('');
  const [editOutcome, setEditOutcome] = useState('');
  const [editBranch, setEditBranch] = useState('');
  const [editPrUrl, setEditPrUrl] = useState('');
  const [dirty, setDirty] = useState(false);
  const [localAc, setLocalAc] = useState<AcceptanceCriterion[]>([]);
  const [drawerWidth, setDrawerWidth] = useState(DEFAULT_DRAWER_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(DEFAULT_DRAWER_WIDTH);
  const contentSaveTimerRef = useRef<number | null>(null);
  const editOutcomeRef = useRef(editOutcome);
  const localAcRef = useRef(localAc);
  const syncedItemIdRef = useRef<string | null>(null);

  editOutcomeRef.current = editOutcome;
  localAcRef.current = localAc;

  // Keyboard dismiss
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragStartXRef.current = e.clientX;
    dragStartWidthRef.current = drawerWidth;
    setIsResizing(true);
  }, [drawerWidth]);

  useEffect(() => {
    if (!isResizing) return;
    const onMouseMove = (e: MouseEvent) => {
      const delta = dragStartXRef.current - e.clientX;
      const next = Math.min(MAX_DRAWER_WIDTH, Math.max(MIN_DRAWER_WIDTH, dragStartWidthRef.current + delta));
      setDrawerWidth(next);
    };
    const onMouseUp = () => setIsResizing(false);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  // Sync local state from loaded item (don't kick users out of content edit mode)
  useEffect(() => {
    if (!item) return;
    const isNewItem = syncedItemIdRef.current !== item.id;
    syncedItemIdRef.current = item.id;

    if (isNewItem) {
      setPendingOwnerId(item.owner.oid);
      setEditOutcome(item.outcome ?? '');
      setEditBranch(item.branch ?? '');
      setEditPrUrl(item.prUrl ?? '');
      setLocalAc(item.acceptanceCriteria);
      setDirty(false);
      setEditingDescription(false);
      setEditingAc(false);
      setEditingOwner(false);
      return;
    }

    setPendingOwnerId((prev) => (editingOwner ? prev : item.owner.oid));
    if (!editingDescription) setEditOutcome(item.outcome ?? '');
    if (!editingAc) setLocalAc(item.acceptanceCriteria);
    if (!dirty) {
      setEditBranch(item.branch ?? '');
      setEditPrUrl(item.prUrl ?? '');
    }
  }, [item, editingDescription, editingAc, editingOwner, dirty]);

  useEffect(() => () => {
    if (contentSaveTimerRef.current !== null) {
      window.clearTimeout(contentSaveTimerRef.current);
    }
  }, []);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => { if (e.target === overlayRef.current) onClose(); },
    [onClose],
  );

  const handleStatusChange = useCallback(
    (s: ApexWorkItemStatus) => {
      if (!item || s === item.status) return;
      moveMutation.mutate({ id: item.id, targetStatus: s });
    },
    [item, moveMutation],
  );

  const persistContent = useCallback(
    (outcome: string, ac: AcceptanceCriterion[]) => {
      if (!item) return;
      const sameOutcome = outcome === (item.outcome ?? '');
      const sameAc = JSON.stringify(ac) === JSON.stringify(item.acceptanceCriteria);
      if (sameOutcome && sameAc) return;
      updateMutation.mutate({
        id: item.id,
        outcome,
        acceptanceCriteria: ac,
      });
    },
    [item, updateMutation],
  );

  const scheduleContentSave = useCallback(
    (outcome: string, ac: AcceptanceCriterion[]) => {
      if (contentSaveTimerRef.current !== null) {
        window.clearTimeout(contentSaveTimerRef.current);
      }
      contentSaveTimerRef.current = window.setTimeout(() => {
        contentSaveTimerRef.current = null;
        persistContent(outcome, ac);
      }, 500);
    },
    [persistContent],
  );

  const flushContentSave = useCallback(() => {
    if (contentSaveTimerRef.current !== null) {
      window.clearTimeout(contentSaveTimerRef.current);
      contentSaveTimerRef.current = null;
    }
    persistContent(editOutcomeRef.current, localAcRef.current);
  }, [persistContent]);

  const handleAcToggle = useCallback(
    (id: string) => {
      const updated = localAc.map((c) => (c.id === id ? { ...c, done: !c.done } : c));
      setLocalAc(updated);
      if (item) {
        updateMutation.mutate({ id: item.id, acceptanceCriteria: updated });
      }
    },
    [localAc, item, updateMutation],
  );

  const handleAcTextChange = useCallback((id: string, text: string) => {
    setLocalAc((prev) => {
      const updated = prev.map((c) => (c.id === id ? { ...c, text } : c));
      scheduleContentSave(editOutcomeRef.current, updated);
      return updated;
    });
  }, [scheduleContentSave]);

  const handleAcAdd = useCallback(() => {
    setLocalAc((prev) => {
      const updated = [
        ...prev,
        {
          id: `ac-${Date.now()}`,
          text: 'Given: \nWhen: \nThen: ',
          done: false,
        },
      ];
      scheduleContentSave(editOutcomeRef.current, updated);
      return updated;
    });
    setEditingAc(true);
  }, [scheduleContentSave]);

  const handleAcRemove = useCallback((id: string) => {
    setLocalAc((prev) => {
      const updated = prev.filter((c) => c.id !== id);
      scheduleContentSave(editOutcomeRef.current, updated);
      return updated;
    });
  }, [scheduleContentSave]);

  const handleDescriptionChange = useCallback((value: string) => {
    setEditOutcome(value);
    scheduleContentSave(value, localAcRef.current);
  }, [scheduleContentSave]);

  const toggleEditingDescription = useCallback(() => {
    setEditingDescription((prev) => {
      if (prev) flushContentSave();
      return !prev;
    });
  }, [flushContentSave]);

  const toggleEditingAc = useCallback(() => {
    setEditingAc((prev) => {
      if (prev) flushContentSave();
      return !prev;
    });
  }, [flushContentSave]);

  const handleSave = useCallback(() => {
    if (!item) return;
    flushContentSave();
    updateMutation.mutate({
      id: item.id,
      outcome: editOutcomeRef.current,
      ownerId: pendingOwnerId !== item.owner.oid ? pendingOwnerId : undefined,
      branch: editBranch || null,
      prUrl: editPrUrl || null,
      acceptanceCriteria: localAcRef.current,
    });
    setDirty(false);
    setEditingOwner(false);
  }, [item, pendingOwnerId, editBranch, editPrUrl, updateMutation, flushContentSave]);

  const handleCancelEdits = useCallback(() => {
    if (!item) return;
    if (contentSaveTimerRef.current !== null) {
      window.clearTimeout(contentSaveTimerRef.current);
      contentSaveTimerRef.current = null;
    }
    setEditBranch(item.branch ?? '');
    setEditPrUrl(item.prUrl ?? '');
    setPendingOwnerId(item.owner.oid);
    setDirty(false);
    setEditingOwner(false);
  }, [item]);

  if (isLoading || !item) {
    return (
      <div className={styles.overlay} ref={overlayRef} onClick={handleOverlayClick}>
        <aside
          className={`${styles.drawer} ${isResizing ? styles.drawerResizing : ''}`}
          style={{ width: drawerWidth }}
          role="dialog"
          aria-label="Work item details"
        >
          <div
            className={styles.resizeHandle}
            onMouseDown={handleResizeMouseDown}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize details panel"
          />
          <div className={styles.loadingBody}>Loading…</div>
        </aside>
      </div>
    );
  }

  const acTotal = localAc.length;
  const acDone = localAc.filter((c) => c.done).length;
  const acPct = acTotal > 0 ? (acDone / acTotal) * 100 : 0;

  return (
    <div className={styles.overlay} ref={overlayRef} onClick={handleOverlayClick}>
      <aside
        className={`${styles.drawer} ${isResizing ? styles.drawerResizing : ''}`}
        style={{ width: drawerWidth }}
        role="dialog"
        aria-modal
        aria-label="Work item details"
      >
        <div
          className={styles.resizeHandle}
          onMouseDown={handleResizeMouseDown}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize details panel"
        />

        {/* Header */}
        <header className={styles.drawerHeader}>
          <div className={styles.drawerHeaderMeta}>
            <div className={styles.drawerIdRow}>
              <span className={styles.itemId}>APX-{item.itemNumber}</span>
              <span
                className={`${styles.typeChip} ${
                  item.type === 'PBI' ? styles.typeChipPBI
                    : item.type === 'TBI' ? styles.typeChipTBI
                    : styles.typeChipBug
                }`}
              >
                {item.type}
              </span>
            </div>
            <h2 className={styles.drawerTitle}>{item.title}</h2>
          </div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 14 14">
              <path d="M2 2l10 10M12 2L2 12" />
            </svg>
          </button>
        </header>

        {/* Body */}
        <div className={styles.body}>

          {/* Status */}
          <div className={styles.section}>
            <span className={styles.sectionLabel}>Status</span>
            <div className={styles.statusRow}>
              {APEX_WORK_ITEM_STATUSES.map((s) => (
                <button
                  key={s}
                  className={`${styles.statusBtn} ${item.status === s ? styles.statusBtnActive : ''}`}
                  style={{ ['--status-color' as string]: STATUS_COLOR_VARS[s] }}
                  onClick={() => handleStatusChange(s)}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: STATUS_COLOR_VARS[s],
                      display: 'inline-block',
                      flexShrink: 0,
                    }}
                  />
                  {STATUS_META[s].label}
                </button>
              ))}
            </div>
          </div>

          {/* Description */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionLabel}>Description</span>
              <button
                type="button"
                className={`${styles.sectionEditBtn} ${editingDescription ? styles.sectionEditBtnActive : ''}`}
                onClick={toggleEditingDescription}
                aria-label={editingDescription ? 'Finish editing description' : 'Edit description'}
                title={editingDescription ? 'Done' : 'Edit'}
              >
                <PencilIcon />
              </button>
            </div>
            {editingDescription ? (
              <textarea
                className={styles.fieldTextarea}
                value={editOutcome}
                onChange={(e) => handleDescriptionChange(e.target.value)}
                rows={4}
                placeholder={'As a <role>\nI want <capability>\nSo that <benefit>'}
              />
            ) : (
              <p className={styles.sectionContent}>
                {editOutcome
                  ? formatUserStoryText(editOutcome, styles.storyKeyword)
                  : '—'}
              </p>
            )}
          </div>

          {/* Acceptance criteria */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionLabel}>Acceptance Criteria</span>
              <div className={styles.sectionHeaderActions}>
                <button type="button" className={styles.sectionEditBtn} onClick={handleAcAdd}>
                  Add
                </button>
                <button
                  type="button"
                  className={`${styles.sectionEditBtn} ${editingAc ? styles.sectionEditBtnActive : ''}`}
                  onClick={toggleEditingAc}
                  aria-label={editingAc ? 'Finish editing acceptance criteria' : 'Edit acceptance criteria'}
                  title={editingAc ? 'Done' : 'Edit'}
                >
                  <PencilIcon />
                </button>
              </div>
            </div>
            {acTotal > 0 && (
              <div className={styles.acProgress}>
                <div className={styles.acBar}>
                  <div className={styles.acBarFill} style={{ width: `${acPct}%` }} />
                </div>
                <span className={styles.acCount}>{acDone}/{acTotal} done</span>
              </div>
            )}
            <div className={styles.acList}>
              {localAc.length === 0 && (
                <p className={styles.sectionContent}>No acceptance criteria yet.</p>
              )}
              {localAc.map((c) => (
                <div key={c.id} className={styles.acItem}>
                  <button
                    type="button"
                    className={`${styles.acCheckbox} ${c.done ? styles.acCheckboxDone : ''}`}
                    onClick={() => handleAcToggle(c.id)}
                    aria-label={c.done ? 'Mark criterion incomplete' : 'Mark criterion done'}
                  >
                    {c.done && (
                      <svg width="9" height="9" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 9 9">
                        <path d="M1.5 4.5l2 2 4-4" />
                      </svg>
                    )}
                  </button>
                  {editingAc ? (
                    <div className={styles.acEditCol}>
                      <textarea
                        className={styles.acTextarea}
                        value={c.text}
                        onChange={(e) => handleAcTextChange(c.id, e.target.value)}
                        rows={3}
                        placeholder={'Given: …\nWhen: …\nThen: …'}
                      />
                      <button
                        type="button"
                        className={styles.acRemoveBtn}
                        onClick={() => handleAcRemove(c.id)}
                        aria-label="Delete criterion"
                        title="Delete"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M3 6h18" />
                          <path d="M8 6V4h8v2" />
                          <path d="M19 6l-1 14H6L5 6" />
                          <path d="M10 11v6M14 11v6" />
                        </svg>
                      </button>
                    </div>
                  ) : (
                    <span className={`${styles.acText} ${c.done ? styles.acTextDone : ''}`}>
                      {formatGwtAcText(c.text, styles.gwtKeyword)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Owner */}
          <div className={styles.section}>
            <span className={styles.sectionLabel}>Owner</span>
            {!editingOwner ? (
              <div className={styles.ownerRow}>
                <div className={styles.avatar}>
                  {initials(item.owner.displayName)}
                </div>
                <div className={styles.ownerInfo}>
                  <span className={styles.ownerName}>{item.owner.displayName}</span>
                  <span className={styles.ownerEmail}>{item.owner.email}</span>
                </div>
                <button className={styles.changeOwnerBtn} onClick={() => setEditingOwner(true)}>
                  Change
                </button>
              </div>
            ) : (
              <select
                className={styles.ownerSelect}
                value={pendingOwnerId}
                onChange={(e) => { setPendingOwnerId(e.target.value); setDirty(true); }}
                autoFocus
              >
                {owners.map((o) => (
                  <option key={o.oid} value={o.oid}>{o.displayName}</option>
                ))}
              </select>
            )}
          </div>

          {/* Collaborators */}
          {item.collaborators.length > 0 && (
            <div className={styles.section}>
              <span className={styles.sectionLabel}>Collaborators</span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {item.collaborators.map((c) => (
                  <div key={c.oid} className={styles.ownerRow} style={{ gap: 6 }}>
                    <div
                      className={styles.avatar}
                      style={{ width: 24, height: 24, fontSize: '0.6rem' }}
                    >
                      {initials(c.displayName)}
                    </div>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{c.displayName}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Branch */}
          <div className={styles.section}>
            <span className={styles.sectionLabel}>Branch</span>
            <input
              className={styles.fieldInput}
              value={editBranch}
              onChange={(e) => { setEditBranch(e.target.value); setDirty(true); }}
              placeholder="feature/apex-…"
            />
          </div>

          {/* PR URL */}
          <div className={styles.section}>
            <span className={styles.sectionLabel}>Pull Request</span>
            <input
              className={styles.fieldInput}
              value={editPrUrl}
              onChange={(e) => { setEditPrUrl(e.target.value); setDirty(true); }}
              placeholder="https://…"
            />
            {editPrUrl && (
              <a href={editPrUrl} target="_blank" rel="noopener noreferrer" className={styles.fieldLink}>
                <svg width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 11 11">
                  <path d="M2 9L9 2M5 2h4v4" />
                </svg>
                Open PR
              </a>
            )}
          </div>

          {/* Source journey */}
          <div className={styles.section}>
            <span className={styles.sectionLabel}>Source</span>
            {item.featureRequestId || item.prdId ? (
              <div className={styles.journey}>
                {item.featureRequestId && (
                  <>
                    <button
                      className={styles.journeyStep}
                      onClick={() => navigate(`/feature-requests`)}
                      title="Feature Request"
                    >
                      FR
                    </button>
                    {item.prdId && <span className={styles.journeyArrow}>→</span>}
                  </>
                )}
                {item.prdId && (
                  <button
                    className={styles.journeyStep}
                    onClick={() => navigate(`/backlog/prd/${item.prdId}`)}
                    title="PRD"
                  >
                    PRD
                  </button>
                )}
                <span className={styles.journeyArrow}>→</span>
                <span className={styles.journeyStep} style={{ cursor: 'default' }}>APX-{item.itemNumber}</span>
              </div>
            ) : (
              <span className={styles.noSource}>No linked source (standalone)</span>
            )}
          </div>

          {/* Activity */}
          {item.events && item.events.length > 0 && (
            <div className={styles.section}>
              <span className={styles.sectionLabel}>Activity</span>
              <div className={styles.activityList}>
                {[...item.events].reverse().map((ev) => (
                  <div key={ev.id} className={styles.activityItem}>
                    <div className={styles.activityBody}>
                      <div className={styles.activityText}>
                        <strong>{ev.actorName}</strong> {eventDescription(ev)}
                      </div>
                      <div className={styles.activityTime}>{relativeTime(ev.createdAt)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>

        {/* Save bar */}
        {(dirty || editingOwner) && (
          <div className={styles.saveBar}>
            <button
              className={styles.btnSave}
              onClick={handleSave}
              disabled={updateMutation.isPending}
            >
              {updateMutation.isPending ? 'Saving…' : 'Save Changes'}
            </button>
            <button className={styles.btnCancel} onClick={handleCancelEdits}>
              Cancel
            </button>
          </div>
        )}

      </aside>
    </div>
  );
};
