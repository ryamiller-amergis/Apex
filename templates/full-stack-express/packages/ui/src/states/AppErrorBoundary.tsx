import type { ErrorInfo, ReactNode } from 'react';
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary';
import { ErrorState } from './ErrorState.js';

/** The fixed text shown by the boundary. The thrown message is never shown. */
export const APP_ERROR_MESSAGE =
  'Something went wrong. Try again, and if the problem continues, contact your administrator.';

export interface AppErrorBoundaryProps {
  children: ReactNode;
  /**
   * Receives the raw error. Redact identity values (display name, email,
   * subject) before logging it.
   */
  onError?: (error: unknown, info: ErrorInfo) => void;
  /** A change in any value clears the error, for example the route path. */
  resetKeys?: unknown[];
}

const Fallback: React.FC<FallbackProps> = ({ resetErrorBoundary }) => (
  <ErrorState message={APP_ERROR_MESSAGE} onRetry={resetErrorBoundary} />
);

/**
 * Catches render errors below it and shows a recoverable `ErrorState` with a
 * retry button instead of a blank page.
 *
 * @example
 * const location = useLocation();
 * <AppErrorBoundary resetKeys={[location.pathname]}>
 *   <Routes>…</Routes>
 * </AppErrorBoundary>
 */
export const AppErrorBoundary: React.FC<AppErrorBoundaryProps> = ({
  children,
  onError,
  resetKeys,
}) => (
  <ErrorBoundary
    FallbackComponent={Fallback}
    onError={onError}
    resetKeys={resetKeys}
  >
    {children}
  </ErrorBoundary>
);
