import {
  ContentSurface,
  DataChartCard,
  PageHeader,
  StatGrid,
  testId,
  type DataChartPoint,
  type MetricCardProps,
} from '@project-scope/ui';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { Link } from 'react-router';
import { readPreviewUserIdentity } from '../../api/previewSampleStore';
import { useProfileQuery } from '../profile/useProfileQuery';
import { useDocumentTitle } from '../profile/useDocumentTitle';

export const homeTestIds = {
  page: testId('home', 'page'),
  welcomeBanner: testId('home', 'welcome-banner'),
  quickActions: testId('home', 'quick-actions'),
  openInsights: testId('home', 'open-insights'),
  openNotifications: testId('home', 'open-notifications'),
  openProfile: testId('home', 'open-profile'),
} as const;

const CHART_SERIES: Record<'7d' | '30d' | '90d', readonly DataChartPoint[]> = {
  '7d': [
    { id: 'mon', label: 'Mon', value: 124 },
    { id: 'tue', label: 'Tue', value: 138 },
    { id: 'wed', label: 'Wed', value: 142 },
    { id: 'thu', label: 'Thu', value: 156 },
    { id: 'fri', label: 'Fri', value: 164 },
  ],
  '30d': [
    { id: 'wk1', label: 'Week 1', value: 520 },
    { id: 'wk2', label: 'Week 2', value: 585 },
    { id: 'wk3', label: 'Week 3', value: 610 },
    { id: 'wk4', label: 'Week 4', value: 668 },
  ],
  '90d': [
    { id: 'jan', label: 'Jan', value: 2140 },
    { id: 'feb', label: 'Feb', value: 2390 },
    { id: 'mar', label: 'Mar', value: 2680 },
  ],
};

const METRICS_BY_WINDOW: Record<
  '7d' | '30d' | '90d',
  readonly MetricCardProps[]
> = {
  '7d': [
    {
      id: 'throughput',
      label: 'Verified Batches',
      value: '724',
      delta: '+14% vs prior week',
      trend: 'up',
      helperText: 'Across 4 regional fulfillment hubs',
    },
    {
      id: 'sla',
      label: 'On-Time SLA',
      value: '98.4%',
      delta: '+0.6% above target',
      trend: 'up',
      helperText: 'Target threshold: 97.8%',
    },
    {
      id: 'exceptions',
      label: 'Open Dock Alerts',
      value: '2',
      delta: '-3 resolved today',
      trend: 'down',
      helperText: 'Midwest afternoon lane under review',
    },
  ],
  '30d': [
    {
      id: 'throughput',
      label: 'Verified Batches',
      value: '2,383',
      delta: '+18% vs prior month',
      trend: 'up',
      helperText: 'Across 4 regional fulfillment hubs',
    },
    {
      id: 'sla',
      label: 'On-Time SLA',
      value: '98.1%',
      delta: '+0.3% above target',
      trend: 'up',
      helperText: 'Target threshold: 97.8%',
    },
    {
      id: 'exceptions',
      label: 'Open Dock Alerts',
      value: '5',
      delta: '-8 vs prior 30d',
      trend: 'down',
      helperText: 'All high-severity holds cleared',
    },
  ],
  '90d': [
    {
      id: 'throughput',
      label: 'Verified Batches',
      value: '7,210',
      delta: '+24% quarter-over-quarter',
      trend: 'up',
      helperText: 'Quarterly operational run rate',
    },
    {
      id: 'sla',
      label: 'On-Time SLA',
      value: '97.9%',
      delta: '+0.1% above target',
      trend: 'up',
      helperText: 'Sustained across peak volume',
    },
    {
      id: 'exceptions',
      label: 'Open Dock Alerts',
      value: '12',
      delta: '-19% incident rate',
      trend: 'down',
      helperText: 'Automated pre-check active',
    },
  ],
};

export const HomeDashboardPage: React.FC = () => {
  const [timeframe, setTimeframe] = useState<'7d' | '30d' | '90d'>('7d');
  const profileQuery = useProfileQuery();
  const fallbackIdentity = readPreviewUserIdentity();
  const displayName =
    profileQuery.data?.displayName ?? fallbackIdentity.displayName;

  useDocumentTitle('Operations Dashboard');

  return (
    <Stack spacing={3} data-testid={homeTestIds.page}>
      <PageHeader
        title="Operations Overview"
        subtitle="Real-time fulfillment throughput, SLA health, and AI-grounded workflow signals"
        testId="home-page-header"
        actions={
          <Button
            component={Link}
            to="/insights"
            variant="contained"
            data-testid={homeTestIds.openInsights}
          >
            Run AI Insights
          </Button>
        }
      />

      <ContentSurface testId={homeTestIds.welcomeBanner} padding="sm">
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1.5}
          sx={{
            alignItems: { xs: 'flex-start', sm: 'center' },
            justifyContent: 'space-between',
          }}
        >
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
            <Chip
              label={fallbackIdentity.avatarInitials}
              color="primary"
              size="small"
              data-testid="home-user-initials"
            />
            <Typography variant="body1">
              Signed in as <strong>{displayName}</strong> ·{' '}
              {fallbackIdentity.role}
            </Typography>
          </Stack>
          <Stack
            direction="row"
            spacing={1}
            data-testid={homeTestIds.quickActions}
          >
            <Button
              component={Link}
              to="/notifications"
              size="small"
              variant="outlined"
              data-testid={homeTestIds.openNotifications}
            >
              View Notifications
            </Button>
            <Button
              component={Link}
              to="/profile"
              size="small"
              variant="text"
              data-testid={homeTestIds.openProfile}
            >
              Profile
            </Button>
          </Stack>
        </Stack>
      </ContentSurface>

      <StatGrid metrics={METRICS_BY_WINDOW[timeframe]} />

      <DataChartCard
        id="fulfillment"
        title="Fulfillment Throughput"
        subtitle="Completed priority batches by period"
        unit="batches"
        variant="bar"
        points={CHART_SERIES[timeframe]}
        filters={[
          { id: '7d', label: '7 days' },
          { id: '30d', label: '30 days' },
          { id: '90d', label: '90 days' },
        ]}
        activeFilterId={timeframe}
        onFilterChange={(next) => {
          if (next === '7d' || next === '30d' || next === '90d') {
            setTimeframe(next);
          }
        }}
      />
    </Stack>
  );
};
