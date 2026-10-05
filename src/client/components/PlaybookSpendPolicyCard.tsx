import React, { useState } from 'react';
import { useAppShell } from '../hooks/useAppShell';
import { useFeatureFlag } from '../hooks/useFeatureFlags';
import {
  usePlaybookSpendPolicy,
  useUpdatePlaybookSpendPolicy,
} from '../hooks/usePlaybookSpendPolicy';

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--border-color)',
  borderRadius: 8,
  padding: 20,
  marginBottom: 20,
  background: 'var(--surface-primary)',
};

const fieldStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  marginTop: 12,
  maxWidth: 520,
};

const PlaybookSpendPolicyCardEnabled: React.FC<{ project: string }> = ({
  project,
}) => {
  const { can } = useAppShell();
  const canAdmin = can('playbooks:admin');
  const query = usePlaybookSpendPolicy(project);
  const update = useUpdatePlaybookSpendPolicy(project);
  const [capUsd, setCapUsd] = useState('');
  const [reason, setReason] = useState('');
  const [clientError, setClientError] = useState<string | null>(null);

  if (query.isLoading) {
    return (
      <section style={cardStyle} data-testid="playbook-spend-policy-card">
        Loading spend policy…
      </section>
    );
  }
  if (query.isError) {
    return (
      <section style={cardStyle} data-testid="playbook-spend-policy-card">
        <p role="alert">Could not load the Playbook spend policy.</p>
        <button
          type="button"
          data-testid="playbook-spend-policy-retry"
          onClick={() => query.refetch()}
        >
          Retry
        </button>
      </section>
    );
  }

  const policy = query.data;
  const submit = async (request: { enabled?: boolean; capUsd?: string }) => {
    const trimmedReason = reason.trim();
    if (trimmedReason.length < 10 || trimmedReason.length > 500) {
      setClientError('Enter a reason between 10 and 500 characters.');
      return;
    }
    setClientError(null);
    await update.mutateAsync({ ...request, reason: trimmedReason });
    setReason('');
    setCapUsd('');
  };

  const status = !policy
    ? 'Policy not enabled'
    : !policy.enabled
      ? 'Policy disabled'
      : policy.startsBlocked
        ? 'New starts blocked'
        : policy.warningActive
          ? '75% warning active'
          : 'Enabled';

  return (
    <section
      style={cardStyle}
      data-testid="playbook-spend-policy-card"
      aria-labelledby="playbook-spend-title"
    >
      <h2 id="playbook-spend-title">Playbook spend policy</h2>
      <p data-testid="playbook-spend-policy-status">{status}</p>
      {policy && (
        <p>
          Trailing 30 days: ${policy.currentSpendUsd} · Baseline: $
          {policy.baselineCostUsd} · Cap: ${policy.capUsd}
        </p>
      )}
      {canAdmin && (
        <>
          {policy && (
            <label style={fieldStyle}>
              New cap (USD)
              <input
                data-testid="playbook-spend-cap-input"
                inputMode="decimal"
                value={capUsd}
                onChange={(event) => setCapUsd(event.target.value)}
                aria-describedby={
                  clientError ? 'playbook-spend-form-error' : undefined
                }
              />
            </label>
          )}
          <label style={fieldStyle}>
            Reason
            <textarea
              data-testid="playbook-spend-override-reason"
              value={reason}
              minLength={10}
              maxLength={500}
              required
              onChange={(event) => setReason(event.target.value)}
              aria-describedby={
                clientError ? 'playbook-spend-form-error' : undefined
              }
            />
          </label>
          {(clientError || update.error) && (
            <p id="playbook-spend-form-error" role="alert">
              {clientError ?? update.error?.message}
            </p>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            {!policy ? (
              <button
                type="button"
                data-testid="playbook-spend-policy-enable"
                disabled={update.isPending}
                onClick={() => void submit({ enabled: true })}
              >
                Enable policy
              </button>
            ) : (
              <>
                <button
                  type="button"
                  data-testid="playbook-spend-override-submit"
                  disabled={update.isPending || !capUsd}
                  onClick={() => void submit({ capUsd })}
                >
                  Raise cap
                </button>
                <button
                  type="button"
                  data-testid="playbook-spend-policy-toggle"
                  disabled={update.isPending}
                  onClick={() => void submit({ enabled: !policy.enabled })}
                >
                  {policy.enabled ? 'Disable policy' : 'Enable policy'}
                </button>
              </>
            )}
          </div>
          {update.isSuccess && (
            <p role="status">Playbook spend policy saved.</p>
          )}
        </>
      )}
    </section>
  );
};

export const PlaybookSpendPolicyCard: React.FC<{
  project: string;
  'data-testid'?: string;
}> = ({ project }) => {
  const enabled = useFeatureFlag('playbooks-production-adapters', project);

  // @feature-flag:playbooks-production-adapters start winner=enabled
  if (!enabled) {
    // @feature-flag:playbooks-production-adapters disabled-start
    return null;
    // @feature-flag:playbooks-production-adapters disabled-end
  }
  // @feature-flag:playbooks-production-adapters enabled-start
  return <PlaybookSpendPolicyCardEnabled project={project} />;
  // @feature-flag:playbooks-production-adapters enabled-end
  // @feature-flag:playbooks-production-adapters end
};
