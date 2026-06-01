import React, { useState } from 'react';
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


/* ── Collapsible section ──────────────────────────────────────────────────── */

interface CollapsibleProps {
  header: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
}

const Collapsible: React.FC<CollapsibleProps> = ({ header, defaultOpen = false, children, className }) => {
  const [open, setOpen] = useState(defaultOpen);
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
      {open && <div className={styles.collapsibleBody}>{children}</div>}
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

const ItemCard: React.FC<{ item: BacklogItem }> = ({ item }) => {
  const isPbi = item.type === 'PBI';
  return (
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
        {/* PBI: User story */}
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

        {/* TBI: Description */}
        {!isPbi && item.description && (
          <div className={styles.itemSection}>
            <div className={styles.subsectionLabel}>Description</div>
            <p className={styles.descText}>{item.description}</p>
          </div>
        )}

        {/* PBI: Business rules */}
        {isPbi && item.businessRules && item.businessRules.length > 0 && (
          <div className={styles.itemSection}>
            <div className={styles.subsectionLabel}>Business Rules</div>
            <ul className={styles.bulletList}>
              {item.businessRules.map((br, i) => <li key={i}>{br}</li>)}
            </ul>
          </div>
        )}

        {/* PBI: NFRs */}
        {isPbi && item.nonFunctionalRequirements && (
          <div className={styles.itemSection}>
            <div className={styles.subsectionLabel}>Non-Functional Requirements</div>
            <NfrSection nfr={item.nonFunctionalRequirements} />
          </div>
        )}

        {/* TBI: Technical dependencies */}
        {!isPbi && item.technicalDependencies && item.technicalDependencies.length > 0 && (
          <div className={styles.itemSection}>
            <div className={styles.subsectionLabel}>Technical Dependencies</div>
            <ul className={styles.bulletList}>
              {item.technicalDependencies.map((d, i) => <li key={i}>{d}</li>)}
            </ul>
          </div>
        )}

        {/* TBI: NFRs */}
        {!isPbi && item.nonFunctionalRequirements && (
          <div className={styles.itemSection}>
            <div className={styles.subsectionLabel}>Non-Functional Requirements</div>
            <NfrSection nfr={item.nonFunctionalRequirements} />
          </div>
        )}

        {/* TBI: Definition of done */}
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

        {/* PBI: Out of scope */}
        {isPbi && item.outOfScope && item.outOfScope.length > 0 && (
          <div className={styles.itemSection}>
            <div className={styles.subsectionLabel}>Out of Scope</div>
            <ul className={styles.bulletList}>
              {item.outOfScope.map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          </div>
        )}

        {/* PBI: Acceptance criteria */}
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
  );
};

/* ── Feature card ─────────────────────────────────────────────────────────── */

const FeatureCard: React.FC<{ feature: Feature; index: number }> = ({ feature, index }) => {
  const pbis = feature.items?.filter((i) => i.type === 'PBI') ?? [];
  const tbis = feature.items?.filter((i) => i.type === 'TBI') ?? [];

  return (
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
            {feature.items.map((item) => (
              <ItemCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </div>
    </Collapsible>
  );
};

/* ── Epic card ────────────────────────────────────────────────────────────── */

const EpicCard: React.FC<{ epic: Epic; index: number }> = ({ epic, index }) => {
  const totalFeatures = epic.features?.length ?? 0;
  const totalPbis = epic.features?.flatMap((f) => f.items ?? []).filter((i) => i.type === 'PBI').length ?? 0;
  const totalTbis = epic.features?.flatMap((f) => f.items ?? []).filter((i) => i.type === 'TBI').length ?? 0;

  return (
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
              <FeatureCard key={fi} feature={feature} index={fi} />
            ))}
          </div>
        )}
      </div>
    </Collapsible>
  );
};

/* ── Root viewer ──────────────────────────────────────────────────────────── */

interface BacklogViewerProps {
  data: unknown;
}

export const BacklogViewer: React.FC<BacklogViewerProps> = ({ data }) => {
  if (!isBacklogData(data)) {
    return <div className={styles.empty}>Invalid backlog data format.</div>;
  }

  const totalEpics = data.epics?.length ?? 0;
  const totalFeatures = data.epics?.flatMap((e) => e.features ?? []).length ?? 0;
  const allItems = data.epics?.flatMap((e) => e.features ?? []).flatMap((f) => f.items ?? []) ?? [];
  const totalPbis = allItems.filter((i) => i.type === 'PBI').length;
  const totalTbis = allItems.filter((i) => i.type === 'TBI').length;

  return (
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
  );
};

export default BacklogViewer;
