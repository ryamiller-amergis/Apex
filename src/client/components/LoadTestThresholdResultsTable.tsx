import React from 'react';
import type { ThresholdResult } from '../../shared/types/loadTest';
import styles from './LoadTestThresholdResultsTable.module.css';

interface LoadTestThresholdResultsTableProps {
  results: ThresholdResult[] | null | undefined;
  overallResult?: 'passed' | 'failed' | null;
}

export const LoadTestThresholdResultsTable: React.FC<LoadTestThresholdResultsTableProps> = ({
  results,
  overallResult,
}) => {
  if (!results || results.length === 0) {
    return (
      <div className={styles.empty} data-testid="load-test-threshold-results">
        <p>No threshold results yet</p>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      {overallResult && (
        <p
          className={overallResult === 'passed' ? styles.overallPass : styles.overallFail}
          data-testid="load-test-run-overall-result"
        >
          Overall: {overallResult === 'passed' ? 'Pass' : 'Fail'}
        </p>
      )}
      <table className={styles.table} data-testid="load-test-threshold-results">
        <thead>
          <tr>
            <th scope="col">Metric</th>
            <th scope="col">Expression</th>
            <th scope="col">Observed</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {results.map((row, index) => {
            const noData = row.evaluated === false;
            return (
              <tr key={`${row.metric}-${row.expression}-${index}`}>
                <td>{row.metric}</td>
                <td>
                  <code className={styles.code}>{row.expression}</code>
                </td>
                <td>{row.observed != null ? String(row.observed) : '—'}</td>
                <td>
                  {noData ? (
                    <span className={styles.unknown} data-passed="unknown">
                      No data
                    </span>
                  ) : (
                    <span
                      className={row.passed ? styles.pass : styles.fail}
                      data-passed={row.passed ? 'true' : 'false'}
                    >
                      {row.passed ? 'Pass' : 'Fail'}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export default LoadTestThresholdResultsTable;
