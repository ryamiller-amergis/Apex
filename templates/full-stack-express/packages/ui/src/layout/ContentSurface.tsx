import Paper from '@mui/material/Paper';
import type { ReactNode } from 'react';

export interface ContentSurfaceProps {
  children: ReactNode;
  testId?: string;
  padding?: 'sm' | 'md' | 'lg';
}

const paddingMap = {
  sm: 2,
  md: 3,
  lg: 4,
} as const;

export const ContentSurface: React.FC<ContentSurfaceProps> = ({
  children,
  testId,
  padding = 'md',
}) => (
  <Paper
    variant="outlined"
    data-testid={testId}
    sx={{
      p: paddingMap[padding],
      borderRadius: 2,
      bgcolor: 'background.paper',
    }}
  >
    {children}
  </Paper>
);
