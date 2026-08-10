import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  AcceptanceCriterion,
  ApexWorkItemEvent,
  ApexWorkItemStatus,
  ApexWorkItemType,
} from '../../shared/types/apexWorkItem';
import { APEX_WORK_ITEM_STATUSES, STATUS_META } from '../../shared/types/apexWorkItem';
import {
  useApexWorkItem,
  useUpdateApexWorkItem,
  useMoveApexWorkItem,
  useApexWorkItemOwners,
  useApexReleases,
  useAddApexWorkItemComment,
  useApexWorkItemAttachments,
  useAddApexWorkItemAttachment,
  useDeleteApexWorkItemAttachment,
} from '../hooks/useApexWorkItems';
import { formatGwtAcText } from '../utils/formatGwtAc';
import { formatUserStoryText } from '../utils/formatUserStory';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import styles from './ApexWorkItemDetailPanel.module.css';

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function attachmentHref(a: { openUrl?: string; storagePath: string; workItemId: string; id: string }, project: string): string {
  if (a.openUrl) return a.openUrl;
  if (/^https?:\/\//i.test(a.storagePath)) return a.storagePath;
  return `/api/apex-work-items/${a.workItemId}/attachments/${a.id}/content?project=${encodeURIComponent(project)}`;
}

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

function statusCssVars(status: ApexWorkItemStatus): React.CSSProperties {
  const accent = STATUS_META[status].tokenVar;
  return {
    ['--status-color' as string]: `var(${accent})`,
    ['--status-bg' as string]: `var(${accent}-bg)`,
    ['--status-border' as string]: `var(${accent}-border)`,
    ['--status-glow' as string]: `var(${accent}-glow)`,
  };
}

function typeChipClass(type: ApexWorkItemType): string {
  switch (type) {
    case 'PBI':
      return styles.typeChipPBI;
    case 'TBI':
      return styles.typeChipTBI;
    case 'Bug':
      return styles.typeChipBug;
    case 'Epic':
      return styles.typeChipEpic;
    case 'Feature':
      return styles.typeChipFeature;
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

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
    case 'attachment_added': {
      const d = ev.details as { fileName?: string };
      return d.fileName ? `added attachment ${d.fileName}` : 'added an attachment';
    }
    case 'attachment_removed': {
      const d = ev.details as { fileName?: string };
      return d.fileName ? `removed attachment ${d.fileName}` : 'removed an attachment';
    }
    default: return ev.action;
  }
}

type DetailSectionId =
  | 'description'
  | 'acceptance'
  | 'development'
  | 'hierarchy'
  | 'source'
  | 'attachments'
  | 'comments'
  | 'activity';

const PRIMARY_SECTIONS: { id: DetailSectionId; label: string }[] = [
  { id: 'description', label: 'Description' },
  { id: 'acceptance', label: 'AC' },
  { id: 'development', label: 'Dev' },
  { id: 'attachments', label: 'Files' },
  { id: 'comments', label: 'Comments' },
];

const MORE_SECTIONS: { id: DetailSectionId; label: string }[] = [
  { id: 'hierarchy', label: 'Hierarchy' },
  { id: 'source', label: 'Source' },
  { id: 'activity', label: 'Activity' },
];

const ALL_SECTIONS = [...PRIMARY_SECTIONS, ...MORE_SECTIONS];

interface ApexWorkItemDetailPanelProps {
  itemId: string;
  project: string;
  onClose: () => void;
  onOpenItem?: (id: string) => void;
}

export const ApexWorkItemDetailPanel: React.FC<ApexWorkItemDetailPanelProps> = ({
  itemId,
  project,
  onClose,
  onOpenItem,
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const { data: item, isLoading } = useApexWorkItem(itemId, project);
  const { data: owners = [] } = useApexWorkItemOwners(project);
  const { data: releases = [] } = useApexReleases(project);
  const { data: attachments = [] } = useApexWorkItemAttachments(project, itemId);
  const updateMutation = useUpdateApexWorkItem(project);
  const moveMutation = useMoveApexWorkItem({ project });
  const addComment = useAddApexWorkItemComment(project);
  const addAttachment = useAddApexWorkItemAttachment(project);
  const deleteAttachment = useDeleteApexWorkItemAttachment(project);

  const [ownerMenuOpen, setOwnerMenuOpen] = useState(false);
  const [confirmDeleteAttachmentId, setConfirmDeleteAttachmentId] = useState<string | null>(null);
  const [editingDescription, setEditingDescription] = useState(false);
  const [editingAc, setEditingAc] = useState(false);
  const [pendingOwnerId, setPendingOwnerId] = useState<string>('');
  const [pendingReleaseId, setPendingReleaseId] = useState<string>('');
  const [editOutcome, setEditOutcome] = useState('');
  const [editBranch, setEditBranch] = useState('');
  const [editPrUrl, setEditPrUrl] = useState('');
  const [commentBody, setCommentBody] = useState('');
  const [attachFileName, setAttachFileName] = useState('');
  const [attachUrl, setAttachUrl] = useState('');
  const [dirty, setDirty] = useState(false);
  const [localAc, setLocalAc] = useState<AcceptanceCriterion[]>([]);
  const [drawerWidth, setDrawerWidth] = useState(DEFAULT_DRAWER_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const [activeSection, setActiveSection] = useState<DetailSectionId>('description');
  const [flashSection, setFlashSection] = useState<DetailSectionId | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(DEFAULT_DRAWER_WIDTH);
  const contentSaveTimerRef = useRef<number | null>(null);
  const editOutcomeRef = useRef(editOutcome);
  const localAcRef = useRef(localAc);
  const syncedItemIdRef = useRef<string | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const scrollingToSectionRef = useRef(false);
  const ownerMenuRef = useRef<HTMLDivElement | null>(null);
  const resizeJustEndedRef = useRef(false);

  editOutcomeRef.current = editOutcome;
  localAcRef.current = localAc;

  // Keyboard dismiss
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (moreOpen) {
          setMoreOpen(false);
          return;
        }
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose, moreOpen]);

  useEffect(() => {
    if (!moreOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [moreOpen]);

  useEffect(() => {
    if (!ownerMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (ownerMenuRef.current && !ownerMenuRef.current.contains(e.target as Node)) {
        setOwnerMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [ownerMenuOpen]);

  useEffect(() => () => {
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
  }, []);

  useEffect(() => {
    const root = bodyRef.current;
    if (!root || isLoading || !item) return;

    const nodes = ALL_SECTIONS
      .map((s) => root.querySelector<HTMLElement>(`[data-section-id="${s.id}"]`))
      .filter((el): el is HTMLElement => !!el);

    if (nodes.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (scrollingToSectionRef.current) return;
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        const top = visible[0]?.target.getAttribute('data-section-id') as DetailSectionId | null;
        if (top) setActiveSection(top);
      },
      { root, rootMargin: '-8% 0px -55% 0px', threshold: [0.15, 0.35, 0.6] },
    );

    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [isLoading, item, itemId]);

  const scrollToSection = useCallback((id: DetailSectionId) => {
    const root = bodyRef.current;
    const el = root?.querySelector<HTMLElement>(`[data-section-id="${id}"]`);
    if (!root || !el) return;

    setActiveSection(id);
    setMoreOpen(false);
    setFlashSection(id);
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setFlashSection(null), 900);

    scrollingToSectionRef.current = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.setTimeout(() => {
      scrollingToSectionRef.current = false;
    }, 500);
  }, []);

  const sectionClassName = useCallback(
    (id: DetailSectionId, extra?: string) =>
      [
        styles.section,
        styles.sectionGlass,
        flashSection === id ? styles.sectionFlash : '',
        extra ?? '',
      ]
        .filter(Boolean)
        .join(' '),
    [flashSection],
  );

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
    const onMouseUp = () => {
      // A drag that ends over the backdrop synthesizes a click on the overlay
      // (common ancestor of the handle + backdrop). Suppress that close.
      resizeJustEndedRef.current = true;
      setIsResizing(false);
    };
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
      setPendingReleaseId(item.releaseId ?? '');
      setEditOutcome(item.outcome ?? '');
      setEditBranch(item.branch ?? '');
      setEditPrUrl(item.prUrl ?? '');
      setLocalAc(item.acceptanceCriteria);
      setDirty(false);
      setEditingDescription(false);
      setEditingAc(false);
      setOwnerMenuOpen(false);
      return;
    }

    setPendingOwnerId((prev) => (dirty ? prev : item.owner.oid));
    setPendingReleaseId((prev) => (dirty ? prev : (item.releaseId ?? '')));
    if (!editingDescription) setEditOutcome(item.outcome ?? '');
    if (!editingAc) setLocalAc(item.acceptanceCriteria);
    if (!dirty) {
      setEditBranch(item.branch ?? '');
      setEditPrUrl(item.prUrl ?? '');
    }
  }, [item, editingDescription, editingAc, dirty]);

  useEffect(() => () => {
    if (contentSaveTimerRef.current !== null) {
      window.clearTimeout(contentSaveTimerRef.current);
    }
  }, []);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (resizeJustEndedRef.current) {
        resizeJustEndedRef.current = false;
        return;
      }
      if (e.target === overlayRef.current) onClose();
    },
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
      releaseId: pendingReleaseId !== (item.releaseId ?? '') ? (pendingReleaseId || null) : undefined,
      branch: editBranch || null,
      prUrl: editPrUrl || null,
      acceptanceCriteria: localAcRef.current,
    });
    setDirty(false);
    setOwnerMenuOpen(false);
  }, [item, pendingOwnerId, pendingReleaseId, editBranch, editPrUrl, updateMutation, flushContentSave]);

  const handleCancelEdits = useCallback(() => {
    if (!item) return;
    if (contentSaveTimerRef.current !== null) {
      window.clearTimeout(contentSaveTimerRef.current);
      contentSaveTimerRef.current = null;
    }
    setEditBranch(item.branch ?? '');
    setEditPrUrl(item.prUrl ?? '');
    setPendingOwnerId(item.owner.oid);
    setPendingReleaseId(item.releaseId ?? '');
    setDirty(false);
    setOwnerMenuOpen(false);
  }, [item]);

  const handlePostComment = useCallback(() => {
    if (!item || !commentBody.trim()) return;
    addComment.mutate(
      { id: item.id, body: commentBody.trim() },
      { onSuccess: () => setCommentBody('') },
    );
  }, [item, commentBody, addComment]);

  const handleMetaFileAttach = useCallback(
    (file: File | null) => {
      if (!item || !file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        const base64 = result.includes(',') ? result.split(',')[1] : result;
        if (!base64) return;
        addAttachment.mutate({
          id: item.id,
          fileName: file.name,
          contentType: file.type || 'application/octet-stream',
          byteSize: file.size,
          contentBase64: base64,
        });
      };
      reader.readAsDataURL(file);
    },
    [item, addAttachment],
  );

  const handleUrlAttach = useCallback(() => {
    if (!item || !attachFileName.trim() || !attachUrl.trim()) return;
    const url = attachUrl.trim();
    if (!/^https?:\/\//i.test(url)) {
      window.alert('Attachment URL must start with http:// or https://');
      return;
    }
    addAttachment.mutate(
      {
        id: item.id,
        fileName: attachFileName.trim(),
        contentType: 'text/uri-list',
        byteSize: 0,
        storagePath: url,
      },
      {
        onSuccess: () => {
          setAttachFileName('');
          setAttachUrl('');
        },
      },
    );
  }, [item, attachFileName, attachUrl, addAttachment]);

  const confirmDeleteAttachment = useCallback(
    (attachmentId: string) => {
      if (!item) return;
      deleteAttachment.mutate(
        { id: item.id, attachmentId },
        { onSettled: () => setConfirmDeleteAttachmentId(null) },
      );
    },
    [item, deleteAttachment],
  );

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
  const drawerStyle: React.CSSProperties = {
    width: drawerWidth,
    ...statusCssVars(item.status),
  };

  return (
    <div className={styles.overlay} ref={overlayRef} onClick={handleOverlayClick}>
      <aside
        className={`${styles.drawer} ${isResizing ? styles.drawerResizing : ''}`}
        style={drawerStyle}
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

        <header className={styles.drawerHeader}>
          <div className={styles.drawerHeaderTop}>
            <div className={styles.drawerIdRow}>
              <span className={styles.itemId}>APX-{item.itemNumber}</span>
              <span className={`${styles.typeChip} ${typeChipClass(item.type)}`}>
                {item.type}
              </span>
              {item.sourceType !== 'standalone' && (
                <span className={styles.sourceChip} title={item.sourceType === 'prd' ? 'From PRD' : 'From FR'}>
                  {item.sourceType === 'prd' ? 'PRD' : 'FR'}
                </span>
              )}
            </div>
            <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
              <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 14 14">
                <path d="M2 2l10 10M12 2L2 12" />
              </svg>
            </button>
          </div>

          <h2 className={styles.drawerTitle}>{item.title}</h2>

          <div className={styles.metaRow}>
            {(() => {
              const selectedOwner = owners.find((o) => o.oid === pendingOwnerId);
              const ownerName = selectedOwner?.displayName ?? item.owner.displayName;
              return (
                <div className={styles.ownerWrap} ref={ownerMenuRef}>
                  <button
                    type="button"
                    className={styles.ownerChip}
                    onClick={() => setOwnerMenuOpen((v) => !v)}
                    title={`Owner: ${ownerName}. Click to change`}
                    aria-haspopup="listbox"
                    aria-expanded={ownerMenuOpen}
                    aria-label={`Owner ${ownerName}. Click to change`}
                    data-testid="work-item-owner-chip"
                  >
                    <span className={styles.avatar}>{initials(ownerName)}</span>
                    <span className={styles.ownerChipName}>{ownerName}</span>
                    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ opacity: 0.6 }}>
                      <path d="M3 4.5L6 7.5L9 4.5" />
                    </svg>
                  </button>
                  {ownerMenuOpen && (
                    <div className={styles.ownerMenu} role="listbox" data-testid="work-item-owner-menu">
                      {owners.map((o) => (
                        <button
                          key={o.oid}
                          type="button"
                          role="option"
                          aria-selected={o.oid === pendingOwnerId}
                          className={`${styles.ownerMenuItem} ${o.oid === pendingOwnerId ? styles.ownerMenuItemActive : ''}`}
                          onClick={() => {
                            if (o.oid !== pendingOwnerId) {
                              setPendingOwnerId(o.oid);
                              setDirty(true);
                            }
                            setOwnerMenuOpen(false);
                          }}
                          data-testid={`work-item-owner-option-${o.oid}`}
                        >
                          <span className={styles.avatar}>{initials(o.displayName)}</span>
                          <span className={styles.ownerChipName}>{o.displayName}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}

            {item.collaborators.length > 0 && (
              <div className={styles.avatarStack} aria-label="Collaborators">
                {item.collaborators.slice(0, 3).map((c, i) => (
                  <span
                    key={c.oid}
                    className={styles.avatar}
                    style={{ zIndex: 10 - i }}
                    title={c.displayName}
                  >
                    {initials(c.displayName)}
                  </span>
                ))}
              </div>
            )}

            <select
              className={styles.releaseSelect}
              value={pendingReleaseId}
              onChange={(e) => { setPendingReleaseId(e.target.value); setDirty(true); }}
              aria-label="Target release"
              data-testid="work-item-release-select"
            >
              <option value="">No release</option>
              {releases.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}{r.targetDate ? ` · ${r.targetDate}` : ''}
                </option>
              ))}
            </select>

            <span className={styles.updatedMeta}>{relativeTime(item.updatedAt)}</span>
          </div>

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
        </header>

        <nav className={styles.sectionNav} aria-label="Work item sections" data-testid="work-item-section-nav">
          {PRIMARY_SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`${styles.sectionChip} ${activeSection === s.id ? styles.sectionChipActive : ''}`}
              onClick={() => scrollToSection(s.id)}
              data-testid={`work-item-section-chip-${s.id}`}
            >
              {s.label}
            </button>
          ))}
          <div className={styles.moreWrap} ref={moreMenuRef}>
            <button
              type="button"
              className={`${styles.sectionChip} ${MORE_SECTIONS.some((s) => s.id === activeSection) ? styles.sectionChipActive : ''}`}
              onClick={() => setMoreOpen((o) => !o)}
              aria-expanded={moreOpen}
              aria-haspopup="menu"
              data-testid="work-item-section-more"
            >
              More
            </button>
            {moreOpen && (
              <div className={styles.moreMenu} role="menu">
                {MORE_SECTIONS.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    role="menuitem"
                    className={`${styles.moreMenuItem} ${activeSection === s.id ? styles.moreMenuItemActive : ''}`}
                    onClick={() => scrollToSection(s.id)}
                    data-testid={`work-item-section-chip-${s.id}`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </nav>

        <div className={styles.body} ref={bodyRef}>

          <div
            className={sectionClassName('description')}
            data-section-id="description"
            id="work-item-section-description"
          >
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

          <div
            className={sectionClassName('acceptance')}
            data-section-id="acceptance"
            id="work-item-section-acceptance"
          >
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

          <div
            className={sectionClassName('development')}
            data-section-id="development"
            id="work-item-section-development"
          >
            <span className={styles.sectionLabel}>Development</span>
            <div className={styles.devGrid}>
              <label className={styles.devField}>
                <span className={styles.devFieldLabel}>Branch</span>
                <input
                  className={styles.fieldInput}
                  value={editBranch}
                  onChange={(e) => { setEditBranch(e.target.value); setDirty(true); }}
                  placeholder="feature/apex-…"
                />
              </label>
              <label className={styles.devField}>
                <span className={styles.devFieldLabel}>Pull request</span>
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
              </label>
            </div>
          </div>

          <div
            className={sectionClassName('hierarchy')}
            data-section-id="hierarchy"
            id="work-item-section-hierarchy"
            data-testid="work-item-hierarchy"
          >
            <span className={styles.sectionLabel}>Hierarchy</span>
            {(item.epicTitle || item.featureTitle) && (
              <p className={styles.breadcrumbLine}>
                {[item.epicTitle, item.featureTitle].filter(Boolean).join(' › ')}
              </p>
            )}
            {item.parent ? (
              <div className={styles.hierarchyBlock}>
                <span className={styles.devFieldLabel}>Parent</span>
                <button
                  type="button"
                  className={styles.fieldLink}
                  onClick={() => onOpenItem?.(item.parent!.id)}
                  data-testid="work-item-parent-link"
                >
                  APX-{item.parent.itemNumber} · {item.parent.type} · {item.parent.title}
                </button>
              </div>
            ) : (
              <p className={styles.sectionContent}>No parent linked</p>
            )}
            <div className={styles.hierarchyBlock}>
              <span className={styles.devFieldLabel}>Children ({(item.children ?? []).length})</span>
              {(item.children ?? []).length === 0 ? (
                <p className={styles.sectionContent}>No child work items</p>
              ) : (
                <div className={styles.childList}>
                  {(item.children ?? []).map((child) => (
                    <button
                      key={child.id}
                      type="button"
                      className={styles.fieldLink}
                      onClick={() => onOpenItem?.(child.id)}
                      data-testid={`work-item-child-${child.id}`}
                    >
                      APX-{child.itemNumber} · {child.type} · {child.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div
            className={sectionClassName('source')}
            data-section-id="source"
            id="work-item-section-source"
          >
            <span className={styles.sectionLabel}>Source &amp; docs</span>
            {(item.documentLinks?.length ?? 0) > 0 || item.featureRequestId || item.prdId ? (
              <>
                <div className={styles.docLinkGrid} data-testid="work-item-document-links">
                  {(item.documentLinks ?? []).map((link) => (
                    <button
                      key={link.kind}
                      type="button"
                      className={`${styles.docLinkChip} ${link.available ? '' : styles.docLinkChipUnavailable}`}
                      onClick={() => {
                        if (!link.available) return;
                        navigate(link.path);
                      }}
                      disabled={!link.available}
                      title={link.available ? `Open ${link.label}` : `${link.label} not available yet`}
                      data-testid={`work-item-doc-link-${link.kind}`}
                    >
                      {link.label}
                    </button>
                  ))}
                  <span className={styles.docLinkChipCurrent} title="This work item">
                    APX-{item.itemNumber}
                  </span>
                </div>
                <p className={styles.sectionContent} style={{ marginTop: 4, color: 'var(--text-muted)' }}>
                  Design Doc opens design + tech-spec + assumptions (ADO Feature attach set).
                </p>
              </>
            ) : (
              <span className={styles.noSource}>No linked source (standalone)</span>
            )}
          </div>

          <div
            className={sectionClassName('attachments')}
            data-section-id="attachments"
            id="work-item-section-attachments"
          >
            <span className={styles.sectionLabel}>Attachments</span>
            <p className={styles.sectionContent} style={{ marginBottom: 8 }}>
              Upload a file (opens in a new tab) or link an external URL.
            </p>
            <div className={styles.activityList}>
              {attachments.length === 0 && (
                <p className={styles.sectionContent}>No attachments yet.</p>
              )}
              {attachments.map((a) => {
                const href = attachmentHref(a, project);
                return (
                  <div key={a.id} className={styles.attachmentRow}>
                    <div className={styles.activityBody}>
                      <div className={styles.activityText}>
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={styles.fieldLink}
                          data-testid={`work-item-attachment-link-${a.id}`}
                        >
                          {a.fileName}
                        </a>
                        <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>
                          {formatBytes(a.byteSize)}
                        </span>
                      </div>
                      <div className={styles.activityTime}>
                        {a.uploadedBy.displayName} · {relativeTime(a.createdAt)}
                      </div>
                    </div>
                    <button
                      type="button"
                      className={styles.acRemoveBtn}
                      onClick={() => setConfirmDeleteAttachmentId(a.id)}
                      aria-label={`Delete attachment ${a.fileName}`}
                      title="Delete attachment"
                      data-testid={`work-item-attachment-delete-${a.id}`}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M3 6h18" />
                        <path d="M8 6V4h8v2" />
                        <path d="M19 6l-1 14H6L5 6" />
                        <path d="M10 11v6M14 11v6" />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
            <label className={styles.sectionLabel} style={{ marginTop: 10, display: 'block' }}>
              Upload file
              <input
                type="file"
                style={{ display: 'block', marginTop: 6 }}
                onChange={(e) => {
                  handleMetaFileAttach(e.target.files?.[0] ?? null);
                  e.target.value = '';
                }}
                data-testid="work-item-attach-file"
              />
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
              <input
                className={styles.fieldInput}
                value={attachFileName}
                onChange={(e) => setAttachFileName(e.target.value)}
                placeholder="File name"
                aria-label="Attachment file name"
                data-testid="work-item-attach-url-name"
              />
              <input
                className={styles.fieldInput}
                value={attachUrl}
                onChange={(e) => setAttachUrl(e.target.value)}
                placeholder="https://… or /path"
                aria-label="Attachment URL"
                data-testid="work-item-attach-url"
              />
              <button
                type="button"
                className={styles.btnSave}
                onClick={handleUrlAttach}
                disabled={
                  !attachFileName.trim() ||
                  !attachUrl.trim() ||
                  addAttachment.isPending
                }
                data-testid="work-item-attach-url-submit"
              >
                {addAttachment.isPending ? 'Saving…' : 'Link URL'}
              </button>
            </div>
          </div>

          <div
            className={sectionClassName('comments')}
            data-section-id="comments"
            id="work-item-section-comments"
          >
            <span className={styles.sectionLabel}>Comments</span>
            <div className={styles.activityList}>
              {(item.comments ?? []).length === 0 && (
                <p className={styles.sectionContent}>No comments yet. Use @name to mention someone.</p>
              )}
              {(item.comments ?? []).map((c) => (
                <div key={c.id} className={styles.activityItem}>
                  <div className={styles.activityBody}>
                    <div className={styles.activityText}>
                      <strong>{c.author.displayName}</strong> {c.body}
                    </div>
                    <div className={styles.activityTime}>{relativeTime(c.createdAt)}</div>
                  </div>
                </div>
              ))}
            </div>
            <textarea
              className={styles.fieldTextarea}
              value={commentBody}
              onChange={(e) => setCommentBody(e.target.value)}
              rows={2}
              placeholder="Add a comment… use @Name to mention"
              data-testid="work-item-comment-input"
            />
            <button
              type="button"
              className={styles.btnSave}
              style={{ marginTop: 8 }}
              onClick={handlePostComment}
              disabled={!commentBody.trim() || addComment.isPending}
              data-testid="work-item-comment-submit"
            >
              {addComment.isPending ? 'Posting…' : 'Post comment'}
            </button>
          </div>

          <div
            className={sectionClassName('activity')}
            data-section-id="activity"
            id="work-item-section-activity"
          >
            <span className={styles.sectionLabel}>Activity</span>
            <div className={styles.activityList}>
              {(item.events ?? []).length === 0 && (
                <p className={styles.sectionContent}>No activity yet.</p>
              )}
              {[...(item.events ?? [])].reverse().map((ev) => (
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

        </div>

        {/* Save bar */}
        {dirty && (
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

      {confirmDeleteAttachmentId && (
        <ConfirmDeleteModal
          title="Delete attachment"
          itemName={attachments.find((a) => a.id === confirmDeleteAttachmentId)?.fileName ?? 'this attachment'}
          isPending={deleteAttachment.isPending}
          onConfirm={() => confirmDeleteAttachment(confirmDeleteAttachmentId)}
          onCancel={() => setConfirmDeleteAttachmentId(null)}
        />
      )}
    </div>
  );
};
