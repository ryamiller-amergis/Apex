import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { ReactNode } from 'react';
import { testId } from '../testing/testId.js';

export type MetricTrendDirection = 'up' | 'down' | 'neutral';

export interface MetricCardProps {
  id: string;
  label: string;
  value: string | number;
  delta?: string;
  trend?: MetricTrendDirection;
  helperText?: string;
  icon?: ReactNode;
}

export const MetricCard: React.FC<MetricCardProps> = ({
  id,
  label,
  value,
  delta,
  trend = 'neutral',
  helperText,
  icon,
}) => {
  const chipColor =
    trend === 'up' ? 'success' : trend === 'down' ? 'warning' : 'default';

  return (
    <Paper
      variant="outlined"
      data-testid={testId('metric-card', id)}
      sx={{
        p: 2.5,
        borderRadius: 2,
        bgcolor: 'background.paper',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        gap: 1,
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'center', justifyContent: 'space-between' }}
      >
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
        {icon ? <Box sx={{ color: 'primary.main' }}>{icon}</Box> : null}
      </Stack>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'baseline', justifyContent: 'space-between' }}
      >
        <Typography
          variant="h4"
          component="p"
          data-testid={testId('metric-card', id, 'value')}
        >
          {value}
        </Typography>
        {delta ? (
          <Chip
            size="small"
            color={chipColor}
            label={delta}
            data-testid={testId('metric-card', id, 'delta')}
          />
        ) : null}
      </Stack>
      {helperText ? (
        <Typography variant="caption" color="text.secondary">
          {helperText}
        </Typography>
      ) : null}
    </Paper>
  );
};

export interface StatGridProps {
  metrics: readonly MetricCardProps[];
  testId?: string;
}

export const StatGrid: React.FC<StatGridProps> = ({
  metrics,
  testId: gridTestId = 'stat-grid',
}) => (
  <Box
    data-testid={gridTestId}
    sx={{
      display: 'grid',
      gridTemplateColumns: {
        xs: '1fr',
        sm: 'repeat(2, minmax(0, 1fr))',
        md: 'repeat(3, minmax(0, 1fr))',
      },
      gap: 2,
    }}
  >
    {metrics.map((metric) => (
      <MetricCard key={metric.id} {...metric} />
    ))}
  </Box>
);
