// Routing, the query client, and the profile screen arrive with FEAT-010.
import {
  AppErrorBoundary,
  AppShell,
  AppThemeProvider,
  EmptyState,
  type NavItem,
} from '@project-scope/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, useLocation } from 'react-router';
import { webEnv } from './config/env';
import overrides from './theme/overrides';

const navItems: NavItem[] = [];

const Frame: React.FC = () => {
  const location = useLocation();
  return (
    <AppShell appName={webEnv.VITE_APP_NAME} navItems={navItems}>
      <AppErrorBoundary resetKeys={[location.pathname]}>
        <EmptyState
          title={`${webEnv.VITE_APP_NAME} is ready`}
          description="Add a route to show content here."
        />
      </AppErrorBoundary>
    </AppShell>
  );
};

const root = document.querySelector('#root');

if (!root) {
  throw new Error('Missing #root');
}

createRoot(root).render(
  <StrictMode>
    <AppThemeProvider overrides={overrides}>
      <BrowserRouter>
        <Frame />
      </BrowserRouter>
    </AppThemeProvider>
  </StrictMode>
);
