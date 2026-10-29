import Typography from '@mui/material/Typography';
import { useEffect, useRef } from 'react';
import { ProfileForm } from './ProfileForm';
import { ProfileQueryBoundary } from './ProfileQueryBoundary';
import { profileTestIds } from './profileTestIds';
import { useDocumentTitle } from './useDocumentTitle';

export const ProfileEditPage: React.FC = () => {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useDocumentTitle('Edit profile');

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
        Edit profile
      </Typography>
      <ProfileQueryBoundary>
        {(profile) => <ProfileForm profile={profile} />}
      </ProfileQueryBoundary>
    </>
  );
};
