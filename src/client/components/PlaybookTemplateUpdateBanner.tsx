import React, { useState } from 'react';
import type { PlaybookDefinitionDetail } from '../../shared/types/playbook';
import { useApplyPlaybookTemplate, usePlaybookTemplate } from '../hooks/usePlaybookTemplates';
import styles from './PlaybookTemplateUpdateBanner.module.css';

interface PlaybookTemplateUpdateBannerProps {
  project: string;
  detail: PlaybookDefinitionDetail;
  'data-testid'?: string;
}

export const PlaybookTemplateUpdateBanner: React.FC<PlaybookTemplateUpdateBannerProps> = ({
  project,
  detail,
  'data-testid': testId = 'playbook-template-update',
}) => {
  const templateKey = detail.definition.templateKey;
  const template = usePlaybookTemplate(project, templateKey, Boolean(templateKey));
  const apply = useApplyPlaybookTemplate(project, detail.definition.id);
  const [compare, setCompare] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  if (!templateKey || !template.data || template.data.installState !== 'update-available') return null;

  const shipped = template.data;
  return (
    <section className={styles.banner} role="status" data-testid={testId}>
      <h2>Template update</h2>
      <p>
        {shipped.displayName} version {shipped.templateVersion} is available.
        This copy is on version {detail.definition.templateVersion}. Applying it replaces the draft graph.
        Published versions stay as they are.
      </p>
      <button type="button" onClick={() => setCompare((open) => !open)} data-testid="playbook-template-compare">
        {compare ? 'Hide comparison' : 'Compare'}
      </button>
      {compare ? (
        <div className={styles.compare}>
          <p>Shipped steps: {shipped.stepSummary.join(' → ')}</p>
          <p>Draft steps: {detail.draft.graph.nodes.map((node) => node.stepType).join(' → ') || 'None'}</p>
          <pre data-testid="playbook-template-shipped-graph">{JSON.stringify(shipped.graph, null, 2)}</pre>
        </div>
      ) : null}
      <label className={styles.confirm}>
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          data-testid="playbook-template-confirm"
        />
        Replace the draft with template version {shipped.templateVersion}
      </label>
      <button
        type="button"
        disabled={!confirmed || apply.isPending}
        data-testid="playbook-template-apply"
        onClick={() => {
          void apply.mutateAsync({
            templateKey,
            templateVersion: shipped.templateVersion,
            expectedDraftUpdatedAt: detail.draft.updatedAt,
            confirmed: true,
          });
        }}
      >
        {apply.isPending ? 'Applying…' : 'Apply to draft'}
      </button>
      {apply.isError ? <p role="alert">{apply.error.message}</p> : null}
    </section>
  );
};
