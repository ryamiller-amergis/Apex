import { useQueryClient } from '@tanstack/react-query';
import { ErrorState, LoadingState } from '@project-scope/ui';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../../api/ApiError';
import type { Profile } from '@project-scope/contracts';
import { profileKeys } from './profileKeys';
import { profileTestIds } from './profileTestIds';
import { useProfileQuery } from './useProfileQuery';

export interface ProfileQueryBoundaryProps {
  children: (profile: Profile) => ReactNode;
}

function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiError && error.isUnauthenticated;
}

/**
 * Loading, then data, then a retryable error. A 401 wins over cached data:
 * the session flag turns the query off, then the effect drops the cache so a
 * signed-out screen cannot keep the previous profile.
 */
export const ProfileQueryBoundary: React.FC<ProfileQueryBoundaryProps> = ({
  children,
}) => {
  const queryClient = useQueryClient();
  const [sessionEnded, setSessionEnded] = useState(false);
  const query = useProfileQuery(!sessionEnded);
  const unauthenticated = isUnauthenticated(query.error);

  if (!sessionEnded && unauthenticated) {
    setSessionEnded(true);
  }

  useEffect(() => {
    if (sessionEnded) {
      queryClient.removeQueries({ queryKey: profileKeys.me });
    }
  }, [sessionEnded, queryClient]);

  if (sessionEnded || unauthenticated) {
    return (
      <Box
        role="alert"
        data-testid={profileTestIds.unauthenticated}
        sx={{ py: 3 }}
      >
        <Typography variant="body1">Sign in to view your profile</Typography>
      </Box>
    );
  }

  if (query.data) {
    return children(query.data);
  }

  if (query.isError) {
    return (
      <ErrorState
        testId={profileTestIds.error}
        retryTestId={profileTestIds.retry}
        title="We couldn't load your profile"
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  return (
    <LoadingState
      testId={profileTestIds.loading}
      label="Loading your profile…"
    />
  );
};
