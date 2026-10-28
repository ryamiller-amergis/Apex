import React from 'react';
import { BUILD_REQUIREMENT_KINDS, type BuildRequirement, type BuildRequirementKind } from '../../shared/types/build';
import styles from './BuildRequirementList.module.css';

export function requirementGroupLabel(kind: BuildRequirementKind): string {
  switch (kind) {
    case 'ac':
      return 'Acceptance criteria';
    case 'dod':
      return 'Definitions of done';
    case 'br':
      return 'Business rules';
    case 'nfr':
      return 'Non-functional requirements';
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
}

export function requirementRowLabel(kind: BuildRequirementKind): string {
  switch (kind) {
    case 'ac':
      return 'Acceptance criterion';
    case 'dod':
      return 'Definition of done';
    case 'br':
      return 'Business rule';
    case 'nfr':
      return 'Non-functional requirement';
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
}

interface BuildRequirementListProps {
  requirements: BuildRequirement[];
}

export const BuildRequirementList: React.FC<BuildRequirementListProps> = ({ requirements }) => {
  const live = requirements.filter((row) => !row.retired);
  if (live.length === 0) return <p className={styles.empty}>No requirements recorded.</p>;

  return (
    <div className={styles.groups}>
      {BUILD_REQUIREMENT_KINDS.map((kind) => {
        const rows = live.filter((row) => row.kind === kind);
        if (rows.length === 0) return null;
        return (
          <section key={kind} className={styles.group}>
            <h3 className={styles.heading}>{requirementGroupLabel(kind)}</h3>
            <ul className={styles.list}>
              {rows.map((row) => (
                <li key={row.id} className={styles.row} {...{ 'data-testid': `build-requirement-row-${row.id}` }}>
                  <span className={styles.id}>{row.id}</span>
                  <span>{row.text}</span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
};
