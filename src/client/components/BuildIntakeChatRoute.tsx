import React from 'react';
import { useBuildIntake } from '../hooks/useBuilds';
import { ExistingInterviewView } from './InterviewChatView';
import { ViewSkeleton } from './ViewSkeleton';
import styles from './BuildIntakeChatRoute.module.css';

interface BuildIntakeChatRouteProps {
  buildId: string;
}

export const BuildIntakeChatRoute: React.FC<BuildIntakeChatRouteProps> = ({ buildId }) => {
  const { data: intake, isLoading, isError, refetch } = useBuildIntake(buildId);

  let content: React.ReactNode;
  if (isLoading) {
    content = <ViewSkeleton />;
  } else if (isError) {
    content = (
      <div className={styles.message} role="alert" {...{ 'data-testid': 'build-intake-error' }}>
        <p>We could not open this conversation.</p>
        <button
          type="button"
          className={styles.retry}
          onClick={() => { void refetch(); }}
          {...{ 'data-testid': 'build-intake-retry' }}
        >
          Try again
        </button>
      </div>
    );
  } else if (!intake?.interviewId) {
    content = (
      <div className={styles.message} role="status" {...{ 'data-testid': 'build-intake-not-started' }}>
        <p>Your build has not started its conversation yet.</p>
      </div>
    );
  } else {
    content = <ExistingInterviewView id={intake.interviewId} />;
  }

  return (
    <div className={styles.root} {...{ 'data-testid': 'build-intake-chat' }}>
      {content}
    </div>
  );
};
