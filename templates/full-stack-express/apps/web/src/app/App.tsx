import {
  AppErrorBoundary,
  AppShell,
  AppThemeProvider,
  type NavItem,
} from '@project-scope/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router';
import { webEnv } from '../config/env';
import overrides from '../theme/overrides';
import { queryClient as defaultQueryClient } from './queryClient';
import { AppRoutes } from './routes';

const navItems: NavItem[] = [
  { id: 'profile', label: 'Profile', to: '/profile' },
];

export const AppLayout: React.FC<{ children: ReactNode }> = ({ children }) => {
  const location = useLocation();
  return (
    <AppShell appName={webEnv.VITE_APP_NAME} navItems={navItems}>
      <AppErrorBoundary resetKeys={[location.pathname]}>
        {children}
      </AppErrorBoundary>
    </AppShell>
  );
};

export const AppProviders: React.FC<{
  children: ReactNode;
  client?: QueryClient;
}> = ({ children, client = defaultQueryClient }) => (
  <AppThemeProvider overrides={overrides}>
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  </AppThemeProvider>
);

export const App: React.FC = () => (
  <AppLayout>
    <AppRoutes />
  </AppLayout>
);
