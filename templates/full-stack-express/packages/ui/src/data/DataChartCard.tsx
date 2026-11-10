import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonGroup from '@mui/material/ButtonGroup';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import { useTheme } from '@mui/material/styles';
import Typography from '@mui/material/Typography';
import { testId } from '../testing/testId.js';

export interface DataChartPoint {
  id: string;
  label: string;
  value: number;
}

export interface DataChartFilterOption {
  id: string;
  label: string;
}

export interface DataChartCardProps {
  id?: string;
  title: string;
  subtitle?: string;
  unit?: string;
  variant?: 'bar' | 'line';
  points: readonly DataChartPoint[];
  filters?: readonly DataChartFilterOption[];
  activeFilterId?: string;
  onFilterChange?: (filterId: string) => void;
}

export const DataChartCard: React.FC<DataChartCardProps> = ({
  id = 'primary',
  title,
  subtitle,
  unit = '',
  variant = 'bar',
  points,
  filters,
  activeFilterId,
  onFilterChange,
}) => {
  const theme = useTheme();
  const maxVal = Math.max(1, ...points.map((point) => point.value));
  const chartWidth = 600;
  const chartHeight = 180;
  const topPad = 16;
  const bottomPad = 28;
  const usableHeight = chartHeight - topPad - bottomPad;
  const slotWidth = points.length > 0 ? chartWidth / points.length : chartWidth;

  const lineCoordinates = points.map((point, index) => {
    const x = index * slotWidth + slotWidth / 2;
    const y = topPad + usableHeight * (1 - point.value / maxVal);
    return { ...point, x, y };
  });

  const polylinePoints = lineCoordinates
    .map((coord) => `${coord.x},${coord.y}`)
    .join(' ');

  return (
    <Paper
      variant="outlined"
      data-testid={testId('data-chart-card', id)}
      sx={{
        p: 3,
        borderRadius: 2,
        bgcolor: 'background.paper',
      }}
    >
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1.5}
        sx={{
          alignItems: { xs: 'flex-start', sm: 'center' },
          justifyContent: 'space-between',
          mb: 2,
        }}
      >
        <Box>
          <Typography variant="h6" component="h2">
            {title}
          </Typography>
          {subtitle ? (
            <Typography variant="body2" color="text.secondary">
              {subtitle}
            </Typography>
          ) : null}
        </Box>
        {filters && filters.length > 0 ? (
          <ButtonGroup
            size="small"
            aria-label={`${title} timeframe filter`}
            data-testid={testId('data-chart', id, 'filters')}
          >
            {filters.map((filter) => {
              const selected = filter.id === activeFilterId;
              return (
                <Button
                  key={filter.id}
                  type="button"
                  variant={selected ? 'contained' : 'outlined'}
                  aria-pressed={selected}
                  data-testid={testId('data-chart', id, 'filter', filter.id)}
                  onClick={() => onFilterChange?.(filter.id)}
                >
                  {filter.label}
                </Button>
              );
            })}
          </ButtonGroup>
        ) : null}
      </Stack>

      <Box sx={{ width: '100%', overflowX: 'auto' }}>
        <Box
          component="svg"
          role="img"
          aria-label={`${title} chart`}
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          data-testid={testId('data-chart', id, 'svg')}
          sx={{ width: '100%', height: 180, display: 'block' }}
        >
          <title>{title}</title>
          {variant === 'line' && lineCoordinates.length > 1 ? (
            <>
              <polyline
                fill="none"
                stroke={theme.vars.palette.primary.main}
                strokeWidth={3}
                points={polylinePoints}
                data-testid={testId('data-chart', id, 'line')}
              />
              {lineCoordinates.map((coord) => (
                <g key={coord.id}>
                  <circle
                    cx={coord.x}
                    cy={coord.y}
                    r={5}
                    fill={theme.vars.palette.primary.main}
                    data-testid={testId('data-chart', id, 'point', coord.id)}
                  />
                  <text
                    x={coord.x}
                    y={chartHeight - 8}
                    textAnchor="middle"
                    fill={theme.vars.palette.text.secondary}
                    fontSize={12}
                  >
                    {coord.label}
                  </text>
                </g>
              ))}
            </>
          ) : (
            points.map((point, index) => {
              const barWidth = Math.max(16, Math.min(48, slotWidth * 0.6));
              const barHeight = Math.max(
                4,
                Math.round((point.value / maxVal) * usableHeight)
              );
              const x = index * slotWidth + (slotWidth - barWidth) / 2;
              const y = topPad + usableHeight - barHeight;
              return (
                <g key={point.id}>
                  <rect
                    x={x}
                    y={y}
                    width={barWidth}
                    height={barHeight}
                    rx={4}
                    fill={theme.vars.palette.primary.main}
                    data-testid={testId('data-chart', id, 'bar', point.id)}
                  />
                  <text
                    x={index * slotWidth + slotWidth / 2}
                    y={chartHeight - 8}
                    textAnchor="middle"
                    fill={theme.vars.palette.text.secondary}
                    fontSize={12}
                  >
                    {point.label}
                  </text>
                </g>
              );
            })
          )}
        </Box>
      </Box>

      <Stack
        component="ul"
        direction="row"
        spacing={2}
        data-testid={testId('data-chart', id, 'summary')}
        sx={{
          listStyle: 'none',
          p: 0,
          m: 0,
          mt: 1.5,
          flexWrap: 'wrap',
          rowGap: 1,
        }}
      >
        {points.map((point) => (
          <Box
            component="li"
            key={point.id}
            data-testid={testId('data-chart', id, 'value', point.id)}
          >
            <Typography variant="caption" color="text.secondary">
              {point.label}:{' '}
            </Typography>
            <Typography variant="caption" sx={{ fontWeight: 'fontWeightBold' }}>
              {point.value}
              {unit ? ` ${unit}` : ''}
            </Typography>
          </Box>
        ))}
      </Stack>
    </Paper>
  );
};
