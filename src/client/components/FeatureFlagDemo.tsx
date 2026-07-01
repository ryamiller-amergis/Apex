import React from 'react';
import { useFeatureFlag } from '../hooks/useFeatureFlags';

interface FeatureFlagDemoProps {
  project: string;
}

/**
 * Top-level split pattern demonstration.
 * This component is gated behind the "example-flag-demo" feature flag.
 * When the flag is disabled (or absent), nothing renders.
 */
export const FeatureFlagDemo: React.FC<FeatureFlagDemoProps> = ({ project }) => {
  const isEnabled = useFeatureFlag('example-flag-demo', project);

  if (!isEnabled) return null;

  return (
    <div
      style={{
        padding: '12px',
        background: 'var(--bg-secondary)',
        borderRadius: '8px',
        margin: '8px 0',
      }}
    >
      <strong>Feature Flag Demo</strong>
      <p style={{ color: 'var(--text-secondary)', margin: '4px 0 0' }}>
        This component is gated behind the &quot;example-flag-demo&quot; feature flag.
      </p>
    </div>
  );
};
