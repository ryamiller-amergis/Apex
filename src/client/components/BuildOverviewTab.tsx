import React from 'react';
import { BUILD_REQUIREMENT_KINDS } from '../../shared/types/build';
import type { BuildBriefView, BuildRequirementView } from '../../shared/types/buildView';
import { requirementGroupLabel } from './BuildRequirementList';
import { BuildRiskDecisions } from './BuildRiskDecisions';
import styles from './BuildRunView.module.css';

function requirementNumber(id: string): number {
  const match = /-(\d+)$/.exec(id);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

interface RequirementGroupsProps {
  requirements: BuildRequirementView[];
}

/** Retired rows stay in the list with the word "Retired" (BR-013). */
const RequirementGroups: React.FC<RequirementGroupsProps> = ({ requirements }) => {
  if (requirements.length === 0) return <p className={styles.empty}>No requirements recorded.</p>;
  return (
    <>
      {BUILD_REQUIREMENT_KINDS.map((kind) => {
        const rows = requirements
          .filter((row) => row.kind === kind)
          .sort((left, right) => requirementNumber(left.id) - requirementNumber(right.id));
        if (rows.length === 0) return null;
        return (
          <section key={kind} className={styles.section} aria-label={requirementGroupLabel(kind)}>
            <h4>{requirementGroupLabel(kind)}</h4>
            <ul className={styles.list}>
              {rows.map((row) => (
                <li
                  key={row.id}
                  className={`${styles.requirement} ${row.retired ? styles.retired : ''}`}
                  {...{ 'data-testid': 'build-overview-requirement' }}
                >
                  <span className={styles.requirementId}>{row.id}</span>
                  <span>{row.text}</span>
                  {row.retired && (
                    <span className={styles.retiredLabel} {...{ 'data-testid': 'build-overview-requirement-retired' }}>
                      Retired
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
};

interface TextListProps {
  items: string[];
  empty: string;
  testId: string;
}

const TextList: React.FC<TextListProps> = ({ items, empty, testId }) => {
  if (items.length === 0) return <p className={styles.empty} {...{ 'data-testid': testId }}>{empty}</p>;
  return (
    <ul className={styles.list} {...{ 'data-testid': testId }}>
      {items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}
    </ul>
  );
};

interface BuildOverviewTabProps {
  brief: BuildBriefView | null;
  onRetry: () => void;
}

export const BuildOverviewTab: React.FC<BuildOverviewTabProps> = ({ brief, onRetry }) => {
  if (!brief || brief.status === 'unavailable') {
    return (
      <div className={styles.message} role="alert" {...{ 'data-testid': 'build-overview-error' }}>
        <p>Could not load the brief.</p>
        <button type="button" className={styles.button} onClick={onRetry} {...{ 'data-testid': 'build-overview-retry' }}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <>
      <section className={styles.section}>
        <h3>Overview</h3>
        <p className={brief.overview ? undefined : styles.empty} {...{ 'data-testid': 'build-overview-summary' }}>
          {brief.overview ?? 'Overview not available.'}
        </p>
      </section>
      <section className={styles.section} {...{ 'data-testid': 'build-overview-requirements' }}>
        <h3>Requirements</h3>
        <RequirementGroups requirements={brief.requirements} />
      </section>
      <section className={styles.section}>
        <h3>Assumptions</h3>
        <TextList items={brief.assumptions} empty="No assumptions recorded." testId="build-overview-assumptions" />
      </section>
      <section className={styles.section}>
        <h3>Exclusions</h3>
        <TextList items={brief.exclusions} empty="No exclusions recorded." testId="build-overview-exclusions" />
      </section>
      <div {...{ 'data-testid': 'build-overview-risk-decisions' }}>
        <BuildRiskDecisions decisions={brief.riskDecisions} isLoading={false} isError={false} onRetry={onRetry} />
      </div>
    </>
  );
};
