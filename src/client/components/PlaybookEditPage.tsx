import React from 'react';
import { Link, Navigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useAppShell } from '../hooks/useAppShell';
import { usePlaybookDefinition } from '../hooks/usePlaybookDefinitions';
import { PlaybookDraftEditor } from './PlaybookDraftEditor';
import { PlaybookVersionList } from './PlaybookVersionList';
import styles from './PlaybookEditPage.module.css';

interface PlaybookEditPageProps {
  project: string;
  definitionId: string;
}

export const PlaybookEditPage: React.FC<PlaybookEditPageProps> = ({
  project,
  definitionId,
}) => {
  const { can } = useAppShell();
  const canAuthor = can('playbooks:author');
  const detail = usePlaybookDefinition(project, definitionId);

  if (!canAuthor) return <Navigate to={`/playbooks/${definitionId}`} replace />;
  if (detail.isPending) return <p className={styles.loading}>Loading Playbook editor…</p>;
  if (detail.isError || !detail.data) {
    return <p className={styles.error} role="alert">This Playbook could not be loaded.</p>;
  }

  const data = detail.data;
  return (
    <main className={styles.page} data-testid="playbook-edit-page">
      <Link className={styles.back} to={`/playbooks/${definitionId}`} data-testid="playbook-edit-back">
        <ArrowLeft size={14} aria-hidden /> Back to dashboard
      </Link>
      <header className={styles.header}>
        <h1>Edit {data.definition.name}</h1>
        <p>Manage the draft and immutable published versions. The builder remains the main graph editor.</p>
        <Link
          className={styles.builderLink}
          to={`/playbooks/definitions/${definitionId}`}
          data-testid="playbook-edit-open-builder"
        >
          Open graph builder
        </Link>
      </header>

      <section className={styles.section} aria-labelledby="playbook-edit-details">
        <h2 id="playbook-edit-details">Details</h2>
        <PlaybookDraftEditor
          project={project}
          detail={data}
          canAuthor
          reload={detail.refetch}
          advancedGraph
        />
      </section>

      <section className={styles.section} aria-labelledby="playbook-edit-versions">
        <h2 id="playbook-edit-versions">Versions</h2>
        <PlaybookVersionList
          project={project}
          definitionId={definitionId}
          versions={data.versions}
          currentPublishedVersionId={data.currentPublishedVersionId}
          canAuthor
        />
      </section>

    </main>
  );
};

export default PlaybookEditPage;
