import { QueryClient } from '@tanstack/react-query';

/**
 * Shared query client. Mutations do not retry. Queries keep TanStack Query's
 * own retry default; the profile query turns retries off itself.
 */
export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      mutations: { retry: 0 },
    },
  });
}

export const queryClient = createAppQueryClient();
