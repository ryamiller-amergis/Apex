import React, { useState, useRef, useEffect, useContext, createContext } from 'react';
import styles from './BacklogViewer.module.css';

/* ── Local shape types (mirrors /to-prd output) ───────────────────────────── */

interface Persona {
  name: string;
  type?: string;
  description?: string;
}

interface BusinessRule {
  id: string;
  rule: string;
  appliesTo?: string;
}

interface UserStory {
  persona?: string;
  iWant?: string;
  soThat?: string;
}

interface AcceptanceCriterion {
  given?: string;
  when?: string;
  then?: string;
}

interface NonFunctionalRequirements {
  performance?: string;
  accessibility?: string;
  security?: string;
  compliance?: string;
  [key: string]: string | undefined;
}

interface BacklogItem {
  type: 'PBI' | 'TBI';
  id: string;
  title: string;
  priority?: string;
  dependsOn?: string[];
  parallelGroup?: string | null;
  description?: string;
  technicalDependencies?: string[];
  nonFunctionalRequirements?: string[] | NonFunctionalRequirements;
  definitionOfDone?: string[];
  userStory?: UserStory;
  businessRules?: string[];
  outOfScope?: string[];
  acceptanceCriteria?: AcceptanceCriterion[];
  adoWorkItemId?: number;
  adoWorkItemUrl?: string;
}

interface Feature {
  title: string;
  priority?: string;
  description?: string;
  affectedPersonas?: string[];
  outOfScope?: string[];
  dependencies?: string[];
  featureFlag?: { name: string };
  items?: BacklogItem[];
  adoWorkItemId?: number;
  adoWorkItemUrl?: string;
}

interface Epic {
  title: string;
  priority?: string;
  description?: string;
  successMetrics?: string[];
  outOfScope?: string[];
  assumptions?: string[];
  dependencies?: string[];
  features?: Feature[];
  adoWorkItemId?: number;
  adoWorkItemUrl?: string;
}

interface BacklogData {
  personas?: Persona[];
  businessRules?: BusinessRule[];
  epics?: Epic[];
  assumptionsMade?: string[];
}

function isBacklogData(val: unknown): val is BacklogData {
  return typeof val === 'object' && val !== null;
}

/* ── Edit context ─────────────────────────────────────────────────────────── */

type EditTarget =
  | { type: 'epic'; epicIndex: number }
  | { type: 'feature'; epicIndex: number; featureIndex: number }
  | { type: 'item'; epicIndex: number; featureIndex: number; itemIndex: number }
  | null;

interface BacklogEditContextValue {
  editable: boolean;
  onEditEpic: (epicIndex: number) => void;
  onEditFeature: (epicIndex: number, featureIndex: number) => void;
  onEditItem: (epicIndex: number, featureIndex: number, itemIndex: number) => void;
}

const BacklogEditContext = createContext<BacklogEditContextValue | null>(null);

/* ── Priority badge ───────────────────────────────────────────────────────── */

const PRIORITY_CLASS: Record<string, string> = {
  'Must Have': styles.priorityMust,
  'Should Have': styles.priorityShould,
  'Could Have': styles.priorityCould,
  "Won't Have": styles.priorityWont,
  'MoSCoW: Must Have': styles.priorityMust,
};

const PriorityBadge: React.FC<{ priority?: string }> = ({ priority }) => {
  if (!priority) return null;
  const cls = PRIORITY_CLASS[priority] ?? styles.priorityDefault;
  return <span className={`${styles.priorityBadge} ${cls}`}>{priority}</span>;
};

const AdoMergedBadge: React.FC<{ adoWorkItemId?: number }> = ({ adoWorkItemId }) => {
  if (!adoWorkItemId) return null;
  return (
    <span className={styles.adoMergedBadge} title={`ADO #${adoWorkItemId}`}>
      <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={styles.adoMergedIcon}>
        <polyline points="2 6.5 4.5 9 10 3.5" />
      </svg>
      In ADO
    </span>
  );
};

