import {
  ContentSurface,
  PageHeader,
  testId,
  useColorMode,
} from '@project-scope/ui';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { Link } from 'react-router';
import { brandConfig } from '../../theme/overrides';
import { useDocumentTitle } from '../profile/useDocumentTitle';

export const settingsTestIds = {
  page: testId('settings', 'page'),
  brandCard: testId('settings', 'brand-card'),
  brandName: testId('settings', 'brand-name'),
  brandTagline: testId('settings', 'brand-tagline'),
  themeMode: testId('settings', 'theme-mode'),
  toggleThemeButton: testId('settings', 'toggle-theme-button'),
  profileLink: testId('settings', 'profile-link'),
} as const;

export const SettingsPage: React.FC = () => {
  const { mode, setMode } = useColorMode();
  useDocumentTitle('Settings');

  return (
    <Stack spacing={3} data-testid={settingsTestIds.page}>
      <PageHeader
        title="Settings & Brand Preview"
        subtitle="Inspect active brand tokens, colour scheme preferences, and account profile"
        testId="settings-page-header"
        actions={
          <Button
            component={Link}
            to="/profile"
            variant="outlined"
            data-testid={settingsTestIds.profileLink}
          >
            Manage Profile
          </Button>
        }
      />

      <ContentSurface testId={settingsTestIds.brandCard}>
        <Stack spacing={1.5}>
          <Typography variant="h6" component="h2">
            Brand Identity
          </Typography>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
            <Chip
              color="primary"
              label={brandConfig.appName}
              data-testid={settingsTestIds.brandName}
            />
            <Typography
              variant="body2"
              color="text.secondary"
              data-testid={settingsTestIds.brandTagline}
            >
              {brandConfig.tagline}
            </Typography>
          </Stack>
        </Stack>
      </ContentSurface>

      <ContentSurface testId="settings-theme-card">
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          sx={{
            alignItems: { xs: 'flex-start', sm: 'center' },
            justifyContent: 'space-between',
          }}
        >
          <Stack spacing={0.5}>
            <Typography variant="h6" component="h2">
              Colour Mode
            </Typography>
            <Typography
              variant="body2"
              color="text.secondary"
              data-testid={settingsTestIds.themeMode}
            >
              Active theme mode: {mode}
            </Typography>
          </Stack>
          <Button
            type="button"
            variant="outlined"
            onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}
            data-testid={settingsTestIds.toggleThemeButton}
          >
            Switch to {mode === 'dark' ? 'light' : 'dark'} mode
          </Button>
        </Stack>
      </ContentSurface>
    </Stack>
  );
};
