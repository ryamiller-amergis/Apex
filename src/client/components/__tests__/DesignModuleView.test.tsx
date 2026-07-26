import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DesignModuleView } from '../DesignModuleView';

const mutateAsync = jest.fn();

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({
    can: (key: string) =>
      [
        'design-module:view',
        'design-module:manage',
        'design-module:regenerate',
      ].includes(key),
  }),
}));

jest.mock('../../hooks/useDesignModules', () => ({
  useDesignModules: () => ({
    data: [
      {
        id: 'module-1',
        slug: 'rbac',
        label: 'RBAC',
        description: 'Role-based access control',
        iconKey: 'rbac',
        sourceGlobs: ['src/server/services/rbacService.ts'],
        sortOrder: 1,
        hasContent: true,
        isStale: true,
        sourceAvailable: true,
        lastGeneratedAt: null,
        generatedByModel: null,
        createdAt: '2026-07-15T00:00:00.000Z',
        updatedAt: '2026-07-15T00:00:00.000Z',
      },
    ],
    isLoading: false,
    error: null,
  }),
  useDesignModule: () => ({
    data: {
      id: 'module-1',
      slug: 'rbac',
      label: 'RBAC',
      description: 'Role-based access control',
      iconKey: 'rbac',
      sourceGlobs: ['src/server/services/rbacService.ts'],
      sortOrder: 1,
      content: '## Purpose\n\nRBAC controls access.',
      sourceFingerprint: 'abc',
      sourceCommit: 'def',
      hasContent: true,
      isStale: true,
      sourceAvailable: true,
      lastGeneratedAt: '2026-07-15T12:00:00.000Z',
      generatedByModel: 'claude-sonnet-4',
      createdBy: 'user-1',
      updatedBy: 'user-1',
      scopingThreadId: null,
      createdAt: '2026-07-15T00:00:00.000Z',
      updatedAt: '2026-07-15T00:00:00.000Z',
    },
    isLoading: false,
    error: null,
  }),
  useRegenerateDesignModule: () => ({
    mutateAsync,
    isPending: false,
    error: null,
  }),
  useDeleteDesignModule: () => ({
    mutateAsync: jest.fn(),
    isPending: false,
    error: null,
  }),
  useCreateDesignModule: () => ({
    mutateAsync: jest.fn(),
    isPending: false,
    error: null,
  }),
  useUpdateDesignModule: () => ({
    mutateAsync: jest.fn(),
    isPending: false,
    error: null,
  }),
}));

jest.mock('../MarkdownWithMermaid', () => ({
  MarkdownWithMermaid: ({ content }: { content: string }) => (
    <div>{content}</div>
  ),
}));

jest.mock('../DesignModuleFormModal', () => ({
  DesignModuleFormModal: ({
    onSaved,
  }: {
    onSaved: (
      slug: string,
      meta?: { generationStarted?: boolean; generationError?: string }
    ) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        onSaved('new-module', { generationStarted: true })
      }
    >
      Save Mock Module
    </button>
  ),
}));

describe('DesignModuleView', () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue({ started: true, threadId: 'thread-1' });
  });

  it('renders curated content and stale status', async () => {
    render(<DesignModuleView selectedProject="Apex" />);
    expect(await screen.findByText(/RBAC controls access/)).toBeInTheDocument();
    expect(screen.getByText('May be out of date')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Add Module' })
    ).toBeInTheDocument();
    expect(screen.getByText(/Last generated/)).toBeInTheDocument();
    expect(screen.getByText(/claude-sonnet-4/)).toBeInTheDocument();
  });

  it('starts cost-guarded regeneration for the active project', async () => {
    render(<DesignModuleView selectedProject="Apex" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Regenerate' }));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        slug: 'rbac',
        input: { project: 'Apex', force: false },
      })
    );
  });

  it('passes the explicit force override', async () => {
    render(<DesignModuleView selectedProject="Apex" />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Force' }));
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        slug: 'rbac',
        input: { project: 'Apex', force: true },
      })
    );
  });

  it('shows generation-in-progress after creating a module', async () => {
    render(<DesignModuleView selectedProject="Apex" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add Module' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Mock Module' }));
    expect(
      await screen.findByText(/Generation started/)
    ).toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('opens a custom delete confirmation modal instead of window.confirm', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockImplementation(() => {
      throw new Error('window.confirm must not be called');
    });
    render(<DesignModuleView selectedProject="Apex" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(
      await screen.findByRole('dialog', { name: /Delete architecture module/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/“RBAC”/)).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
