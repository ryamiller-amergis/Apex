import type { ProfileStatus } from '@project-scope/contracts';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { ProfileStatusChip } from './ProfileStatusChip';
import { profileTestIds } from './profileTestIds';

export interface ProfileDetailsData {
  displayName: string;
  email: string | null | undefined;
  status: ProfileStatus;
}

function emailText(email: string | null | undefined): string | null {
  if (email === null || email === undefined || email.trim() === '') {
    return null;
  }
  return email;
}

export const ProfileDetails: React.FC<{ profile: ProfileDetailsData }> = ({
  profile,
}) => {
  const email = emailText(profile.email);
  return (
    <Box component="dl" data-testid={profileTestIds.details} sx={{ m: 0 }}>
      <Typography component="dt" variant="body2" color="text.secondary">
        Display name
      </Typography>
      <Typography
        component="dd"
        variant="body1"
        data-testid={profileTestIds.displayName}
        sx={{ ml: 0, mb: 2 }}
      >
        {profile.displayName}
      </Typography>
      <Typography component="dt" variant="body2" color="text.secondary">
        Email
      </Typography>
      <Typography
        component="dd"
        variant="body1"
        data-testid={
          email === null ? profileTestIds.emailEmpty : profileTestIds.email
        }
        sx={{ ml: 0, mb: 2 }}
      >
        {email ?? 'No email on file'}
      </Typography>
      <Typography component="dt" variant="body2" color="text.secondary">
        Status
      </Typography>
      <Typography component="dd" variant="body1" sx={{ ml: 0 }}>
        <ProfileStatusChip status={profile.status} />
      </Typography>
    </Box>
  );
};
