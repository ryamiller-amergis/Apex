/**
 * Platform admins share a published Playbook as a template from here. The copy is a snapshot of the
 * latest published version, so later edits to this Playbook never reach it. After sharing, the panel
 * lists the project-specific settings that were left out.
 */
import React, { useState } from 'react';
import { CheckCircle2, LayoutTemplate } from 'lucide-react';
import { useSharePlaybookAsTemplate } from '../hooks/usePlaybookTemplates';
import styles from './PlaybookShareTemplatePanel.module.css';

interface PlaybookShareTemplatePanelProps {
  project: string;
  definitionId: string;
  defaultName: string;
  defaultSummary: string;
  versionNumber: number | null;
  onClose: () => void;
}

export const PlaybookShareTemplatePanel: React.FC<PlaybookShareTemplatePanelProps> = ({
  project,
  definitionId,
  defaultName,
  defaultSummary,
  versionNumber,
  onClose,
}) => {
  const share = useSharePlaybookAsTemplate(project, definitionId);
  const [name, setName] = useState(defaultName);
  const [summary, setSummary] = useState(defaultSummary);

  if (share.isSuccess) {
    return (
      <section className={styles.panel} role="status" data-testid="playbook-share-template-done">
        <h2 className={styles.title}>
          <CheckCircle2 size={16} aria-hidden /> Shared as a template
        </h2>
        <p className={styles.text}>
          Other projects can now find “{share.data.template.displayName}” under Templates. It is a
          copy; changing this Playbook does not change it.
        </p>
        {share.data.notes.length > 0 ? (
          <>
            <p className={styles.text}>Left out of the copy because they belong to this project:</p>
            <ul className={styles.notes} data-testid="playbook-share-template-notes">
              {share.data.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </>
        ) : null}
        <div className={styles.actions}>
          <button type="button" className={styles.primary} onClick={onClose} data-testid="playbook-share-template-done">
            Done
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.panel} aria-labelledby="playbook-share-template-title" data-testid="playbook-share-template">
      <h2 id="playbook-share-template-title" className={styles.title}>
        <LayoutTemplate size={16} aria-hidden /> Share as a template
      </h2>
      <p className={styles.text}>
        Copies {versionNumber ? `the live version (v${versionNumber})` : 'the live version'} so any project can
        start from it. Project skills, named people, and saved agent settings are left out.
      </p>
      <label className={styles.field}>
        <span>Template name</span>
        <input
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
          data-testid="playbook-share-template-name"
        />
      </label>
      <label className={styles.field}>
        <span>What it is for</span>
        <textarea
          value={summary}
          rows={3}
          maxLength={500}
          onChange={(event) => setSummary(event.target.value)}
          data-testid="playbook-share-template-summary"
        />
      </label>
      {share.isError ? <p role="alert" className={styles.error}>{share.error.message}</p> : null}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primary}
          disabled={share.isPending || !name.trim()}
          onClick={() => share.mutate({ name: name.trim(), summary: summary.trim() })}
          data-testid="playbook-share-template-submit"
        >
          {share.isPending ? 'Sharing…' : 'Share template'}
        </button>
        <button type="button" className={styles.quiet} disabled={share.isPending} onClick={onClose} data-testid="playbook-share-template-cancel">
          Cancel
        </button>
      </div>
    </section>
  );
};
