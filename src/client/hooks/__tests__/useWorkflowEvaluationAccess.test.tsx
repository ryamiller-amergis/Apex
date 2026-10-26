import { type ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useWorkflowEvaluationAccess } from '../useWorkflowEvaluationAccess';
import { useAppShell } from '../useAppShell';
import { useFeatureFlags } from '../useFeatureFlags';
import { WORKFLOW_HUMAN_EVALUATION_FLAG } from '../../../shared/types/featureFlags';
import {
  WORKFLOW_EVALUATION_SUBMIT,
  WORKFLOW_EVALUATION_VIEW,
} from '../../../shared/types/workflowEvaluationAccess';

jest.mock('../useAppShell', () => ({
  useAppShell: jest.fn(),
}));
jest.mock('../useFeatureFlags', () => ({
  useFeatureFlags: jest.fn(),
}));

const mockUseAppShell = useAppShell as jest.MockedFunction<typeof useAppShell>;
const mockUseFeatureFlags = useFeatureFlags as jest.MockedFunction<typeof useFeatureFlags>;

function mockShell(options: {
  keys?: string[];
  isSuperAdmin?: boolean;
  permissionsLoaded?: boolean;
}) {
  const keys = options.keys ?? [];
  const isSuperAdmin = options.isSuperAdmin ?? false;
  mockUseAppShell.mockReturnValue({
    can: (key: string) => isSuperAdmin || keys.includes(key),
    isSuperAdmin,
    permissionsLoaded: options.permissionsLoaded ?? true,
  } as ReturnType<typeof useAppShell>);
}

function mockFlags(options: {
  enabled?: boolean;
  isSuccess?: boolean;
  isError?: boolean;
}) {
  const isError = options.isError ?? false;
  const isSuccess = options.isSuccess ?? !isError;
  mockUseFeatureFlags.mockReturnValue({
    flags: options.enabled ? { [WORKFLOW_HUMAN_EVALUATION_FLAG]: true } : {},
    isSuccess,
    isError,
    isLoading: !isSuccess && !isError,
    isFetched: isSuccess,
  } as ReturnType<typeof useFeatureFlags>);
}

function renderAccess(project = 'Apex') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateQueries = jest.spyOn(client, 'invalidateQueries');
  const hook = renderHook(() => useWorkflowEvaluationAccess(project), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { ...hook, invalidateQueries };
}

describe('useWorkflowEvaluationAccess', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('VT-16 stays unready and grants nothing while permissions are loading', () => {
    mockShell({ permissionsLoaded: false, isSuperAdmin: true });
    mockFlags({ enabled: true, isSuccess: false, isError: false });

    const { result } = renderAccess();

    expect(result.current.ready).toBe(false);
    expect(result.current.flagEnabled).toBe(false);
    expect(result.current.canView).toBe(false);
    expect(result.current.canSubmit).toBe(false);
    expect(result.current.canAdmin).toBe(false);
  });

  it('VT-16 hides every access flag when the flag is off, including for a super admin', () => {
    mockShell({ isSuperAdmin: true });
    mockFlags({ enabled: false });

    const { result } = renderAccess();

    expect(result.current.ready).toBe(true);
    expect(result.current.flagEnabled).toBe(false);
    expect(result.current.canView).toBe(false);
    expect(result.current.canSubmit).toBe(false);
    expect(result.current.canAdmin).toBe(false);
    expect(result.current.isPlatformAdmin).toBe(true);
  });

  it('VT-16 hides access when the flag query fails', () => {
    mockShell({ keys: [WORKFLOW_EVALUATION_VIEW, WORKFLOW_EVALUATION_SUBMIT, 'admin:roles'] });
    mockFlags({ isError: true, isSuccess: false });

    const { result } = renderAccess();

    expect(result.current.ready).toBe(true);
    expect(result.current.flagEnabled).toBe(false);
    expect(result.current.canView).toBe(false);
    expect(result.current.canSubmit).toBe(false);
  });

  it('VT-16 follows can() when the flag is on', () => {
    mockShell({ keys: [WORKFLOW_EVALUATION_VIEW] });
    mockFlags({ enabled: true });
    const viewOnly = renderAccess();

    expect(viewOnly.result.current.flagEnabled).toBe(true);
    expect(viewOnly.result.current.canView).toBe(true);
    expect(viewOnly.result.current.canSubmit).toBe(false);
    expect(viewOnly.result.current.canAdmin).toBe(false);

    mockShell({ keys: [WORKFLOW_EVALUATION_VIEW, WORKFLOW_EVALUATION_SUBMIT, 'admin:roles'] });
    const granted = renderAccess();
    expect(granted.result.current.canView).toBe(true);
    expect(granted.result.current.canSubmit).toBe(true);
    expect(granted.result.current.canAdmin).toBe(true);

    mockShell({ isSuperAdmin: true });
    const platformAdmin = renderAccess();
    expect(platformAdmin.result.current.canView).toBe(true);
    expect(platformAdmin.result.current.canSubmit).toBe(true);
    expect(platformAdmin.result.current.canAdmin).toBe(true);
    expect(platformAdmin.result.current.isPlatformAdmin).toBe(true);
  });

  it('VT-17 invalidates the flag query when the server refuses the route', () => {
    mockShell({ keys: [WORKFLOW_EVALUATION_VIEW] });
    mockFlags({ enabled: true });
    const { result, invalidateQueries } = renderAccess('Apex');

    result.current.onRefused();

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['feature-flags', 'evaluate', 'Apex'],
    });
  });
});
