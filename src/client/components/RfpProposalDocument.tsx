import React from 'react';
import {
  RFP_COST_SOURCE_TYPE_LABELS,
  type RfpCostAmounts,
  type RfpCostLine,
  type RfpCostTotals,
  type RfpDecisionSummaryDraft,
  type RfpGeneratedDraft,
  type RfpProposalDraft,
} from '../../shared/types/rfpIntake';
import landing from './RfpIntakeLanding.module.css';
import styles from './RfpRequestWizard.module.css';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function formatCostRange(amounts: RfpCostAmounts | null): string {
  if (!amounts) return 'Price unavailable';
  if (amounts.low === amounts.high) return usd.format(amounts.expected);
  return `${usd.format(amounts.low)}–${usd.format(amounts.high)} (expected ${usd.format(amounts.expected)})`;
}

export const CostSource: React.FC<{ line: RfpCostLine }> = ({ line }) => {
  const retrieved = line.retrievedAt ? new Date(line.retrievedAt).toLocaleDateString() : null;
  return (
    <span className={styles.sourceMeta}>
      {line.sourceUrl ? (
        <a
          href={line.sourceUrl}
          target="_blank"
          rel="noreferrer noopener"
          {...{ 'data-testid': `rfp-cost-source-${line.id}` }}
        >
          {line.sourceTitle ?? RFP_COST_SOURCE_TYPE_LABELS[line.sourceType]}
        </a>
      ) : (
        RFP_COST_SOURCE_TYPE_LABELS[line.sourceType]
      )}
      {retrieved && ` · retrieved ${retrieved}`}
      {` · ${line.confidence} confidence`}
    </span>
  );
};

export const CostTotalsRows: React.FC<{ totals: RfpCostTotals }> = ({ totals }) => (
  <>
    <tr className={styles.totalRow} {...{ 'data-testid': 'rfp-proposal-one-time-total' }}>
      <td colSpan={2}>One-time total</td>
      <td>{formatCostRange(totals.oneTime)}</td>
    </tr>
    <tr className={styles.totalRow} {...{ 'data-testid': 'rfp-proposal-monthly-total' }}>
      <td colSpan={2}>Monthly total</td>
      <td>{formatCostRange(totals.monthly)}</td>
    </tr>
    <tr className={styles.totalRow} {...{ 'data-testid': 'rfp-proposal-annual-total' }}>
      <td colSpan={2}>Annual running cost</td>
      <td>{formatCostRange(totals.annual)}</td>
    </tr>
    {totals.unpricedLineCount > 0 && (
      <tr>
        <td colSpan={3} className={styles.unpriced}>
          {totals.unpricedLineCount === 1
            ? 'One cost still needs a price.'
            : `${totals.unpricedLineCount} costs still need a price.`}
        </td>
      </tr>
    )}
  </>
);

const TextSection: React.FC<{ title: string; text: string }> = ({ title, text }) =>
  text.trim() ? (
    <div className={styles.docSection}>
      <h4>{title}</h4>
      <p>{text}</p>
    </div>
  ) : null;

const ListSection: React.FC<{ title: string; items: string[] }> = ({ title, items }) =>
  items.length > 0 ? (
    <div className={styles.docSection}>
      <h4>{title}</h4>
      <ul className={styles.docList}>
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </div>
  ) : null;

const ProposalBody: React.FC<{ draft: RfpProposalDraft; productOwnerName: string | null }> = ({ draft, productOwnerName }) => {
  const { sections } = draft;
  return (
    <>
      <TextSection title="Executive summary" text={sections.executiveSummary} />
      <TextSection title="Recommended solution" text={sections.recommendedSolution} />
      <ListSection title="Scope" items={sections.scope} />
      {sections.deliveryPhases.length > 0 && (
        <div className={styles.docSection}>
          <h4>Delivery plan</h4>
          <ol className={styles.docList}>
            {sections.deliveryPhases.map((phase) => (
              <li key={phase.name}>
                <strong>{phase.name}</strong> ({phase.duration}){phase.outcomes.length > 0 && `: ${phase.outcomes.join('; ')}`}
              </li>
            ))}
          </ol>
        </div>
      )}
      <TextSection title="Timeline" text={sections.timeline} />
      <div className={styles.docSection}>
        <h4>Costs</h4>
        <table className={styles.costTable} {...{ 'data-testid': 'rfp-proposal-cost-table' }}>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Basis</th>
              <th scope="col">Cost</th>
            </tr>
          </thead>
          <tbody>
            {draft.costLines.map((line) => (
              <tr key={line.id} {...{ 'data-testid': `rfp-proposal-cost-${line.id}` }}>
                <td>
                  {line.label}
                  <CostSource line={line} />
                </td>
                <td>
                  {line.quantity.toLocaleString()} {line.unit}
                  {line.cadence === 'monthly' ? ' / month' : ''}
                </td>
                <td className={line.amounts ? undefined : styles.unpriced}>{formatCostRange(line.amounts)}</td>
              </tr>
            ))}
            <CostTotalsRows totals={draft.totals} />
          </tbody>
        </table>
      </div>
      <ListSection title="Assumptions" items={sections.assumptions} />
      <ListSection title="Not included" items={sections.exclusions} />
      {sections.risks.length > 0 && (
        <div className={styles.docSection}>
          <h4>Risks</h4>
          <ul className={styles.docList}>
            {sections.risks.map((risk) => (
              <li key={risk.risk}><strong>{risk.risk}</strong> — {risk.mitigation}</li>
            ))}
          </ul>
        </div>
      )}
      <TextSection title="Security and data" text={sections.securityAndData} />
      <TextSection title="Ownership" text={sections.ownership} />
      {productOwnerName && <TextSection title="Product owner" text={productOwnerName} />}
      <ListSection title="Next steps" items={sections.nextSteps} />
    </>
  );
};

const DecisionSummaryBody: React.FC<{ draft: RfpDecisionSummaryDraft }> = ({ draft }) => (
  <>
    <TextSection title="Decision" text={draft.summary} />
    <ListSection title="Why" items={draft.reasons} />
    <ListSection title="Alternatives" items={draft.alternatives} />
    <ListSection title="Next steps" items={draft.nextSteps} />
  </>
);

interface RfpProposalDocumentProps {
  document: RfpGeneratedDraft;
  productOwnerName?: string | null;
}

export const RfpProposalDocument: React.FC<RfpProposalDocumentProps> = ({ document, productOwnerName = null }) => (
  <section
    className={landing.block}
    {...{ 'data-testid': document.kind === 'proposal' ? 'rfp-proposal-document' : 'rfp-decision-summary' }}
  >
    <h3 className={landing.blockTitle}>{document.kind === 'proposal' ? 'Product proposal' : 'Decision summary'}</h3>
    {document.kind === 'proposal'
      ? <ProposalBody draft={document} productOwnerName={productOwnerName} />
      : <DecisionSummaryBody draft={document} />}
  </section>
);
