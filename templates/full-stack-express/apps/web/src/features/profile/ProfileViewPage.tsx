import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router';
import { ProfileDetails } from './ProfileDetails';
import { ProfileQueryBoundary } from './ProfileQueryBoundary';
import { profileTestIds } from './profileTestIds';
import { useDocumentTitle } from './useDocumentTitle';

interface ProfileLocationState {
  saved?: boolean;
}

export const ProfileViewPage: React.FC = () => {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const location = useLocation();
  const saved = (location.state as ProfileLocationState | null)?.saved === true;
  useDocumentTitle('Profile');

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <>
      <Typography
        variant="h4"
        component="h1"
        tabIndex={-1}
        ref={headingRef}
        data-testid={profileTestIds.heading}
        sx={{ mb: 2 }}
      >
        Profile
      </Typography>
      <ProfileQueryBoundary>
        {(profile) => (
          <>
            {saved ? (
              <Typography
                role="status"
                data-testid={profileTestIds.savedMessage}
                sx={{ mb: 2 }}
              >
                Your profile was saved.
              </Typography>
            ) : null}
            <ProfileDetails profile={profile} />
            <Button
              component={Link}
              to="/profile/details/edit"
              variant="contained"
              data-testid={profileTestIds.editButton}
              sx={{ mt: 3 }}
            >
              Edit
            </Button>
          </>
        )}
      </ProfileQueryBoundary>
    </>
  );
};
