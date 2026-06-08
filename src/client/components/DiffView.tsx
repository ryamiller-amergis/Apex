import React, { useMemo } from 'react';
import { computeUnifiedDiff } from '../utils/diff';
import type { DiffLine } from '../utils/diff';
import styles from './DiffView.module.css';

export const DiffView: React.FC<{
  oldText: string;
  newText: string;
  changesOnly?: boolean;
}> = ({ oldText, newText, changesOnly }) => {
  const lines = useMemo(() => {
    const all = computeUnifiedDiff(oldText, newText);
    return changesOnly ? all.filter((l: DiffLine) => l.type === 'added' || l.type === 'removed') : all;
  }, [oldText, newText, changesOnly]);

  if (lines.length === 0) {
    return (
      <div className={styles.diffNoChanges}>
        <svg className={styles.diffNoChangesIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
        No changes in this section
      </div>
    );
  }

  return (
    <table className={styles.diffTable}>
      <tbody>
        {lines.map((line, idx) => (
          <tr
            key={idx}
            className={
              line.type === 'added' ? styles.diffLineAdded :
              line.type === 'removed' ? styles.diffLineRemoved :
              styles.diffLineContext
            }
          >
            <td className={styles.diffLineNum}>
              {line.lineNum ?? ''}
            </td>
            <td className={styles.diffLineContent}>
              <span className={`${styles.diffPrefix} ${
                line.type === 'added' ? styles.diffPrefixAdd :
                line.type === 'removed' ? styles.diffPrefixRemove : ''
              }`}>
                {line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '}
              </span>
              {line.spans ? (
                line.spans.map((span, si) => (
                  <span
                    key={si}
                    className={
                      span.type === 'removed' ? styles.wordRemoved :
                      span.type === 'added' ? styles.wordAdded : ''
                    }
                  >
                    {span.text}
                  </span>
                ))
              ) : (
                line.text
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

export default DiffView;
