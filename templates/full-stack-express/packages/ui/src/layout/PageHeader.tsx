import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  testId?: string;
}

export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  subtitle,
  actions,
  testId,
}) => (
  <Stack
    direction={{ xs: 'column', sm: 'row' }}
    spacing={2}
    sx={{
      alignItems: { xs: 'stretch', sm: 'center' },
      justifyContent: 'space-between',
      mb: 3,
    }}
    data-testid={testId}
  >
    <Stack spacing={0.5}>
      <Typography variant="h4" component="h1">
        {title}
      </Typography>
      {subtitle ? (
        <Typography variant="body2" color="text.secondary">
          {subtitle}
        </Typography>
      ) : null}
    </Stack>
    {actions ? (
      <Stack direction="row" spacing={1}>
        {actions}
      </Stack>
    ) : null}
  </Stack>
);
