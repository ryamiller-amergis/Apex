import React from 'react';
import styles from './BrainstormReadOnlyBanner.module.css';

export const BrainstormReadOnlyBanner: React.FC = () => (
  <div className={styles.banner} role="status" {...{ 'data-testid': 'brainstorm-readonly-banner' }}>
    You can read this session. Only its creator can reply.
  </div>
);
