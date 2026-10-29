import type { ProfileStatus } from '@project-scope/contracts';
import Chip from '@mui/material/Chip';
import { profileTestIds } from './profileTestIds';

export const statusLabels = {
  active: 'Active',
  disabled: 'Disabled',
} as const satisfies Record<ProfileStatus, string>;

export const ProfileStatusChip: React.FC<{ status: ProfileStatus }> = ({
  status,
}) => (
  <Chip
    label={statusLabels[status]}
    variant="outlined"
    data-testid={profileTestIds.status}
  />
);
