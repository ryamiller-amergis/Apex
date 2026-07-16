import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppShell } from '../hooks/useAppShell';
import { useAdrs, useDeleteAdr } from '../hooks/useAdrs';
import type { AdrStatus, AdrSummary } from '../../shared/types/adr';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import styles from './InterviewsDashboard.module.css';

const FILTERS: Array<{ label: string; value?: AdrStatus }> = [
  { label: 'All' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Generating', value: 'generating' },
  { label: 'Proposed', value: 'proposed' },
  { label: 'Accepted', value: 'accepted' },
  { label: 'Superseded', value: 'superseded' },
];

function statusLabel(status: AdrStatus): string {
  return status.split('_').map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');
}

const AdrCard: React.FC<{
  adr: AdrSummary;
  canDelete: boolean;
  onDelete: (adr: AdrSummary) => void;
}> = ({ adr, canDelete, onDelete }) => {
  const navigate = useNavigate();
  return (
    <div className={styles.card} onClick={() => navigate(`/adr/${adr.id}`)}>
      <div className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>{adr.title}</h3>
        {canDelete && (
          <button
            className={styles.cardDeleteBtn}
            type="button"
            aria-label={`Delete ADR "${adr.title}"`}
            onClick={(event) => {
              event.stopPropagation();
              onDelete(adr);
            }}
          >
            ×
          </button>
        )}
      </div>
      <div className={styles.cardFooter}>
        <span className={`${styles.badge} ${adr.status === 'accepted' ? styles.badgeApproved : adr.status === 'generating' ? styles.badgeGenerating : styles.badgeDraft}`}>
          {statusLabel(adr.status)}
        </span>
        <div className={styles.cardFooterRight}>
          {adr.skillSettingsName && <span className={styles.repoBadge}>{adr.skillSettingsName}</span>}
          <span className={styles.cardDate}>{new Date(adr.updatedAt).toLocaleDateString()}</span>
        </div>
      </div>
    </div>
  );
};

export const AdrsDashboard: React.FC = () => {
  const [status, setStatus] = useState<AdrStatus | undefined>();
  const [search, setSearch] = useState('');
  const [pendingDelete, setPendingDelete] = useState<AdrSummary | null>(null);
  const { selectedProject, can } = useAppShell();
  const navigate = useNavigate();
  const { data: adrs = [], isLoading } = useAdrs({
    ...(status ? { status } : {}),
    ...(selectedProject ? { project: selectedProject } : {}),
  });
  const deleteAdr = useDeleteAdr();
  const filtered = useMemo(
    () => adrs.filter((adr) => adr.title.toLowerCase().includes(search.trim().toLowerCase())),
    [adrs, search],
  );

  return (
    <div className={styles.dashboard}>
      <div className={styles.header}>
        <h1 className={styles.heading}>Architecture Decision Records</h1>
        {can('adr:create') && (
          <button className={styles.startButton} onClick={() => navigate('/adr/new')} type="button">
            + Start New ADR
          </button>
        )}
      </div>
      <div className={styles.filtersRow}>
        <div className={styles.filters}>
          {FILTERS.map((filter) => (
            <button
              key={filter.label}
              className={`${styles.filterPill} ${status === filter.value ? styles.active : ''}`}
              onClick={() => setStatus(filter.value)}
              type="button"
            >
              {filter.label}
            </button>
          ))}
        </div>
        <input
          className={styles.searchInput}
          type="search"
          placeholder="Search ADRs…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {isLoading ? (
        <div className={styles.emptyState}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div className={styles.emptyState}>No ADRs found.</div>
      ) : (
        <div className={styles.grid}>
          {filtered.map((adr) => (
            <AdrCard key={adr.id} adr={adr} canDelete={can('adr:delete')} onDelete={setPendingDelete} />
          ))}
        </div>
      )}
      {pendingDelete && (
        <ConfirmDeleteModal
          title="Delete ADR"
          itemName={pendingDelete.title}
          description="Are you sure you want to permanently delete the ADR"
          isPending={deleteAdr.isPending}
          onConfirm={() => deleteAdr.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) })}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
};

export default AdrsDashboard;
