import React, { useState } from 'react';
import type { ProductBuildSummary } from '../../shared/types/productBuild';
import { productBuildStatusLabel } from '../../shared/types/productBuild';
import { BuildDetail } from './BuildDetail';
import styles from './ProductBuildSetup.module.css';

export interface BuildHistoryProps {
  history: ProductBuildSummary[];
}

function formatBuildDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export const BuildHistory: React.FC<BuildHistoryProps> = ({ history }) => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = history.find((item) => item.id === selectedId) ?? null;
  if (history.length === 0) return null;

  return (
    <section className={styles.history} {...{ 'data-testid': 'product-build-history' }}>
      <h2 className={styles.historyHeading}>Builds</h2>
      {history.map((item) => (
        <button
          key={item.id}
          type="button"
          className={styles.card}
          onClick={() => setSelectedId(item.id)}
          {...{ 'data-testid': `product-build-card-${item.id}` }}
        >
          <span className={styles.cardRequest}>{item.request || item.summary || 'Untitled build'}</span>
          <span className={styles.cardMeta}>
            {productBuildStatusLabel(item.status)}
            {' · '}
            {formatBuildDate(item.createdAt)}
          </span>
        </button>
      ))}
      {selected && (
        <BuildDetail summary={selected} onClose={() => setSelectedId(null)} />
      )}
    </section>
  );
};
