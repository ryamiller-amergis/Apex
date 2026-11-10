import { LoadingState } from '@project-scope/ui';
import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router';
import { profileTestIds } from '../features/profile/profileTestIds';

const HomeDashboardPage = lazy(() =>
  import('../features/home/HomeDashboardPage').then((module) => ({
    default: module.HomeDashboardPage,
  }))
);

const NotificationsPage = lazy(() =>
  import('../features/notifications/NotificationsPage').then((module) => ({
    default: module.NotificationsPage,
  }))
);

const InsightsPage = lazy(() =>
  import('../features/insights/InsightsPage').then((module) => ({
    default: module.InsightsPage,
  }))
);

const SettingsPage = lazy(() =>
  import('../features/settings/SettingsPage').then((module) => ({
    default: module.SettingsPage,
  }))
);

const ProfileViewPage = lazy(() =>
  import('../features/profile/ProfileViewPage').then((module) => ({
    default: module.ProfileViewPage,
  }))
);

const ProfileEditPage = lazy(() =>
  import('../features/profile/ProfileEditPage').then((module) => ({
    default: module.ProfileEditPage,
  }))
);

export const AppRoutes: React.FC = () => (
  <Suspense
    fallback={
      <LoadingState
        testId={profileTestIds.loading}
        label="Loading your profile…"
      />
    }
  >
    <Routes>
      <Route path="/" element={<HomeDashboardPage />} />
      <Route path="/notifications" element={<NotificationsPage />} />
      <Route path="/insights" element={<InsightsPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/profile" element={<ProfileViewPage />} />
      <Route path="/profile/details/edit" element={<ProfileEditPage />} />
    </Routes>
  </Suspense>
);
