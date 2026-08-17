import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  ApexRelease,
  ApexReleaseStatus,
  ApexWorkItem,
} from '../../shared/types/apexWorkItem';
import { STATUS_META } from '../../shared/types/apexWorkItem';
import styles from './BoardReleaseRoadmap.module.css';

interface BoardReleaseRoadmapProps {
  project: string;
}

const RELEASE_BADGE_CLASS: Record<ApexReleaseStatus, string> = {
  planned: styles.badgePlanned,
  active: styles.badgeActive,
  shipped: styles.badgeShipped,
  cancelled: styles.badgeCancelled,
};

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json() as Promise<T>;
}

function formatTargetDate(iso: string | null | undefined): string {
  if (!iso) return 'No target date';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'No target date';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

interface ReleaseGroup {
  release: ApexRelease | null;
  items: ApexWorkItem[];
}

export const BoardReleaseRoadmap: React.FC<BoardReleaseRoadmapProps> = ({ project }) => {
  const enc = encodeURIComponent(project);

  const {
    data: releases = [],
    isLoading: releasesLoading,
    error: releasesError,
  } = useQuery<ApexRelease[]>({
    queryKey: ['apex-work-items', project, 'releases'],
    queryFn: () => fetchJson(`/api/apex-work-items/releases?project=${enc}`),
    enabled: !!project,
    staleTime: 30_000,
  });

  const {
    data: items = [],
    isLoading: itemsLoading,
    error: itemsError,
  } = useQuery<ApexWorkItem[]>({
    queryKey: ['apex-work-items', project, 'list', { project }],
    queryFn: () => fetchJson(`/api/apex-work-items?project=${enc}`),
    enabled: !!project,
    staleTime: 15_000,
  });

  const groups = useMemo((): ReleaseGroup[] => {
    const byRelease = new Map<string, ApexWorkItem[]>();
    const unassigned: ApexWorkItem[] = [];

    for (const item of items) {
      if (item.releaseId) {
        const list = byRelease.get(item.releaseId) ?? [];
        list.push(item);
        byRelease.set(item.releaseId, list);
      } else {
        unassigned.push(item);
      }
    }

    const sortedReleases = [...releases].sort((a, b) => a.position - b.position);
    const releaseGroups: ReleaseGroup[] = sortedReleases.map((release) => ({
      release,
      items: (byRelease.get(release.id) ?? []).sort((a, b) => a.position - b.position),
    }));

    if (unassigned.length > 0) {
      releaseGroups.push({
        release: null,
        items: unassigned.sort((a, b) => a.position - b.position),
      });
    }

    return releaseGroups;
  }, [releases, items]);

  if (releasesLoading || itemsLoading) {
    return (
      <div className={styles.root} data-testid="board-release-roadmap">
        <p className={styles.loading}>Loading roadmap…</p>
      </div>
    );
  }

  const error = releasesError || itemsError;
  if (error) {
    return (
      <div className={styles.root} data-testid="board-release-roadmap">
        <p className={styles.error} role="alert">
          {(error as Error).message || 'Failed to load roadmap'}
        </p>
      </div>
    );
  }

  if (releases.length === 0) {
    return (
      <div className={styles.root} data-testid="board-release-roadmap">
        <header>
          <h2 className={styles.heading}>Release roadmap</h2>
          <p className={styles.subtitle}>{project}</p>
        </header>
        <div className={styles.empty}>
          <h3 className={styles.emptyTitle}>No releases yet</h3>
          <p className={styles.emptyBody}>
            Create a release on the Work Board to start organizing items on the roadmap.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root} data-testid="board-release-roadmap">
      <header>
        <h2 className={styles.heading}>Release roadmap</h2>
        <p className={styles.subtitle}>{project} · grouped by release</p>
      </header>

      <ul className={styles.list}>
        {groups.map((group) => {
          const isUnassigned = group.release === null;
          const release = group.release;
          const itemCount = release?.itemCount ?? group.items.length;
          const doneCount =
            release?.doneCount ?? group.items.filter((i) => i.status === 'done').length;
          const pct = itemCount > 0 ? Math.round((doneCount / itemCount) * 100) : 0;
          const headingId = isUnassigned
            ? 'board-roadmap-no-release'
            : `board-roadmap-release-${release!.id}`;

          return (
            <li key={isUnassigned ? 'no-release' : release!.id} className={styles.releaseRow}>
              <div className={styles.releaseHeader}>
                <div className={styles.releaseTitleBlock}>
                  <h3 id={headingId} className={styles.releaseName}>
                    {isUnassigned
                      ? 'No release'
                      : `${release!.name}${release!.version ? ` · ${release!.version}` : ''}`}
                  </h3>
                  <p className={styles.releaseMeta}>
                    {isUnassigned
                      ? `${group.items.length} item${group.items.length === 1 ? '' : 's'} not assigned to a release`
                      : formatTargetDate(release!.targetDate)}
                  </p>
                </div>

                {!isUnassigned && (
                  <>
                    <span
                      className={`${styles.badge} ${RELEASE_BADGE_CLASS[release!.status]}`}
                    >
                      {release!.status}
                    </span>
                    <div className={styles.progressBlock}>
                      <div className={styles.progressLabel}>
                        <span>
                          {doneCount}/{itemCount} done
                        </span>
                        <span>{pct}%</span>
                      </div>
                      <div
                        className={styles.progressTrack}
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={pct}
                        aria-label={`${release!.name} progress`}
                      >
                        <div
                          className={styles.progressFill}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  </>
                )}
              </div>

              {group.items.length === 0 ? (
                <p className={styles.noItems}>No work items in this release.</p>
              ) : (
                <ul className={styles.itemList} aria-labelledby={headingId}>
                  {group.items.map((item) => (
                    <li key={item.id} className={styles.itemCard}>
                      <span className={styles.itemTitle}>{item.title}</span>
                      <span className={styles.itemChip}>{item.type}</span>
                      <span className={styles.itemChip}>
                        {STATUS_META[item.status]?.label ?? item.status}
                      </span>
                      <span className={styles.itemOwner}>
                        {item.owner.displayName || 'Unassigned'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default BoardReleaseRoadmap;
