import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  ApexWorkItemType,
  MaterializePlanLeaf,
  MaterializePreviewResult,
} from '../../shared/types/apexWorkItem';
import {
  useApexWorkItemOwners,
  useMaterializeFromPrd,
  usePreviewMaterializeFromPrd,
} from '../hooks/useApexWorkItems';
import styles from './ApexMaterializeModal.module.css';

interface BacklogLeafItem {
  id: string;
  title: string;
  description?: string;
  type: 'PBI' | 'TBI' | 'Bug';
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
  project: string;
  prdId: string;
  prdTitle: string;
  backlog: { epics: BacklogEpic[] };
  onClose: () => void;
}

type Phase = 'select' | 'creating' | 'success';
type LinkChoice = string | 'create' | 'skip';

function actionLabel(action: MaterializePlanLeaf['action']): string {
  switch (action) {
    case 'skip':
      return 'On board';
    case 'link':
      return 'Will link';
    case 'choose':
      return 'Choose';
    case 'create':
      return 'Will create';
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

export const ApexMaterializeModal: React.FC<ApexMaterializeModalProps> = ({
  project,
  prdId,
  prdTitle,
  backlog,
  onClose,
}) => {
  const navigate = useNavigate();
  const { data: owners = [] } = useApexWorkItemOwners(project);
  const previewMutation = usePreviewMaterializeFromPrd(project);
  const materializeMutation = useMaterializeFromPrd(project);

  const allLeaves = useMemo(
    () =>
      backlog.epics.flatMap((e) =>
        e.features.flatMap((f) =>
          f.items.map((i) => ({
            ...i,
            epicId: e.id,
            epicTitle: e.title,
            featureId: f.id,
            featureTitle: f.title,
          })),
        ),
      ),
    [backlog],
  );

  const [selected, setSelected] = useState<Set<string>>(() => new Set(allLeaves.map((i) => i.id)));
  const [ownerId, setOwnerId] = useState<string>('');
  const [phase, setPhase] = useState<Phase>('select');
  const [preview, setPreview] = useState<MaterializePreviewResult | null>(null);
  const [linkChoices, setLinkChoices] = useState<Record<string, LinkChoice>>({});
  const [resultSummary, setResultSummary] = useState({ created: 0, linked: 0, skipped: 0 });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (owners.length > 0 && !ownerId) setOwnerId(owners[0].oid);
  }, [owners, ownerId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const plan = await previewMutation.mutateAsync({
          prdId,
          items: allLeaves.map((i) => ({
            id: i.id,
            title: i.title,
            description: i.description ?? '',
            type: i.type,
            acceptanceCriteria: i.acceptanceCriteria ?? [],
            epicId: i.epicId,
            epicTitle: i.epicTitle,
            featureId: i.featureId,
            featureTitle: i.featureTitle,
          })),
        });
        if (cancelled) return;
        setPreview(plan);
        const defaults: Record<string, LinkChoice> = {};
        for (const leaf of plan.leaves) {
          if (leaf.action === 'skip') defaults[leaf.backlogItemId] = 'skip';
          else if (leaf.action === 'link' && leaf.suggestedWorkItemId) {
            defaults[leaf.backlogItemId] = leaf.suggestedWorkItemId;
          } else if (leaf.action === 'create') defaults[leaf.backlogItemId] = 'create';
          else if (leaf.action === 'choose' && leaf.suggestedWorkItemId) {
            defaults[leaf.backlogItemId] = leaf.suggestedWorkItemId;
          } else defaults[leaf.backlogItemId] = 'create';
        }
        setLinkChoices(defaults);
        setSelected(new Set(plan.leaves.filter((l) => l.action !== 'skip').map((l) => l.backlogItemId)));
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
    // Preview once when modal opens with this backlog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prdId, project]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); },
    [onClose],
  );
  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const planById = useMemo(() => {
    const map = new Map<string, MaterializePlanLeaf>();
    preview?.leaves.forEach((l) => map.set(l.backlogItemId, l));
    return map;
  }, [preview]);

  const toggleItem = (id: string) => {
    const plan = planById.get(id);
    if (plan?.action === 'skip') return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedItems = useMemo(
    () => allLeaves.filter((i) => selected.has(i.id)),
    [allLeaves, selected],
  );

  const unresolvedChoose = useMemo(
    () =>
      selectedItems.some((i) => {
        const plan = planById.get(i.id);
        const choice = linkChoices[i.id];
        return plan?.action === 'choose' && (choice == null || choice === '');
      }),
    [selectedItems, planById, linkChoices],
  );

  const handleCreate = async () => {
    if (!selectedItems.length || !ownerId || unresolvedChoose) return;
    setPhase('creating');
    setError(null);
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
      const choices: Record<string, LinkChoice> = {};
      for (const i of selectedItems) {
        choices[i.id] = linkChoices[i.id] ?? 'create';
      }
      const result = await materializeMutation.mutateAsync({
        prdId,
        ownerId,
        items,
        linkChoices: choices,
      });
      setResultSummary({
        created: result.created.length,
        linked: result.linked.length,
        skipped: result.skipped,
      });
      setPhase('success');
    } catch (e) {
      setError((e as Error).message);
      setPhase('select');
    }
  };

  return (
    <div className={styles.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} {...{ 'data-testid': 'materialize-modal-overlay' }}>
      <div className={styles.modal} role="dialog" aria-modal aria-label="Create Work Items" style={{ maxWidth: 820 }} {...{ 'data-testid': 'materialize-modal-create-work-items' }}>
        <div className={styles.header}>
          <div className={styles.headerText}>
            <h2 className={styles.title}>Create Work Items</h2>
            <p className={styles.subtitle}>
              Sync <em>{prdTitle}</em> with the Work Board — link existing Feature Request cards or create new ones.
              {preview?.featureRequestId
                ? ' Linked Feature Request detected.'
                : ' No Feature Request linked to this PRD interview.'}
            </p>
          </div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close" {...{ 'data-testid': 'materialize-modal-close-btn' }}>
            <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 14 14">
              <path d="M2 2l10 10M12 2L2 12" />
            </svg>
          </button>
        </div>

        {error && (
          <div style={{ padding: '8px 24px', color: 'var(--danger, #b91c1c)', fontSize: '0.8rem' }}>
            {error}
          </div>
        )}

        {phase === 'creating' && (
          <div className={styles.progressState}>
            <span>Syncing {selectedItems.length} work items…</span>
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
            <div className={styles.successText}>
              {resultSummary.created} created · {resultSummary.linked} linked · {resultSummary.skipped} skipped
            </div>
          </div>
        )}

        {phase === 'select' && (
          <>
            <div className={styles.body}>
              <div className={styles.left}>
                {backlog.epics.map((epic) => (
                  <div key={epic.id} className={styles.epicGroup}>
                    <div className={styles.epicHeading}>{epic.title}</div>
                    {epic.features.map((feature) => (
                      <div key={feature.id} className={styles.featureGroup}>
                        <div className={styles.featureHeading}>{feature.title}</div>
                        <div className={styles.itemsList}>
                          {feature.items.map((item) => {
                            const plan = planById.get(item.id);
                            const done = plan?.action === 'skip';
                            const choice = linkChoices[item.id];
                            return (
                              <div
                                key={item.id}
                                className={styles.itemRow}
                                style={{ flexWrap: 'wrap', gap: 6 }}
                              >
                                <input
                                  type="checkbox"
                                  className={styles.itemCheckbox}
                                  checked={done || selected.has(item.id)}
                                  disabled={done}
                                  onChange={() => toggleItem(item.id)}
                                  aria-label={item.title}
                                 {...{ 'data-testid': 'materialize-modal-item-checkbox-input' }} />
                                <span
                                  className={`${styles.itemType} ${
                                    item.type === 'PBI' ? styles.itemTypePBI
                                      : item.type === 'TBI' ? styles.itemTypeTBI
                                        : styles.itemTypeBug
                                  }`}
                                >
                                  {item.type}
                                </span>
                                <span className={styles.itemTitle} style={{ opacity: done ? 0.5 : 1, flex: 1 }}>
                                  {item.title}
                                </span>
                                {plan && (
                                  <span className={styles.itemDoneBadge}>{actionLabel(plan.action)}</span>
                                )}
                                {!done && selected.has(item.id) && plan && (plan.action === 'choose' || plan.action === 'link' || plan.candidates.length > 0) && (
                                  <select
                                    className={styles.ownerSelect}
                                    style={{ width: '100%', marginLeft: 28 }}
                                    value={typeof choice === 'string' ? choice : 'create'}
                                    onChange={(e) =>
                                      setLinkChoices((prev) => ({
                                        ...prev,
                                        [item.id]: e.target.value as LinkChoice,
                                      }))
                                    }
                                    aria-label={`Reconcile action for ${item.title}`}
                                   {...{ 'data-testid': 'materialize-modal-owner-select' }}>
                                    <option value="create">Create new card</option>
                                    <option value="skip">Skip</option>
                                    {plan.candidates.map((c) => (
                                      <option key={c.id} value={c.id}>
                                        Link APX-{c.itemNumber}: {c.title} ({c.status})
                                      </option>
                                    ))}
                                  </select>
                                )}
                                {!done && selected.has(item.id) && plan?.action === 'create' && (
                                  <select
                                    className={styles.ownerSelect}
                                    style={{ width: '100%', marginLeft: 28 }}
                                    value={choice ?? 'create'}
                                    onChange={(e) =>
                                      setLinkChoices((prev) => ({
                                        ...prev,
                                        [item.id]: e.target.value as LinkChoice,
                                      }))
                                    }
                                    aria-label={`Action for ${item.title}`}
                                   {...{ 'data-testid': 'materialize-modal-owner-select-2' }}>
                                    <option value="create">Create new card</option>
                                    <option value="skip">Skip</option>
                                  </select>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              <div className={styles.right}>
                <div className={styles.previewLabel}>
                  Plan
                  {preview && (
                    <> · {preview.counts.link} link · {preview.counts.create} create · {preview.counts.choose} choose · {preview.counts.skip} on board</>
                  )}
                </div>
                {selectedItems.length === 0 ? (
                  <div className={styles.previewEmpty}>Select items to sync</div>
                ) : (
                  selectedItems.slice(0, 24).map((i) => {
                    const plan = planById.get(i.id);
                    const choice = linkChoices[i.id];
                    let label = 'Create';
                    if (choice === 'skip') label = 'Skip';
                    else if (choice && choice !== 'create') {
                      const c = plan?.candidates.find((x) => x.id === choice);
                      label = c ? `Link APX-${c.itemNumber}` : 'Link';
                    }
                    return (
                      <div key={i.id} className={styles.previewCard}>
                        <div className={styles.previewCardType}>{i.type}</div>
                        <div className={styles.previewCardTitle}>{i.title}</div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 4 }}>{label}</div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <div className={styles.ownerRow}>
              <span className={styles.ownerLabel}>Assign new cards to</span>
              <select
                className={styles.ownerSelect}
                value={ownerId}
                onChange={(e) => setOwnerId(e.target.value)}
               {...{ 'data-testid': 'materialize-modal-owner-select-3' }}>
                {owners.map((o) => (
                  <option key={o.oid} value={o.oid}>{o.displayName}</option>
                ))}
              </select>
            </div>

            <div className={styles.footer}>
              <span className={styles.footerCount}>
                {selected.size} selected
                {unresolvedChoose ? ' · resolve Choose rows' : ''}
              </span>
              <button className={styles.btnSecondary} onClick={onClose} {...{ 'data-testid': 'materialize-modal-btn-secondary' }}>Cancel</button>
              <button
                className={styles.btnPrimary}
                disabled={selected.size === 0 || !ownerId || unresolvedChoose || previewMutation.isPending}
                onClick={handleCreate}
               {...{ 'data-testid': 'materialize-modal-btn-primary' }}>
                Sync to Work Board
              </button>
            </div>
          </>
        )}

        {phase === 'success' && (
          <div className={styles.footer}>
            <div style={{ flex: 1 }} />
            <button className={styles.btnSecondary} onClick={onClose} {...{ 'data-testid': 'materialize-modal-btn-secondary-2' }}>Close</button>
            <button className={styles.btnPrimary} onClick={() => navigate('/work-board')} {...{ 'data-testid': 'materialize-modal-btn-primary-2' }}>
              Open Work Board
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