/* ── Pencil icon ──────────────────────────────────────────────────────────── */

const PencilIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11.5 2.5l2 2L5 13H3v-2L11.5 2.5z" />
  </svg>
);

/* ── Collapsible section ──────────────────────────────────────────────────── */

interface CollapsibleProps {
  header: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
}

const Collapsible: React.FC<CollapsibleProps> = ({ header, defaultOpen = false, children, className }) => {
  const [open, setOpen] = useState(defaultOpen);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const handler = () => setOpen(true);
    el.addEventListener('expand-for-comment', handler);
    return () => el.removeEventListener('expand-for-comment', handler);
  }, []);

  return (
    <div className={`${styles.collapsible} ${className ?? ''}`}>
      <button
        type="button"
        className={styles.collapsibleHeader}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <svg
          className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="4 6 8 10 12 6" />
        </svg>
        {header}
      </button>
      <div
        ref={bodyRef}
        data-collapsed={open ? undefined : 'true'}
        className={`${styles.collapsibleBody} ${open ? '' : styles.collapsibleBodyHidden}`}
      >
        {children}
      </div>
    </div>
  );
};

/* ── Acceptance criterion card ────────────────────────────────────────────── */

const AcCard: React.FC<{ ac: AcceptanceCriterion; index: number }> = ({ ac, index }) => (
  <div className={styles.acCard}>
    <div className={styles.acIndex}>#{index + 1}</div>
    {ac.given && (
      <div className={styles.acRow}>
        <span className={styles.acLabel}>Given</span>
        <span className={styles.acText}>{ac.given}</span>
      </div>
    )}
    {ac.when && (
      <div className={styles.acRow}>
        <span className={styles.acLabel}>When</span>
        <span className={styles.acText}>{ac.when}</span>
      </div>
    )}
    {ac.then && (
      <div className={styles.acRow}>
        <span className={styles.acLabel}>Then</span>
        <span className={styles.acText}>{ac.then}</span>
      </div>
    )}
  </div>
);

/* ── Non-functional requirements ─────────────────────────────────────────── */

