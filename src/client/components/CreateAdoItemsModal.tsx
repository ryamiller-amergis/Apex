import React, { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import type {
  Prd,
  DesignDocSummary,
  CreatePrdAdoItemsRequest,
  SelectedBacklogEpic,
  SelectedBacklogFeature,
  SelectedBacklogPBI,
  GlobalBusinessRule,
} from '../../shared/types/interview';
import { useProjectAreaPaths } from '../hooks/useProjects';
import styles from './CreateAdoItemsModal.module.css';

/* ── Backlog shape (mirrors BacklogViewer local types) ─────────────────────── */

interface BacklogItemNode {
  type: 'PBI' | 'TBI';
  id: string;
  title: string;
  description?: string;
  priority?: string;
  acceptanceCriteria?: Array<{ given?: string; when?: string; then?: string }>;
  userStory?: { persona?: string; iWant?: string; soThat?: string };
  businessRules?: string[];
  nonFunctionalRequirements?: string[] | Record<string, string>;
  definitionOfDone?: string[];
  outOfScope?: string[];
  dependsOn?: string[];
  adoWorkItemId?: number;
  adoWorkItemUrl?: string;
}

interface FeatureNode {
  title: string;
  description?: string;
  priority?: string;
  affectedPersonas?: string[];
  outOfScope?: string[];
  dependencies?: string[];
  items?: BacklogItemNode[];
  adoWorkItemId?: number;
  adoWorkItemUrl?: string;
}

interface EpicNode {
  title: string;
  description?: string;
  priority?: string;
  successMetrics?: string[];
  outOfScope?: string[];
  assumptions?: string[];
  dependencies?: string[];
  features?: FeatureNode[];
  adoWorkItemId?: number;
  adoWorkItemUrl?: string;
}

interface BacklogData {
  epics?: EpicNode[];
  businessRules?: Array<{ id: string; rule: string; appliesTo?: string }>;
}

/* ── Props ─────────────────────────────────────────────────────────────────── */

interface CreateAdoItemsModalProps {
  prd: Prd;
  isPending: boolean;
  designDocs: DesignDocSummary[];
  onSubmit: (req: CreatePrdAdoItemsRequest) => Promise<void>;
  onCancel: () => void;
}

/* ── Key helpers ───────────────────────────────────────────────────────────── */

function epicKey(ei: number) {
  return `epic-${ei}`;
}
function featureKey(ei: number, fi: number) {
  return `feature-${ei}-${fi}`;
}
function pbiKey(ei: number, fi: number, pi: number) {
  return `pbi-${ei}-${fi}-${pi}`;
}

/* ── Design doc ↔ feature title matching ──────────────────────────────────── */

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Finds the first approved design doc whose title (or validation scorecard
 * feature titles) fuzzy-matches the given feature title.
 *
 * Matching strategy (in order):
 *  1. Exact normalized match
 *  2. One normalized title contains the other (handles humanized-slug titles
 *     being shorter than the full feature title, e.g. "User Auth" vs
 *     "User Authentication and Authorization")
 *  3. Scorecard feature_title exact normalized match
 */
function findMatchingDoc(
  featureTitle: string,
  approvedDocs: DesignDocSummary[],
): DesignDocSummary | undefined {
  const featNorm = normalizeTitle(featureTitle);
  for (const doc of approvedDocs) {
    const docNorm = normalizeTitle(doc.title);
    if (docNorm === featNorm) return doc;
    // Guard against single-word false positives by requiring min length 4
    if (featNorm.length >= 4 && docNorm.length >= 4) {
      if (featNorm.includes(docNorm) || docNorm.includes(featNorm)) return doc;
    }
    // Fall back to scorecard feature titles if present
    const scorecardFeatures = doc.validationScorecard?.features ?? [];
    for (const sf of scorecardFeatures) {
      const sfNorm = normalizeTitle(sf.feature_title);
      if (sfNorm === featNorm) return doc;
      if (featNorm.length >= 4 && sfNorm.length >= 4) {
        if (featNorm.includes(sfNorm) || sfNorm.includes(featNorm)) return doc;
      }
    }
  }
  return undefined;
}

/* ── Component ─────────────────────────────────────────────────────────────── */

export const CreateAdoItemsModal: React.FC<CreateAdoItemsModalProps> = ({
  prd,
  isPending,
  designDocs,
  onSubmit,
  onCancel,
}) => {
  const [areaPath, setAreaPath] = useState(prd.project);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const panelRef = useRef<HTMLDivElement>(null);

  const { data: areaPaths, isLoading: areaPathsLoading, isError: areaPathsError } = useProjectAreaPaths(prd.project);

  useEffect(() => {
    if (areaPaths && areaPaths.length > 0 && areaPath === prd.project) {
      setAreaPath(areaPaths[0]);
    }
  }, [areaPaths, areaPath, prd.project]);

  const backlog = useMemo<BacklogData>(() => {
    if (!prd.backlogJson) return {};
    if (typeof prd.backlogJson === 'string') {
      try { return JSON.parse(prd.backlogJson) as BacklogData; }
      catch { return {}; }
    }
    return prd.backlogJson as BacklogData;
  }, [prd.backlogJson]);

  // Map from featureKey(ei, fi) → the matching approved DesignDocSummary.
  //
  // Single-doc PRD (designDocs.length === 1): the one doc covers the entire
  // PRD — unlock all features when it is approved. No title matching needed.
  //
  // Multi-doc PRD (designDocs.length > 1): one doc per feature workflow.
  // Title-match each feature to its own approved doc; features with no
  // matching approved doc stay locked (preserves per-feature gating).
  const featureDocMap = useMemo<Map<string, DesignDocSummary>>(() => {
    const map = new Map<string, DesignDocSummary>();
    const approvedDocs = designDocs.filter(d => d.status === 'approved');
    if (approvedDocs.length === 0) return map;

    if (designDocs.length === 1) {
      // Holistic single doc — unlock every feature.
      (backlog.epics ?? []).forEach((epic, ei) => {
        (epic.features ?? []).forEach((_feat, fi) => {
          map.set(featureKey(ei, fi), approvedDocs[0]);
        });
      });
      return map;
    }

    // Multi-doc: title-match each feature to its own approved doc.
    (backlog.epics ?? []).forEach((epic, ei) => {
      (epic.features ?? []).forEach((feat, fi) => {
        const doc = findMatchingDoc(feat.title, approvedDocs);
        if (doc) map.set(featureKey(ei, fi), doc);
      });
    });
    return map;
  }, [backlog, designDocs]);

  // Count of features with no approved design doc and not yet in ADO
  const lockedFeatureCount = useMemo(() => {
    let count = 0;
    (backlog.epics ?? []).forEach((epic, ei) => {
      (epic.features ?? []).forEach((feat, fi) => {
        if (!feat.adoWorkItemId && !featureDocMap.has(featureKey(ei, fi))) count++;
      });
    });
    return count;
  }, [backlog, featureDocMap]);

  // Returns only the keys of selectable (enabled, not-in-ADO) children
  const getChildKeys = useCallback((key: string): string[] => {
    const children: string[] = [];
    const parts = key.split('-');
    if (parts[0] === 'epic') {
      const ei = Number(parts[1]);
      const epic = backlog.epics?.[ei];
      if (!epic) return children;
      (epic.features ?? []).forEach((feat, fi) => {
        const fk = featureKey(ei, fi);
        const featSelectable = !feat.adoWorkItemId && featureDocMap.has(fk);
        if (featSelectable) children.push(fk);
        (feat.items ?? []).forEach((item, pi) => {
          if (!item.adoWorkItemId && featSelectable) children.push(pbiKey(ei, fi, pi));
        });
      });
    } else if (parts[0] === 'feature') {
      const ei = Number(parts[1]);
      const fi = Number(parts[2]);
      const feat = backlog.epics?.[ei]?.features?.[fi];
      if (!feat) return children;
      (feat.items ?? []).forEach((item, pi) => {
        if (!item.adoWorkItemId) children.push(pbiKey(ei, fi, pi));
      });
    }
    return children;
  }, [backlog, featureDocMap]);

  const handleCheck = useCallback((key: string, isChecked: boolean) => {
    setChecked(prev => {
      const next = new Set(prev);
      const children = getChildKeys(key);
      if (isChecked) {
        next.add(key);
        children.forEach(c => next.add(c));
      } else {
        next.delete(key);
        children.forEach(c => next.delete(c));
      }
      return next;
    });
  }, [getChildKeys]);

  const isIndeterminate = useCallback((key: string): boolean => {
    const children = getChildKeys(key);
    if (children.length === 0) return false;
    const checkedCount = children.filter(c => checked.has(c)).length;
    return checkedCount > 0 && checkedCount < children.length;
  }, [getChildKeys, checked]);

  const toggleCollapse = useCallback((key: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const summary = useMemo(() => {
    let epics = 0, features = 0, pbis = 0, tbis = 0;
    checked.forEach(k => {
      if (k.startsWith('epic-')) epics++;
      else if (k.startsWith('feature-')) features++;
      else if (k.startsWith('pbi-')) {
        const parts = k.split('-');
        const itemType = backlog.epics?.[Number(parts[1])]
          ?.features?.[Number(parts[2])]
          ?.items?.[Number(parts[3])]?.type;
        if (itemType === 'TBI') tbis++;
        else pbis++;
      }
    });
    return { epics, features, pbis, tbis };
  }, [checked, backlog]);

  const canSubmit = useMemo(() => {
    return !isPending && areaPath.trim().length > 0 && checked.size > 0;
  }, [isPending, areaPath, checked]);

  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;
    const epics = backlog.epics ?? [];
    const selectedEpics: SelectedBacklogEpic[] = [];

    epics.forEach((epic, ei) => {
      const ek = epicKey(ei);
      const epicSelected = checked.has(ek);
      const selectedFeatures: SelectedBacklogFeature[] = [];

      (epic.features ?? []).forEach((feat, fi) => {
        const fk = featureKey(ei, fi);
        const featureSelected = checked.has(fk);
        const selectedPBIs: SelectedBacklogPBI[] = [];

        (feat.items ?? []).forEach((item, pi) => {
          if (checked.has(pbiKey(ei, fi, pi))) {
            selectedPBIs.push({
              id: item.id,
              title: item.title,
              description: item.description,
              priority: item.priority,
              acceptanceCriteria: item.acceptanceCriteria,
              userStory: item.userStory,
              businessRules: item.businessRules,
              nonFunctionalRequirements: item.nonFunctionalRequirements,
              definitionOfDone: item.definitionOfDone,
              outOfScope: item.outOfScope,
              dependsOn: item.dependsOn,
            });
          }
        });

        if (featureSelected || selectedPBIs.length > 0) {
          selectedFeatures.push({
            title: feat.title,
            description: feat.description,
            priority: feat.priority,
            affectedPersonas: feat.affectedPersonas,
            outOfScope: feat.outOfScope,
            dependencies: feat.dependencies,
            items: selectedPBIs.length > 0 ? selectedPBIs : undefined,
          });
        }
      });

      if (epicSelected || selectedFeatures.length > 0) {
        selectedEpics.push({
          title: epic.title,
          description: epic.description,
          priority: epic.priority,
          successMetrics: epic.successMetrics,
          outOfScope: epic.outOfScope,
          assumptions: epic.assumptions,
          dependencies: epic.dependencies,
          features: selectedFeatures.length > 0 ? selectedFeatures : undefined,
        });
      }
    });

    const globalBusinessRules: GlobalBusinessRule[] | undefined =
      backlog.businessRules && backlog.businessRules.length > 0
        ? backlog.businessRules
        : undefined;

    const req: CreatePrdAdoItemsRequest = {
      project: prd.project,
      areaPath: areaPath.trim(),
      globalBusinessRules,
      selectedItems: { epics: selectedEpics },
    };
    onSubmit(req);
  }, [canSubmit, backlog, checked, prd.project, areaPath, onSubmit]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  return (
    <div
      className={styles.overlay}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-ado-items-title"
    >
      <div className={styles.panel} ref={panelRef}>
        {/* Header */}
        <div className={styles.header}>
          <h2 className={styles.title} id="create-ado-items-title">
            Create Work Items in ADO
          </h2>
          <button
            className={styles['close-btn']}
            onClick={onCancel}
            type="button"
            aria-label="Close"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className={styles.body}>
          {/* Area Path */}
          <p className={styles['section-label']}>Area Path</p>
          <div className={styles['field-row']}>
            <div className={styles['field-group']}>
              <span className={styles['field-label']}>Project</span>
              <span className={styles['project-label']}>{prd.project}</span>
            </div>
            <div className={styles['field-group']}>
              <span className={styles['field-label']}>Area Path</span>
              {areaPathsError ? (
                <input
                  className={styles.input}
                  type="text"
                  value={areaPath}
                  onChange={(e) => setAreaPath(e.target.value)}
                  placeholder={`${prd.project}\\TeamName`}
                />
              ) : (
                <select
                  className={styles.select}
                  value={areaPath}
                  onChange={(e) => setAreaPath(e.target.value)}
                  disabled={areaPathsLoading}
                >
                  {areaPathsLoading && <option value="">Loading area paths…</option>}
                  {!areaPathsLoading && (!areaPaths || areaPaths.length === 0) && (
                    <option value={prd.project}>{prd.project}</option>
                  )}
                  {areaPaths?.map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              )}
            </div>
          </div>

          {/* Checklist tree */}
          <p className={styles['section-label']}>Select Items</p>

          {lockedFeatureCount > 0 && (
            <div className={styles['pending-banner']}>
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
                <circle cx="8" cy="8" r="6.5" />
                <line x1="8" y1="5" x2="8" y2="8.5" />
                <circle cx="8" cy="11" r="0.5" fill="currentColor" stroke="none" />
              </svg>
              <span>
                <strong>{lockedFeatureCount} feature{lockedFeatureCount !== 1 ? 's' : ''}</strong>
                {lockedFeatureCount !== 1 ? ' are' : ' is'} locked — {lockedFeatureCount !== 1 ? 'their' : 'its'} design doc{lockedFeatureCount !== 1 ? 's are' : ' is'} still pending review.
              </span>
            </div>
          )}

          <div className={styles['checklist-section']}>
            {(backlog.epics ?? []).map((epic, ei) => (
              <EpicRow
                key={ei}
                epic={epic}
                ei={ei}
                checked={checked}
                collapsed={collapsed}
                onCheck={handleCheck}
                onToggleCollapse={toggleCollapse}
                isIndeterminate={isIndeterminate}
                featureDocMap={featureDocMap}
              />
            ))}
            {(!backlog.epics || backlog.epics.length === 0) && (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                No backlog items found in this PRD.
              </p>
            )}
          </div>
        </div>

        {/* Summary */}
        <div className={styles['summary-bar']} data-testid="summary-bar">
          <span>
            <span className={styles['summary-count']}>{summary.epics}</span> Epic{summary.epics !== 1 ? 's' : ''},&nbsp;
            <span className={styles['summary-count']}>{summary.features}</span> Feature{summary.features !== 1 ? 's' : ''},&nbsp;
            <span className={styles['summary-count']}>{summary.pbis}</span> PBI{summary.pbis !== 1 ? 's' : ''}
            {summary.tbis > 0 && (
              <>,&nbsp;<span className={styles['summary-count']}>{summary.tbis}</span> TBI{summary.tbis !== 1 ? 's' : ''}</>
            )}
            {' '}selected
          </span>
        </div>

        {/* Footer */}
        <div className={styles.footer}>
          <button
            className={styles['btn-cancel']}
            onClick={onCancel}
            disabled={isPending}
            type="button"
          >
            Cancel
          </button>
          <button
            className={styles['btn-submit']}
            onClick={handleSubmit}
            disabled={!canSubmit}
            type="button"
          >
            {isPending ? 'Creating...' : 'Create in ADO'}
          </button>
        </div>
      </div>
    </div>
  );
};

/* ── Tree row sub-components ───────────────────────────────────────────────── */

interface EpicRowProps {
  epic: EpicNode;
  ei: number;
  checked: Set<string>;
  collapsed: Set<string>;
  onCheck: (key: string, isChecked: boolean) => void;
  onToggleCollapse: (key: string) => void;
  isIndeterminate: (key: string) => boolean;
  featureDocMap: Map<string, DesignDocSummary>;
}

const EpicRow: React.FC<EpicRowProps> = ({
  epic, ei, checked, collapsed, onCheck, onToggleCollapse, isIndeterminate, featureDocMap,
}) => {
  const key = epicKey(ei);
  const isCollapsed = collapsed.has(key);
  const hasChildren = (epic.features ?? []).length > 0;
  const inAdo = !!epic.adoWorkItemId;
  const isChecked = inAdo || checked.has(key);
  const indeterminate = !inAdo && isIndeterminate(key);

  return (
    <div>
      <div className={`${styles['tree-node']} ${styles['tree-level-epic']}`}>
        {hasChildren ? (
          <button
            className={styles['collapse-btn']}
            onClick={() => onToggleCollapse(key)}
            type="button"
            aria-label={isCollapsed ? 'Expand' : 'Collapse'}
          >
            <ChevronIcon collapsed={isCollapsed} />
          </button>
        ) : (
          <span style={{ width: 20 }} />
        )}
        <IndeterminateCheckbox
          checked={isChecked}
          indeterminate={indeterminate}
          disabled={inAdo}
          onChange={(val) => onCheck(key, val)}
        />
        <EpicIcon />
        <span className={`${styles['node-title']} ${inAdo ? styles['node-title-disabled'] : ''}`}>
          {epic.title}
        </span>
        {epic.priority && (
          <span className={`${styles.badge} ${styles['badge-priority']}`}>{epic.priority}</span>
        )}
        {inAdo && (
          <>
            <span className={`${styles.badge} ${styles['badge-ado']}`}>In ADO</span>
            {epic.adoWorkItemUrl && (
              <a
                className={styles['ado-link']}
                href={epic.adoWorkItemUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                View
              </a>
            )}
          </>
        )}
      </div>
      <div className={`${styles.children} ${isCollapsed ? styles['children-collapsed'] : ''}`}>
        {(epic.features ?? []).map((feat, fi) => (
          <FeatureRow
            key={fi}
            feature={feat}
            ei={ei}
            fi={fi}
            checked={checked}
            collapsed={collapsed}
            onCheck={onCheck}
            onToggleCollapse={onToggleCollapse}
            isIndeterminate={isIndeterminate}
            designDoc={featureDocMap.get(featureKey(ei, fi))}
          />
        ))}
      </div>
    </div>
  );
};

interface FeatureRowProps {
  feature: FeatureNode;
  ei: number;
  fi: number;
  checked: Set<string>;
  collapsed: Set<string>;
  onCheck: (key: string, isChecked: boolean) => void;
  onToggleCollapse: (key: string) => void;
  isIndeterminate: (key: string) => boolean;
  designDoc: DesignDocSummary | undefined;
}

const FeatureRow: React.FC<FeatureRowProps> = ({
  feature, ei, fi, checked, collapsed, onCheck, onToggleCollapse, isIndeterminate, designDoc,
}) => {
  const key = featureKey(ei, fi);
  const isCollapsed = collapsed.has(key);
  const hasChildren = (feature.items ?? []).length > 0;
  const inAdo = !!feature.adoWorkItemId;
  const isDisabled = inAdo || !designDoc;
  const isChecked = inAdo || checked.has(key);
  const indeterminate = !isDisabled && isIndeterminate(key);

  return (
    <div>
      <div className={`${styles['tree-node']} ${styles['tree-level-feature']} ${isDisabled && !inAdo ? styles['node-locked'] : ''}`}>
        {hasChildren ? (
          <button
            className={styles['collapse-btn']}
            onClick={() => onToggleCollapse(key)}
            type="button"
            aria-label={isCollapsed ? 'Expand' : 'Collapse'}
          >
            <ChevronIcon collapsed={isCollapsed} />
          </button>
        ) : (
          <span style={{ width: 20 }} />
        )}
        <IndeterminateCheckbox
          checked={isChecked}
          indeterminate={indeterminate}
          disabled={isDisabled}
          onChange={(val) => onCheck(key, val)}
        />
        <FeatureIcon />
        <span className={`${styles['node-title']} ${isDisabled ? styles['node-title-disabled'] : ''}`}>
          {feature.title}
        </span>
        {feature.priority && (
          <span className={`${styles.badge} ${styles['badge-priority']}`}>{feature.priority}</span>
        )}
        {inAdo && (
          <>
            <span className={`${styles.badge} ${styles['badge-ado']}`}>In ADO</span>
            {feature.adoWorkItemUrl && (
              <a
                className={styles['ado-link']}
                href={feature.adoWorkItemUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                View
              </a>
            )}
          </>
        )}
        {!inAdo && designDoc && (
          <a
            className={styles['doc-link']}
            href={`/backlog/design-doc/${designDoc.id}`}
            target="_blank"
            rel="noopener noreferrer"
            title={`Design Doc: ${designDoc.title}`}
          >
            ✓ Design Doc
          </a>
        )}
        {!inAdo && !designDoc && (
          <span
            className={`${styles.badge} ${styles['badge-pending']}`}
            title="Design doc must be approved before this feature can be pushed to ADO"
          >
            Design doc pending
          </span>
        )}
      </div>
      <div className={`${styles.children} ${isCollapsed ? styles['children-collapsed'] : ''}`}>
        {(feature.items ?? []).map((item, pi) => (
          <PbiRow
            key={pi}
            item={item}
            ei={ei}
            fi={fi}
            pi={pi}
            checked={checked}
            onCheck={onCheck}
            featureApproved={!!designDoc}
          />
        ))}
      </div>
    </div>
  );
};

interface PbiRowProps {
  item: BacklogItemNode;
  ei: number;
  fi: number;
  pi: number;
  checked: Set<string>;
  onCheck: (key: string, isChecked: boolean) => void;
  featureApproved: boolean;
}

const PbiRow: React.FC<PbiRowProps> = ({ item, ei, fi, pi, checked, onCheck, featureApproved }) => {
  const key = pbiKey(ei, fi, pi);
  const inAdo = !!item.adoWorkItemId;
  const isDisabled = inAdo || !featureApproved;
  const isChecked = inAdo || checked.has(key);

  return (
    <div className={`${styles['tree-node']} ${styles[item.type === 'TBI' ? 'tree-level-tbi' : 'tree-level-pbi']} ${!featureApproved && !inAdo ? styles['node-locked'] : ''}`}>
      <span style={{ width: 20 }} />
      <input
        type="checkbox"
        className={styles.checkbox}
        checked={isChecked}
        disabled={isDisabled}
        onChange={(e) => onCheck(key, e.target.checked)}
      />
      {item.type === 'TBI' ? <TbiIcon /> : <PbiIcon />}
      <span className={`${styles['node-title']} ${isDisabled ? styles['node-title-disabled'] : ''}`}>
        {item.title}
      </span>
      <span className={`${styles.badge} ${item.type === 'TBI' ? styles['badge-type-tbi'] : styles['badge-type-pbi']}`}>
        {item.type}
      </span>
      {inAdo && (
        <>
          <span className={`${styles.badge} ${styles['badge-ado']}`}>In ADO</span>
          {item.adoWorkItemUrl && (
            <a
              className={styles['ado-link']}
              href={item.adoWorkItemUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              View
            </a>
          )}
        </>
      )}
    </div>
  );
};

/* ── Type icon components (match WorkItemCard / ScrumCalendar emoji icons) ── */

const EpicIcon: React.FC = () => (
  <span className={styles['type-icon']} aria-hidden="true">👑</span>
);

const FeatureIcon: React.FC = () => (
  <span className={styles['type-icon']} aria-hidden="true">⭐</span>
);

const PbiIcon: React.FC = () => (
  <span className={styles['type-icon']} aria-hidden="true">📋</span>
);

const TbiIcon: React.FC = () => (
  <span className={styles['type-icon']} aria-hidden="true">🔧</span>
);

/* ── Shared small components ───────────────────────────────────────────────── */

const ChevronIcon: React.FC<{ collapsed: boolean }> = ({ collapsed }) => (
  <svg
    className={`${styles['collapse-icon']} ${collapsed ? styles['collapse-icon-collapsed'] : ''}`}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

interface IndeterminateCheckboxProps {
  checked: boolean;
  indeterminate: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}

const IndeterminateCheckbox: React.FC<IndeterminateCheckboxProps> = ({
  checked,
  indeterminate,
  disabled,
  onChange,
}) => {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return (
    <input
      ref={ref}
      type="checkbox"
      className={styles.checkbox}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
};

export default CreateAdoItemsModal;
