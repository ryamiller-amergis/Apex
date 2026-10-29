import React from 'react';
import { useBuildEvents } from '../hooks/useBuilds';
import { absoluteTime } from './playbookStatusFormat';
import styles from './BuildRunView.module.css';

interface BuildTimelineTabProps {
  project: string;
  buildId: string;
}

/** Mounted only while the Timeline tab is open, so events load only then. */
export const BuildTimelineTab: React.FC<BuildTimelineTabProps> = ({ project, buildId }) => {
  const { data, isLoading, isError, refetch } = useBuildEvents(project, buildId, { enabled: true });

  if (isLoading) return <p className={styles.empty}>Loading timeline…</p>;

  if (isError && !data) {
    return (
      <div className={styles.message} role="alert" {...{ 'data-testid': 'build-timeline-error' }}>
        <p>Could not load the timeline.</p>
        <button
          type="button"
          className={styles.button}
          onClick={() => { void refetch(); }}
          {...{ 'data-testid': 'build-timeline-retry' }}
        >
          Try again
        </button>
      </div>
    );
  }

  if (!data || data.events.length === 0) {
    return <p className={styles.empty} {...{ 'data-testid': 'build-timeline-empty' }}>Nothing has happened yet.</p>;
  }

  return (
    <>
      {data.total > data.events.length && (
        <p className={styles.empty} {...{ 'data-testid': 'build-timeline-total' }}>
          {`Showing the latest ${data.events.length} of ${data.total}`}
        </p>
      )}
      <ol className={styles.list} {...{ 'data-testid': 'build-timeline-list' }}>
        {data.events.map((event) => (
          <li key={event.id} className={styles.event} {...{ 'data-testid': 'build-timeline-event' }}>
            <time dateTime={event.occurredAt}>{absoluteTime(event.occurredAt)}</time>
            <span>{event.message}</span>
          </li>
        ))}
      </ol>
    </>
  );
};
