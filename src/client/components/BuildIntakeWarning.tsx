import React from 'react';
import { sensitiveClassLabel, type SensitiveClass } from '../../shared/utils/buildIntakeMarkers';
import styles from './BuildIntakeWarning.module.css';

export const BUILD_INTAKE_WARNING_LABEL = 'Sensitive data warning';

const LABEL_LINE_RE = /^\s*[*_]*\s*sensitive data warning\s*[*_]*\s*:?\s*(?:\r?\n|$)/i;

/** The callout shows the label, so drop the agent's own label line. */
export function stripWarningLabelLine(text: string): string {
  return text.replace(LABEL_LINE_RE, '');
}

interface BuildIntakeWarningProps {
  classes: SensitiveClass[];
}

export const BuildIntakeWarning: React.FC<BuildIntakeWarningProps> = ({ classes }) => {
  if (classes.length === 0) return null;
  return (
    <div className={styles.warning} role="note" {...{ 'data-testid': 'build-intake-warning' }}>
      <svg className={styles.icon} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
      </svg>
      <div className={styles.body}>
        <strong className={styles.label}>{BUILD_INTAKE_WARNING_LABEL}</strong>
        <span className={styles.detail}>
          Your message looks like it holds: {classes.map(sensitiveClassLabel).join(', ')}.
          Remove it before you approve the brief. If it is not sensitive, you can keep it.
        </span>
      </div>
    </div>
  );
};
