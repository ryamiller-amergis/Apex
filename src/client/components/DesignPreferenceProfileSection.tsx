import React, { useEffect, useState } from 'react';
import type { DesignPreferenceProfile } from '../../shared/types/designPreferenceProfile';
import {
  useDecideDesignPreferenceProposal,
  useDesignPreferenceProfile,
  useSaveDesignPreferenceProfile,
} from '../hooks/useDesignPreferenceProfile';
import styles from './BuildProfileSection.module.css';

interface DesignPreferenceProfileSectionProps {
  settingsId: string;
  project: string;
}

export const DesignPreferenceProfileSection: React.FC<DesignPreferenceProfileSectionProps> = ({
  settingsId,
}) => {
  const query = useDesignPreferenceProfile(settingsId);
  const saveMutation = useSaveDesignPreferenceProfile();
  const decideMutation = useDecideDesignPreferenceProposal();
  const [draft, setDraft] = useState<DesignPreferenceProfile | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- copy the saved profile into the local draft
    if (query.data?.profile.profile) setDraft(query.data.profile.profile);
  }, [query.data?.profile.profile]);

  if (query.isLoading || !draft) {
    return <p>Loading design preferences…</p>;
  }

  const proposals = query.data?.proposals ?? [];

  return (
    <div className={styles.section}>
      <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
        Approved preferences guide Build visual quality. Agents may propose updates; only you can accept them.
      </p>
      <label htmlFor="ps-design-app-name">App name</label>
      <input
        id="ps-design-app-name"
        className={styles.input}
        value={draft.appName ?? ''}
        onChange={(e) => setDraft({ ...draft, appName: e.target.value || null })}
        {...{ 'data-testid': 'ps-design-app-name' }}
      />
      <label htmlFor="ps-design-tone">Visual tone</label>
      <select
        id="ps-design-tone"
        className={styles.input}
        value={draft.visualTone ?? 'professional'}
        onChange={(e) =>
          setDraft({
            ...draft,
            visualTone: e.target.value as DesignPreferenceProfile['visualTone'],
          })
        }
        {...{ 'data-testid': 'ps-design-tone' }}
      >
        <option value="professional">Professional</option>
        <option value="modern">Modern</option>
        <option value="compact">Compact</option>
      </select>
      {message && <p role="status">{message}</p>}
      <button
        type="button"
        className={styles.btnPrimary}
        disabled={saveMutation.isPending}
        {...{ 'data-testid': 'ps-design-save-preferences' }}
        onClick={() => {
          setMessage(null);
          saveMutation.mutate(
            { settingsId, profile: draft },
            {
              onSuccess: () => setMessage('Design preferences saved.'),
              onError: () => setMessage('Could not save design preferences.'),
            },
          );
        }}
      >
        {saveMutation.isPending ? 'Saving…' : 'Save preferences'}
      </button>

      {proposals.length > 0 && (
        <div className={styles.group}>
          <h4 className={styles.legend}>Pending proposals</h4>
          <ul>
            {proposals.map((proposal) => (
              <li key={proposal.id} style={{ marginBottom: 12 }}>
                <div>{proposal.feedbackExcerpt ?? proposal.source}</div>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  disabled={decideMutation.isPending}
                  {...{ 'data-testid': `ps-design-proposal-accept-${proposal.id}` }}
                  onClick={() => {
                    decideMutation.mutate({ settingsId, proposalId: proposal.id, action: 'accept' });
                  }}
                >
                  Accept
                </button>{' '}
                <button
                  type="button"
                  className={styles.btnSecondary}
                  disabled={decideMutation.isPending}
                  {...{ 'data-testid': `ps-design-proposal-reject-${proposal.id}` }}
                  onClick={() => {
                    decideMutation.mutate({ settingsId, proposalId: proposal.id, action: 'reject' });
                  }}
                >
                  Reject
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
