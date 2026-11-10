import {
  ContentSurface,
  DetailPanel,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  testId,
} from '@project-scope/ui';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { postAnalyzeInsights } from '../../api/apiClient';
import { useDocumentTitle } from '../profile/useDocumentTitle';

export const insightsTestIds = {
  page: testId('insights', 'page'),
  controls: testId('insights', 'controls'),
  runButton: testId('insights', 'run-button'),
  connectorToggle: testId('insights', 'connector-toggle'),
  focusOperations: testId('insights', 'focus-operations'),
  focusRetention: testId('insights', 'focus-retention'),
  focusCapacity: testId('insights', 'focus-capacity'),
  headline: testId('insights', 'headline'),
  modelBadge: testId('insights', 'model-badge'),
  findingsList: testId('insights', 'findings-list'),
  citationsList: testId('insights', 'citations-list'),
  loading: testId('insights', 'loading'),
  error: testId('insights', 'error'),
  retry: testId('insights', 'retry'),
} as const;

export const InsightsPage: React.FC = () => {
  const [focusArea, setFocusArea] = useState<
    'operations' | 'retention' | 'capacity'
  >('operations');
  const [includeConnectorFeed, setIncludeConnectorFeed] = useState(true);

  useDocumentTitle('AI Skill Insights');

  const initialQuery = useQuery({
    queryKey: ['insights', 'analyze', focusArea, includeConnectorFeed] as const,
    queryFn: () =>
      postAnalyzeInsights({
        focusArea,
        includeConnectorFeed,
        connectorSource: 'Logistics Telemetry Feed',
      }),
    retry: false,
  });

  const analyzeMutation = useMutation({
    mutationFn: postAnalyzeInsights,
  });

  const analysis = analyzeMutation.data ?? initialQuery.data;
  const isLoading = initialQuery.isPending || analyzeMutation.isPending;
  const isError = initialQuery.isError || analyzeMutation.isError;

  const handleRun = () => {
    analyzeMutation.mutate({
      focusArea,
      includeConnectorFeed,
      connectorSource: 'Logistics Telemetry Feed',
    });
  };

  return (
    <Stack spacing={3} data-testid={insightsTestIds.page}>
      <PageHeader
        title="AI Skill Insights"
        subtitle="Grounded analysis combining PostgreSQL operational records with third-party connector feeds"
        testId="insights-page-header"
        actions={
          <Button
            type="button"
            variant="contained"
            onClick={handleRun}
            disabled={isLoading}
            data-testid={insightsTestIds.runButton}
          >
            {isLoading ? 'Analyzing…' : 'Refresh Analysis'}
          </Button>
        }
      />

      <ContentSurface testId={insightsTestIds.controls}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          sx={{
            alignItems: { xs: 'flex-start', sm: 'center' },
            justifyContent: 'space-between',
          }}
        >
          <Stack
            direction="row"
            spacing={1}
            sx={{ flexWrap: 'wrap', rowGap: 1 }}
          >
            {(
              [
                {
                  id: 'operations',
                  label: 'Operations',
                  tid: insightsTestIds.focusOperations,
                },
                {
                  id: 'retention',
                  label: 'Retention',
                  tid: insightsTestIds.focusRetention,
                },
                {
                  id: 'capacity',
                  label: 'Capacity',
                  tid: insightsTestIds.focusCapacity,
                },
              ] as const
            ).map((option) => {
              const selected = focusArea === option.id;
              return (
                <Button
                  key={option.id}
                  type="button"
                  size="small"
                  variant={selected ? 'contained' : 'outlined'}
                  aria-pressed={selected}
                  onClick={() => setFocusArea(option.id)}
                  data-testid={option.tid}
                >
                  {option.label}
                </Button>
              );
            })}
          </Stack>

          <FormControlLabel
            label="Include third-party connector feed"
            control={
              <Switch
                checked={includeConnectorFeed}
                onChange={(_event, checked) => setIncludeConnectorFeed(checked)}
                slotProps={{
                  input: {
                    'data-testid': insightsTestIds.connectorToggle,
                  } as React.InputHTMLAttributes<HTMLInputElement>,
                }}
              />
            }
          />
        </Stack>
      </ContentSurface>

      {isLoading ? (
        <LoadingState
          testId={insightsTestIds.loading}
          label="Running AI skill analysis…"
        />
      ) : isError ? (
        <ErrorState
          testId={insightsTestIds.error}
          retryTestId={insightsTestIds.retry}
          title="We couldn't complete the insights analysis"
          onRetry={() => {
            void initialQuery.refetch();
          }}
        />
      ) : !analysis || analysis.findings.length === 0 ? (
        <EmptyState
          title="No insights generated yet"
          description="Select a focus area and run the analysis skill."
        />
      ) : (
        <>
          <ContentSurface testId="insights-summary-card">
            <Stack spacing={1.5}>
              <Stack
                direction="row"
                spacing={1}
                sx={{ alignItems: 'center', flexWrap: 'wrap' }}
              >
                <Chip
                  size="small"
                  color="primary"
                  label={`Skill: ${analysis.skillName}`}
                />
                <Chip
                  size="small"
                  variant="outlined"
                  label={`Model: ${analysis.modelId}`}
                  data-testid={insightsTestIds.modelBadge}
                />
              </Stack>
              <Typography
                variant="h6"
                component="h2"
                data-testid={insightsTestIds.headline}
              >
                {analysis.headline}
              </Typography>
            </Stack>
          </ContentSurface>

          <Stack spacing={2} data-testid={insightsTestIds.findingsList}>
            {analysis.findings.map((finding) => (
              <DetailPanel
                key={finding.id}
                id={finding.id}
                title={finding.title}
                subtitle={`Impact: ${finding.impact.toUpperCase()}`}
              >
                <Stack spacing={1.5}>
                  <Typography variant="body2" color="text.secondary">
                    {finding.summary}
                  </Typography>
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Recommended action
                    </Typography>
                    <Typography
                      variant="body2"
                      sx={{ fontWeight: 'fontWeightBold' }}
                      data-testid={testId('insights-action', finding.id)}
                    >
                      {finding.recommendedAction}
                    </Typography>
                  </Box>
                </Stack>
              </DetailPanel>
            ))}
          </Stack>

          <ContentSurface testId={insightsTestIds.citationsList}>
            <Typography variant="subtitle1" component="h3" sx={{ mb: 1.5 }}>
              Source Citations
            </Typography>
            <Stack spacing={1.5}>
              {analysis.citations.map((citation) => (
                <Box
                  key={citation.id}
                  data-testid={testId('insights-citation', citation.id)}
                >
                  <Stack
                    direction="row"
                    spacing={1}
                    sx={{ alignItems: 'center', mb: 0.5 }}
                  >
                    <Chip
                      size="small"
                      color={
                        citation.sourceKind === 'database' ? 'success' : 'info'
                      }
                      label={citation.sourceKind}
                    />
                    <Typography
                      variant="body2"
                      sx={{ fontWeight: 'fontWeightBold' }}
                    >
                      {citation.sourceLabel}
                    </Typography>
                  </Stack>
                  <Typography variant="body2" color="text.secondary">
                    {citation.excerpt}
                  </Typography>
                </Box>
              ))}
            </Stack>
          </ContentSurface>
        </>
      )}
    </Stack>
  );
};
