import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DiagramSummary } from '../../shared/types/diagram';
import { useAppShell } from '../hooks/useAppShell';
import {
  useDeleteDiagram,
  useOwnedDiagrams,
  useSharedDiagrams,
} from '../hooks/useDiagrams';
import { DiagramCardGrid } from './DiagramCardGrid';
import { DeleteDiagramDialog } from './DeleteDiagramDialog';
import { ShareDiagramDialog } from './ShareDiagramDialog';
import {
  DiagramSectionTabs,
  type DiagramBrowseSection,
} from './DiagramSectionTabs';
import styles from './DiagramsView.module.css';

interface DiagramsViewProps {
  projectId: string;
}

/**
 * Diagrams browse surface — owned/shared thumbnail grids with owner-only delete.
 */
export const DiagramsView: React.FC<DiagramsViewProps> = ({ projectId }) => {
  const navigate = useNavigate();
  const { can } = useAppShell();
  const canCreate = can('diagram:create');
  const canDelete = can('diagram:delete');
  const canShare = can('diagram:share');

  const [activeTab, setActiveTab] = useState<DiagramBrowseSection>('owned');
  const [ownedOffset, setOwnedOffset] = useState(0);
  const [sharedOffset, setSharedOffset] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<DiagramSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pendingShare, setPendingShare] = useState<DiagramSummary | null>(null);

  const ownedQuery = useOwnedDiagrams(projectId, ownedOffset);
  const sharedQuery = useSharedDiagrams(projectId, sharedOffset);
  const deleteMutation = useDeleteDiagram(projectId);

  const handleTabChange = (tab: DiagramBrowseSection) => {
    setActiveTab(tab);
  };

  const handleOpen = (id: string) => {
    navigate(`/diagrams/${id}`);
  };

  const handleDeleteRequest = (diagram: DiagramSummary) => {
    setDeleteError(null);
    setPendingDelete(diagram);
  };

  const handleShareRequest = (diagram: DiagramSummary) => {
    setPendingShare(diagram);
  };

  const handleDeleteConfirm = () => {
    if (!pendingDelete) return;
    setDeleteError(null);
    deleteMutation.mutate(pendingDelete.id, {
      onSuccess: () => {
        setPendingDelete(null);
        setDeleteError(null);
        setOwnedOffset(0);
        setSharedOffset(0);
      },
      onError: (err) => {
        setDeleteError(err.message || 'Failed to delete Diagram');
      },
    });
  };

  const handleDeleteCancel = () => {
    if (deleteMutation.isPending) return;
    setPendingDelete(null);
    setDeleteError(null);
  };

  return (
    <div className={styles.page} {...{ 'data-testid': 'diagrams-browse-view' }}>
      <header className={styles.header} {...{ 'data-testid': 'diagrams-header' }}>
        <div>
          <h1 className={styles.title}>Diagrams</h1>
          <p className={styles.subtitle}>
            Browse Diagrams you own or that were shared with you.
          </p>
        </div>
        {canCreate && (
          <button
            type="button"
            className={styles.newBtn}
            onClick={() => navigate('/diagrams/new')}
            {...{ 'data-testid': 'diagram-new-button' }}
          >
            New Diagram
          </button>
        )}
      </header>

      {!canCreate && (
        <p className={styles.hint} {...{ 'data-testid': 'diagrams-create-forbidden' }}>
          You can view Diagrams in this project, but creating new Diagrams requires
          {' '}
          <code>diagram:create</code>
          .
        </p>
      )}

      <DiagramSectionTabs
        activeTab={activeTab}
        onChange={handleTabChange}
        {...{ 'data-testid': 'diagrams-section-tabs' }}
      />

      <div
        role="tabpanel"
        id="diagrams-panel-owned"
        aria-labelledby="diagrams-tab-owned"
        hidden={activeTab !== 'owned'}
        {...{ 'data-testid': 'diagrams-owned-panel' }}
      >
        <DiagramCardGrid
          query={ownedQuery}
          offset={ownedOffset}
          onLoadMore={setOwnedOffset}
          emptyMessage="No Diagrams yet — create one"
          canDelete={canDelete}
          canShare={canShare}
          onOpen={handleOpen}
          onDelete={handleDeleteRequest}
          onShare={handleShareRequest}
        />
      </div>

      <div
        role="tabpanel"
        id="diagrams-panel-shared"
        aria-labelledby="diagrams-tab-shared"
        hidden={activeTab !== 'shared'}
        {...{ 'data-testid': 'diagrams-shared-panel' }}
      >
        <DiagramCardGrid
          query={sharedQuery}
          offset={sharedOffset}
          onLoadMore={setSharedOffset}
          emptyMessage="Nothing shared with you yet"
          canDelete={canDelete}
          canShare={canShare}
          onOpen={handleOpen}
          onDelete={handleDeleteRequest}
          onShare={handleShareRequest}
        />
      </div>

      {pendingDelete && (
        <DeleteDiagramDialog
          title={pendingDelete.title}
          isPending={deleteMutation.isPending}
          error={deleteError}
          onConfirm={handleDeleteConfirm}
          onCancel={handleDeleteCancel}
          {...{ 'data-testid': 'diagram-delete-dialog' }}
        />
      )}

      {pendingShare && (
        <ShareDiagramDialog
          projectId={projectId}
          diagramId={pendingShare.id}
          diagramTitle={pendingShare.title}
          onClose={() => setPendingShare(null)}
          {...{ 'data-testid': 'share-diagram-dialog' }}
        />
      )}
    </div>
  );
};

export default DiagramsView;
