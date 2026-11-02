import React from 'react';
import styles from './BrainstormArtifactPlaceholder.module.css';

interface BrainstormArtifactPlaceholderProps {
  loading?: boolean;
}

export const BrainstormArtifactPlaceholder: React.FC<BrainstormArtifactPlaceholderProps> = ({ loading = false }) => (
  <aside
    className={loading ? `${styles.placeholder} ${styles.pulse}` : styles.placeholder}
    aria-label="Artifact"
    aria-busy={loading || undefined}
    {...{ 'data-testid': 'brainstorm-artifact-placeholder' }}
  >
    {!loading && <p className={styles.text}>No artifact yet — ask the collaborator to draft one</p>}
  </aside>
);
