import React from 'react';
import type { QaLabTestCase, QaLabTestCaseStep } from '../../shared/types/qaLab';
import styles from './QaLabCaseDiff.module.css';

export interface FieldChange {
  label: string;
  before: string;
  after: string;
}

export type StepChange =
  | { kind: 'same'; step: QaLabTestCaseStep }
  | { kind: 'added'; step: QaLabTestCaseStep }
  | { kind: 'removed'; step: QaLabTestCaseStep }
  | { kind: 'changed'; before: QaLabTestCaseStep; after: QaLabTestCaseStep };

function placementOf(testCase: QaLabTestCase): string {
  return [testCase.proposedTestPlan, testCase.proposedTestSuite].filter(Boolean).join(' > ');
}

function stepKey(step: QaLabTestCaseStep): string {
  return `${step.action.trim()}\n${step.expected.trim()}`;
}

export function diffCaseFields(before: QaLabTestCase, after: QaLabTestCase): FieldChange[] {
  const fields: Array<[string, (testCase: QaLabTestCase) => string]> = [
    ['Title', (testCase) => testCase.title],
    ['User type', (testCase) => testCase.persona ?? ''],
    ['Preconditions', (testCase) => testCase.preconditions.join('\n')],
    ['Placement', placementOf],
    ['Expected result', (testCase) => testCase.expectedResult ?? ''],
  ];
  return fields
    .map(([label, read]) => ({ label, before: read(before), after: read(after) }))
    .filter((change) => change.before.trim() !== change.after.trim());
}

/** Lines steps up by their text, then pairs a removal with the addition right after it as one edit. */
export function diffCaseSteps(before: QaLabTestCaseStep[], after: QaLabTestCaseStep[]): StepChange[] {
  const a = before.map(stepKey);
  const b = after.map(stepKey);
  const lengths = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const raw: StepChange[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      raw.push({ kind: 'same', step: after[j] });
      i += 1;
      j += 1;
    } else if (j < b.length && (i === a.length || lengths[i][j + 1] > lengths[i + 1][j])) {
      raw.push({ kind: 'added', step: after[j] });
      j += 1;
    } else {
      raw.push({ kind: 'removed', step: before[i] });
      i += 1;
    }
  }

  const changes: StepChange[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const current = raw[index];
    const next = raw[index + 1];
    if (current.kind === 'removed' && next?.kind === 'added') {
      changes.push({ kind: 'changed', before: current.step, after: next.step });
      index += 1;
    } else {
      changes.push(current);
    }
  }
  return changes;
}

const STEP_MARK: Record<StepChange['kind'], string> = {
  same: '',
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
};

function StepText({ step }: { step: QaLabTestCaseStep }) {
  return (
    <>
      <span>{step.action}</span>
      {step.expected && <span className={styles.expected}>Expected: {step.expected}</span>}
    </>
  );
}

function renderStep(change: StepChange) {
  switch (change.kind) {
    case 'same':
    case 'added':
    case 'removed':
      return <StepText step={change.step} />;
    case 'changed':
      return (
        <>
          <div className={styles.before}><StepText step={change.before} /></div>
          <div className={styles.after}><StepText step={change.after} /></div>
        </>
      );
    default: {
      const unhandled: never = change;
      return unhandled;
    }
  }
}

interface QaLabCaseDiffProps {
  localCaseId: string;
  before: QaLabTestCase;
  after: QaLabTestCase;
}

/** What a comment-driven rewrite changed in one case. */
export const QaLabCaseDiff: React.FC<QaLabCaseDiffProps> = ({ localCaseId, before, after }) => {
  const fields = diffCaseFields(before, after);
  const steps = diffCaseSteps(before.steps, after.steps);
  const stepEdits = steps.filter((change) => change.kind !== 'same').length;

  if (fields.length === 0 && stepEdits === 0) {
    return <p className={styles.none}>The rewrite left this case unchanged.</p>;
  }

  return (
    <div className={styles.diff} {...{ 'data-testid': `qa-lab-case-diff-${localCaseId}` }}>
      {fields.map((change) => (
        <div key={change.label} className={styles.field}>
          <span className={styles.label}>{change.label}</span>
          <p className={styles.before}>{change.before || '(none)'}</p>
          <p className={styles.after}>{change.after || '(none)'}</p>
        </div>
      ))}
      {stepEdits > 0 && (
        <div className={styles.field}>
          <span className={styles.label}>Steps</span>
          <ol className={styles.steps}>
            {steps.map((change, index) => (
              <li key={index} className={styles[change.kind]} data-change={change.kind}>
                {STEP_MARK[change.kind] && <span className={styles.mark}>{STEP_MARK[change.kind]}</span>}
                {renderStep(change)}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
};
