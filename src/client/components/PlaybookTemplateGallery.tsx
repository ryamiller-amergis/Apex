import React from 'react';
import type { PlaybookTemplateSummary } from '../../shared/types/playbookTemplates';
import { useInstallPlaybookTemplate, usePlaybookTemplates } from '../hooks/usePlaybookTemplates';
import styles from './PlaybookTemplateGallery.module.css';

interface PlaybookTemplateGalleryProps {
  project: string;
  canAuthor: boolean;
  onInstalled: (definitionId: string) => void;
  onClose: () => void;
}

function stateLabel(state: PlaybookTemplateSummary['installState']): string {
  if (state === 'not-installed') return 'Not installed';
  if (state === 'draft-only') return 'Draft';
  if (state === 'published') return 'Published';
  return 'Update available';
}

export const PlaybookTemplateGallery: React.FC<PlaybookTemplateGalleryProps> = ({
  project,
  canAuthor,
  onInstalled,
  onClose,
}) => {
  const templates = usePlaybookTemplates(project, true);
  const install = useInstallPlaybookTemplate(project);

  return (
    <section className={styles.gallery} aria-labelledby="playbook-template-gallery-title" data-testid="playbook-template-gallery">
      <header className={styles.header}>
        <h2 id="playbook-template-gallery-title">Templates</h2>
        <button type="button" onClick={onClose} data-testid="playbook-template-gallery-close">Close</button>
      </header>
      {templates.isPending ? <p>Loading templates…</p> : null}
      {templates.isError ? <p role="alert">{templates.error.message}</p> : null}
      <ul className={styles.list}>
        {(templates.data?.templates ?? []).map((template) => (
          <li key={template.templateKey} className={styles.card} data-testid={`playbook-template-${template.templateKey}`}>
            <h3>{template.displayName}</h3>
            <p>{template.summary}</p>
            <p>Steps: {template.stepSummary.join(' → ') || 'None'}</p>
            <p>Tags: {template.tags.join(', ') || 'None'}</p>
            <p>Required flags: {template.requiredFlags.join(', ') || 'None'}</p>
            <p>Permissions: {template.requiredPermissions.join(', ')}</p>
            <p>Cost: {template.estimatedCostBand ?? 'Not estimated'}</p>
            <p data-testid={`playbook-template-state-${template.templateKey}`}>{stateLabel(template.installState)}</p>
            {canAuthor && (template.installState === 'not-installed' || template.installState === 'draft-only') ? (
              <button
                type="button"
                disabled={install.isPending}
                data-testid={`playbook-template-install-${template.templateKey}`}
                onClick={() => {
                  void install.mutateAsync(template.templateKey).then((detail) => {
                    onInstalled(detail.definition.id);
                  });
                }}
              >
                {template.installState === 'draft-only' ? 'Open draft' : 'Install'}
              </button>
            ) : null}
            {template.installState === 'update-available' ? (
              <p>Open the Playbook editor to review and apply this update.</p>
            ) : null}
          </li>
        ))}
      </ul>
      {install.isError ? <p role="alert">{install.error.message}</p> : null}
    </section>
  );
};