const NfrSection: React.FC<{ nfr: string[] | NonFunctionalRequirements }> = ({ nfr }) => {
  if (Array.isArray(nfr)) {
    return (
      <ul className={styles.bulletList}>
        {nfr.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    );
  }
  const entries = Object.entries(nfr).filter(([, v]) => v);
  if (!entries.length) return null;
  return (
    <dl className={styles.nfrGrid}>
      {entries.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className={styles.nfrKey}>{k.charAt(0).toUpperCase() + k.slice(1)}</dt>
          <dd className={styles.nfrVal}>{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
};

/* ── Backlog item (PBI or TBI) ────────────────────────────────────────────── */

const ItemCard: React.FC<{
  item: BacklogItem;
  epicIndex: number;
  featureIndex: number;
  itemIndex: number;
}> = ({ item, epicIndex, featureIndex, itemIndex }) => {
  const editCtx = useContext(BacklogEditContext);
  const isPbi = item.type === 'PBI';

  return (
    <div className={styles.itemWrapper}>
      <Collapsible
        className={isPbi ? styles.itemPbi : styles.itemTbi}
        header={
          <div className={styles.itemHeader}>
            <span className={`${styles.itemTypeBadge} ${isPbi ? styles.typePbi : styles.typeTbi}`}>
              {item.type}
            </span>
            <span className={styles.itemId}>{item.id}</span>
            {item.adoWorkItemUrl ? (
              <a
                href={item.adoWorkItemUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={`${styles.itemTitle} ${styles.adoLink}`}
                onClick={(e) => e.stopPropagation()}
                title={`View ADO #${item.adoWorkItemId}`}
              >
                {item.title}
              </a>
            ) : (
              <span className={styles.itemTitle}>{item.title}</span>
            )}
            <PriorityBadge priority={item.priority} />
            <AdoMergedBadge adoWorkItemId={item.adoWorkItemId} />
            {item.dependsOn && item.dependsOn.length > 0 && (
              <span className={styles.dependsOn}>
                depends on: {item.dependsOn.join(', ')}
              </span>
            )}
          </div>
        }
      >
        <div className={styles.itemBody}>
          {isPbi && item.userStory && (
            <div className={styles.userStory}>
              <div className={styles.subsectionLabel}>User Story</div>
              <div className={styles.userStoryText}>
                {item.userStory.persona && (
                  <span><strong>As</strong> {item.userStory.persona}, </span>
                )}
                {item.userStory.iWant && (
                  <span><strong>I want to</strong> {item.userStory.iWant}, </span>
                )}
                {item.userStory.soThat && (
                  <span><strong>so that</strong> {item.userStory.soThat}.</span>
                )}
              </div>
            </div>
          )}

          {!isPbi && item.description && (
            <div className={styles.itemSection}>
              <div className={styles.subsectionLabel}>Description</div>
              <p className={styles.descText}>{item.description}</p>
            </div>
          )}

          {isPbi && item.businessRules && item.businessRules.length > 0 && (
            <div className={styles.itemSection}>
              <div className={styles.subsectionLabel}>Business Rules</div>
              <ul className={styles.bulletList}>
                {item.businessRules.map((br, i) => <li key={i}>{br}</li>)}
              </ul>
            </div>
          )}

          {isPbi && item.nonFunctionalRequirements && (
            <div className={styles.itemSection}>
              <div className={styles.subsectionLabel}>Non-Functional Requirements</div>
              <NfrSection nfr={item.nonFunctionalRequirements} />
            </div>
          )}

          {!isPbi && item.technicalDependencies && item.technicalDependencies.length > 0 && (
            <div className={styles.itemSection}>
              <div className={styles.subsectionLabel}>Technical Dependencies</div>
              <ul className={styles.bulletList}>
                {item.technicalDependencies.map((d, i) => <li key={i}>{d}</li>)}
              </ul>
            </div>
          )}

          {!isPbi && item.nonFunctionalRequirements && (
            <div className={styles.itemSection}>
              <div className={styles.subsectionLabel}>Non-Functional Requirements</div>
              <NfrSection nfr={item.nonFunctionalRequirements} />
            </div>
          )}

          {!isPbi && item.definitionOfDone && item.definitionOfDone.length > 0 && (
            <div className={styles.itemSection}>
              <div className={styles.subsectionLabel}>Definition of Done</div>
              <ul className={styles.dodList}>
                {item.definitionOfDone.map((d, i) => (
                  <li key={i}>
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="3 8 6.5 11.5 13 5" />
                    </svg>
                    {d}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {isPbi && item.outOfScope && item.outOfScope.length > 0 && (
            <div className={styles.itemSection}>
              <div className={styles.subsectionLabel}>Out of Scope</div>
              <ul className={styles.bulletList}>
                {item.outOfScope.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}

          {isPbi && item.acceptanceCriteria && item.acceptanceCriteria.length > 0 && (
            <div className={styles.itemSection}>
              <div className={styles.subsectionLabel}>Acceptance Criteria</div>
              <div className={styles.acList}>
                {item.acceptanceCriteria.map((ac, i) => (
                  <AcCard key={i} ac={ac} index={i} />
                ))}
              </div>
            </div>
          )}
        </div>
      </Collapsible>
      {editCtx?.editable && (
        <button
          type="button"
          className={styles.cardEditBtn}
          aria-label="Edit item"
          onClick={(e) => {
            e.stopPropagation();
            editCtx.onEditItem(epicIndex, featureIndex, itemIndex);
          }}
        >
          <PencilIcon />
        </button>
      )}
    </div>
  );
};

/* ── Feature card ─────────────────────────────────────────────────────────── */

const FeatureCard: React.FC<{
  feature: Feature;
  index: number;
  epicIndex: number;
}> = ({ feature, index, epicIndex }) => {
  const editCtx = useContext(BacklogEditContext);
  const pbis = feature.items?.filter((i) => i.type === 'PBI') ?? [];
  const tbis = feature.items?.filter((i) => i.type === 'TBI') ?? [];

  return (
    <div className={styles.featureWrapper}>
      <Collapsible
        className={styles.featureCard}
        defaultOpen={index === 0}
        header={
          <div className={styles.featureHeader}>
            <span className={styles.featureLabel}>Feature</span>
            {feature.adoWorkItemUrl ? (
              <a
                href={feature.adoWorkItemUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={`${styles.featureTitle} ${styles.adoLink}`}
                onClick={(e) => e.stopPropagation()}
                title={`View ADO #${feature.adoWorkItemId}`}
              >
                {feature.title}
              </a>
            ) : (
              <span className={styles.featureTitle}>{feature.title}</span>
            )}
            <PriorityBadge priority={feature.priority} />
            <AdoMergedBadge adoWorkItemId={feature.adoWorkItemId} />
            {feature.featureFlag && (
              <span className={styles.featureFlag}>{feature.featureFlag.name}</span>
            )}
            <span className={styles.featureCounts}>
              {tbis.length > 0 && <span className={styles.countTbi}>{tbis.length} TBI{tbis.length !== 1 ? 's' : ''}</span>}
              {pbis.length > 0 && <span className={styles.countPbi}>{pbis.length} PBI{pbis.length !== 1 ? 's' : ''}</span>}
            </span>
          </div>
        }
      >
        <div className={styles.featureBody}>
          {feature.description && (
            <p className={styles.featureDesc}>{feature.description}</p>
          )}

          {feature.affectedPersonas && feature.affectedPersonas.length > 0 && (
            <div className={styles.personaTags}>
              {feature.affectedPersonas.map((p) => (
                <span key={p} className={styles.personaTag}>{p}</span>
              ))}
            </div>
          )}

          {feature.outOfScope && feature.outOfScope.length > 0 && (
            <div className={styles.featureMeta}>
              <span className={styles.metaLabel}>Out of Scope:</span>
              {feature.outOfScope.join(' · ')}
            </div>
          )}

          {feature.items && feature.items.length > 0 && (
            <div className={styles.itemsList}>
              {feature.items.map((item, ii) => (
                <ItemCard key={item.id} item={item} epicIndex={epicIndex} featureIndex={index} itemIndex={ii} />
              ))}
            </div>
          )}
        </div>
      </Collapsible>
      {editCtx?.editable && (
        <button
          type="button"
          className={styles.cardEditBtn}
          aria-label="Edit feature"
          onClick={(e) => {
            e.stopPropagation();
            editCtx.onEditFeature(epicIndex, index);
          }}
        >
          <PencilIcon />
        </button>
      )}
    </div>
  );
};

/* ── Epic card ────────────────────────────────────────────────────────────── */

const EpicCard: React.FC<{ epic: Epic; index: number }> = ({ epic, index }) => {
  const editCtx = useContext(BacklogEditContext);
  const totalFeatures = epic.features?.length ?? 0;
  const totalPbis = epic.features?.flatMap((f) => f.items ?? []).filter((i) => i.type === 'PBI').length ?? 0;
  const totalTbis = epic.features?.flatMap((f) => f.items ?? []).filter((i) => i.type === 'TBI').length ?? 0;

  return (
    <div className={styles.epicWrapper}>
      <Collapsible
        className={styles.epicCard}
        defaultOpen={index === 0}
        header={
          <div className={styles.epicHeader}>
            <span className={styles.epicIndex}>Epic {index + 1}</span>
            {epic.adoWorkItemUrl ? (
              <a
                href={epic.adoWorkItemUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={`${styles.epicTitle} ${styles.adoLink}`}
                onClick={(e) => e.stopPropagation()}
                title={`View ADO #${epic.adoWorkItemId}`}
              >
                {epic.title}
              </a>
            ) : (
              <span className={styles.epicTitle}>{epic.title}</span>
            )}
            <PriorityBadge priority={epic.priority} />
            <AdoMergedBadge adoWorkItemId={epic.adoWorkItemId} />
            <span className={styles.epicCounts}>
              <span>{totalFeatures} feature{totalFeatures !== 1 ? 's' : ''}</span>
              {totalTbis > 0 && <span className={styles.countTbi}>{totalTbis} TBI{totalTbis !== 1 ? 's' : ''}</span>}
              {totalPbis > 0 && <span className={styles.countPbi}>{totalPbis} PBI{totalPbis !== 1 ? 's' : ''}</span>}
            </span>
          </div>
        }
      >
        <div className={styles.epicBody}>
          {epic.description && (
            <p className={styles.epicDesc}>{epic.description}</p>
          )}

          {epic.successMetrics && epic.successMetrics.length > 0 && (
            <div className={styles.epicMeta}>
              <div className={styles.metaHeader}>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="1 10 5 6 9 9 15 3" />
                </svg>
                Success Metrics
              </div>
              <ul className={styles.bulletList}>
                {epic.successMetrics.map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            </div>
          )}

          {epic.assumptions && epic.assumptions.length > 0 && (
            <div className={styles.epicMeta}>
              <div className={styles.metaHeader}>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="8" cy="8" r="6" />
                  <line x1="8" y1="5" x2="8" y2="8" />
                  <circle cx="8" cy="11" r="0.5" fill="currentColor" />
                </svg>
                Assumptions
              </div>
              <ul className={styles.bulletList}>
                {epic.assumptions.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            </div>
          )}

          {epic.outOfScope && epic.outOfScope.length > 0 && (
            <div className={styles.epicMeta}>
              <div className={styles.metaHeader}>Out of Scope</div>
              <ul className={styles.bulletList}>
                {epic.outOfScope.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}

          {epic.features && epic.features.length > 0 && (
            <div className={styles.featuresList}>
              {epic.features.map((feature, fi) => (
                <FeatureCard key={fi} feature={feature} index={fi} epicIndex={index} />
              ))}
            </div>
          )}
        </div>
      </Collapsible>
      {editCtx?.editable && (
        <button
          type="button"
          className={styles.cardEditBtn}
          aria-label="Edit epic"
          onClick={(e) => {
            e.stopPropagation();
            editCtx.onEditEpic(index);
          }}
        >
          <PencilIcon />
        </button>
      )}
    </div>
  );
};

/* ── Edit form modal ──────────────────────────────────────────────────────── */

interface EditFormProps {
  target: NonNullable<EditTarget>;
  backlog: BacklogData;
  onSave: (updated: { title: string; description: string; priority: string }) => void;
  onCancel: () => void;
}

const EditForm: React.FC<EditFormProps> = ({ target, backlog, onSave, onCancel }) => {
  const initial = (() => {
    if (target.type === 'epic') {
      const e = backlog.epics?.[target.epicIndex];
      return { title: e?.title ?? '', description: e?.description ?? '', priority: e?.priority ?? '' };
    }
    if (target.type === 'feature') {
      const f = backlog.epics?.[target.epicIndex]?.features?.[target.featureIndex];
      return { title: f?.title ?? '', description: f?.description ?? '', priority: f?.priority ?? '' };
    }
    // item
    const i = backlog.epics?.[target.epicIndex]?.features?.[target.featureIndex]?.items?.[target.itemIndex];
    return { title: i?.title ?? '', description: i?.description ?? '', priority: i?.priority ?? '' };
  })();

  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [priority, setPriority] = useState(initial.priority);

  const entityLabel =
    target.type === 'epic' ? 'Epic' : target.type === 'feature' ? 'Feature' : 'Item';

  return (
    <div
      className={styles.editFormModal}
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${entityLabel.toLowerCase()}`}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className={styles.editFormCard}>
        <h3 className={styles.editFormTitle}>Edit {entityLabel}</h3>

        <div className={styles.editFormField}>
          <label htmlFor="backlog-edit-title" className={styles.editFormLabel}>Title</label>
          <input
            id="backlog-edit-title"
            type="text"
            className={styles.editFormInput}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        <div className={styles.editFormField}>
          <label htmlFor="backlog-edit-description" className={styles.editFormLabel}>Description</label>
          <textarea
            id="backlog-edit-description"
            className={styles.editFormTextarea}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
          />
        </div>

        {priority !== '' && (
          <div className={styles.editFormField}>
            <label htmlFor="backlog-edit-priority" className={styles.editFormLabel}>Priority</label>
            <input
              id="backlog-edit-priority"
              type="text"
              className={styles.editFormInput}
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
            />
          </div>
        )}

        <div className={styles.editFormActions}>
          <button
            type="button"
            className={styles.editFormBtnPrimary}
            onClick={() => onSave({ title, description, priority })}
          >
            Save
          </button>
          <button
            type="button"
            className={styles.editFormBtnSecondary}
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

/* ── Root viewer ──────────────────────────────────────────────────────────── */

interface BacklogViewerProps {
  data: unknown;
  editable?: boolean;
  onSaveBacklog?: (updatedData: unknown) => void;
}

export const BacklogViewer: React.FC<BacklogViewerProps> = ({ data, editable = false, onSaveBacklog }) => {
  const [editTarget, setEditTarget] = useState<EditTarget>(null);

  const editContextValue: BacklogEditContextValue = {
    editable,
    onEditEpic: (epicIndex) => setEditTarget({ type: 'epic', epicIndex }),
    onEditFeature: (epicIndex, featureIndex) => setEditTarget({ type: 'feature', epicIndex, featureIndex }),
    onEditItem: (epicIndex, featureIndex, itemIndex) => setEditTarget({ type: 'item', epicIndex, featureIndex, itemIndex }),
  };

  const handleSave = (updated: { title: string; description: string; priority: string }) => {
    if (!isBacklogData(data) || !editTarget) return;

    const newBacklog: BacklogData = JSON.parse(JSON.stringify(data)) as BacklogData;

    if (editTarget.type === 'epic' && newBacklog.epics) {
      const epic = newBacklog.epics[editTarget.epicIndex];
      if (epic) {
        epic.title = updated.title;
        epic.description = updated.description || undefined;
        if (updated.priority) epic.priority = updated.priority;
      }
    } else if (editTarget.type === 'feature' && newBacklog.epics) {
      const feature = newBacklog.epics[editTarget.epicIndex]?.features?.[editTarget.featureIndex];
      if (feature) {
        feature.title = updated.title;
        feature.description = updated.description || undefined;
        if (updated.priority) feature.priority = updated.priority;
      }
    } else if (editTarget.type === 'item' && newBacklog.epics) {
      const item = newBacklog.epics[editTarget.epicIndex]?.features?.[editTarget.featureIndex]?.items?.[editTarget.itemIndex];
      if (item) {
        item.title = updated.title;
        item.description = updated.description || undefined;
        if (updated.priority) item.priority = updated.priority;
      }
    }

    onSaveBacklog?.(newBacklog);
    setEditTarget(null);
  };

  if (!isBacklogData(data)) {
    return <div className={styles.empty}>Invalid backlog data format.</div>;
  }

  const totalEpics = data.epics?.length ?? 0;
  const totalFeatures = data.epics?.flatMap((e) => e.features ?? []).length ?? 0;
  const allItems = data.epics?.flatMap((e) => e.features ?? []).flatMap((f) => f.items ?? []) ?? [];
  const totalPbis = allItems.filter((i) => i.type === 'PBI').length;
  const totalTbis = allItems.filter((i) => i.type === 'TBI').length;

  return (
    <BacklogEditContext.Provider value={editContextValue}>
      <div className={styles.root}>
        {/* Summary bar */}
        <div className={styles.summaryBar}>
          <div className={styles.summaryItem}>
            <span className={styles.summaryCount}>{totalEpics}</span>
            <span className={styles.summaryLabel}>Epic{totalEpics !== 1 ? 's' : ''}</span>
          </div>
          <div className={styles.summaryDivider} />
          <div className={styles.summaryItem}>
            <span className={styles.summaryCount}>{totalFeatures}</span>
            <span className={styles.summaryLabel}>Feature{totalFeatures !== 1 ? 's' : ''}</span>
          </div>
          <div className={styles.summaryDivider} />
          <div className={`${styles.summaryItem} ${styles.summaryTbi}`}>
            <span className={styles.summaryCount}>{totalTbis}</span>
            <span className={styles.summaryLabel}>TBI{totalTbis !== 1 ? 's' : ''}</span>
          </div>
          <div className={styles.summaryDivider} />
          <div className={`${styles.summaryItem} ${styles.summaryPbi}`}>
            <span className={styles.summaryCount}>{totalPbis}</span>
            <span className={styles.summaryLabel}>PBI{totalPbis !== 1 ? 's' : ''}</span>
          </div>
          {data.personas && data.personas.length > 0 && (
            <>
              <div className={styles.summaryDivider} />
              <div className={styles.summaryPersonas}>
                {data.personas.map((p) => (
                  <span key={p.name} className={styles.personaTag} title={p.description}>
                    {p.name}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Epics */}
        {data.epics && data.epics.length > 0 && (
          <section className={styles.section}>
            <div className={styles.sectionHeading}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="2" y="3" width="12" height="10" rx="2" />
                <line x1="5" y1="7" x2="11" y2="7" />
                <line x1="5" y1="10" x2="8" y2="10" />
              </svg>
              Epics & Features
            </div>
            <div className={styles.epicsList}>
              {data.epics.map((epic, i) => (
                <EpicCard key={i} epic={epic} index={i} />
              ))}
            </div>
          </section>
        )}

        {/* Business rules */}
        {data.businessRules && data.businessRules.length > 0 && (
          <section className={styles.section}>
            <div className={styles.sectionHeading}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 2L2 5v4c0 3 2.7 5.3 6 6 3.3-.7 6-3 6-6V5L8 2z" />
              </svg>
              Business Rules
            </div>
            <div className={styles.brTable}>
              {data.businessRules.map((br) => (
                <div key={br.id} className={styles.brRow}>
                  <span className={styles.brId}>{br.id}</span>
                  <span className={styles.brRule}>{br.rule}</span>
                  {br.appliesTo && <span className={styles.brApplies}>{br.appliesTo}</span>}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Assumptions */}
        {data.assumptionsMade && data.assumptionsMade.length > 0 && (
          <section className={styles.section}>
            <div className={styles.sectionHeading}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="8" cy="8" r="6" />
                <line x1="8" y1="5" x2="8" y2="8" />
                <circle cx="8" cy="11" r="0.5" fill="currentColor" />
              </svg>
              Assumptions Made
            </div>
            <ul className={styles.assumptionsList}>
              {data.assumptionsMade.map((a, i) => (
                <li key={i} className={styles.assumptionItem}>
                  <span className={styles.assumptionBullet}>{i + 1}</span>
                  {a}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {/* Edit form modal rendered at root level */}
      {editTarget && isBacklogData(data) && (
        <EditForm
          target={editTarget}
          backlog={data}
          onSave={handleSave}
          onCancel={() => setEditTarget(null)}
        />
      )}
    </BacklogEditContext.Provider>
  );
};

export default BacklogViewer;
