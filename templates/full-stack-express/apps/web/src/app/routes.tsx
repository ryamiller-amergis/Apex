import { LoadingState } from '@project-scope/ui';
import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { profileTestIds } from '../features/profile/profileTestIds';

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
      <Route path="/" element={<Navigate to="/profile" replace />} />
      <Route path="/profile" element={<ProfileViewPage />} />
      <Route path="/profile/details/edit" element={<ProfileEditPage />} />
    </Routes>
  </Suspense>
);
