/**
 * Tests for the Calendar Work-Item Assistant launcher in DetailsPanel.
 *
 * Covers: feature-flag disabled path, button rendering when enabled,
 * permission gating, and click handler.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { DetailsPanel } from '../DetailsPanel';

// ── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('../../config/env', () => ({
  env: {
    VITE_TEAMS: 'MaxView|MaxView',
    VITE_ADO_ORG: 'amergis',
    VITE_ADO_PROJECT: 'MaxView',
    VITE_POLL_INTERVAL: 60,
  },
}));

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: jest.fn(),
}));

jest.mock('../../hooks/useFeatureFlags', () => ({
  useFeatureFlag: jest.fn(),
}));

import { useAppShell } from '../../hooks/useAppShell';
import { useFeatureFlag } from '../../hooks/useFeatureFlags';

const mockUseAppShell = useAppShell as jest.Mock;
const mockUseFeatureFlag = useFeatureFlag as jest.Mock;

function makeWorkItem(overrides?: object) {
  return {
    id: 123,
    title: 'Test Feature',
    state: 'Active',
    workItemType: 'Feature',
    changedDate: '2026-07-15',
    createdDate: '2026-07-01',
    areaPath: 'MaxView',
    iterationPath: 'MaxView\\Sprint 1',
    tags: '',
    description: '<p>Description</p>',
    acceptanceCriteria: '',
    ...overrides,
  };
}

function renderDetailsPanel(props?: Partial<React.ComponentProps<typeof DetailsPanel>>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = jest.fn();
  const onUpdateDueDate = jest.fn();
  const onOpenAssistant = jest.fn();
  const onSelectItem = jest.fn();

  render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <DetailsPanel
          workItem={makeWorkItem() as any}
          onClose={onClose}
          onUpdateDueDate={onUpdateDueDate}
          project="MaxView"
          areaPath="MaxView"
          onSelectItem={onSelectItem}
          onOpenAssistant={onOpenAssistant}
          {...props}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );

  return { onClose, onUpdateDueDate, onOpenAssistant, onSelectItem };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUseAppShell.mockReturnValue({
    authenticatedUser: { name: 'Test User', email: 'test@example.com' },
    can: jest.fn((permission: string) => ['calendar:view', 'workitems:write'].includes(permission)),
    isAdmin: true,
  });
  // Mock fetch for API calls made by DetailsPanel effects
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => [],
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('DetailsPanel: Calendar Work-Item Assistant launcher', () => {
  describe('when feature flag is disabled', () => {
    beforeEach(() => {
      mockUseFeatureFlag.mockReturnValue(false);
    });

    it('does not render the Assistant button', () => {
      renderDetailsPanel();
      expect(screen.queryByRole('button', { name: /assistant/i })).not.toBeInTheDocument();
    });
  });

  describe('when feature flag is enabled', () => {
    beforeEach(() => {
      mockUseFeatureFlag.mockReturnValue(true);
    });

    it('renders the Assistant button', () => {
      renderDetailsPanel();
      expect(screen.getByRole('button', { name: /Work-Item Assistant/i })).toBeInTheDocument();
    });

    it('calls onOpenAssistant with work item id and title when clicked', () => {
      const { onOpenAssistant } = renderDetailsPanel();
      fireEvent.click(screen.getByRole('button', { name: /Work-Item Assistant/i }));
      expect(onOpenAssistant).toHaveBeenCalledWith(123, 'Test Feature');
    });

    it('does not render Assistant button when onOpenAssistant is not provided', () => {
      renderDetailsPanel({ onOpenAssistant: undefined });
      expect(screen.queryByRole('button', { name: /Work-Item Assistant/i })).not.toBeInTheDocument();
    });

    it('does not render Assistant button when user lacks calendar:view permission', () => {
      mockUseAppShell.mockReturnValue({
        authenticatedUser: { name: 'Test User' },
        can: jest.fn(() => false),
        isAdmin: false,
      });

      renderDetailsPanel();
      expect(screen.queryByRole('button', { name: /Work-Item Assistant/i })).not.toBeInTheDocument();
    });
  });
});
