import React from 'react';
import styles from './PdfAssemblyView.module.css';

export const PdfAssemblyView: React.FC = () => (
  <div className={styles.container} data-testid="pdf-assembly-view">
    <div className={styles.placeholder}>
      <h1 className={styles.heading}>PDF Tools</h1>
      <p className={styles.subheading}>PDF assembly workspace</p>
    </div>
  </div>
);

export default PdfAssemblyView;
