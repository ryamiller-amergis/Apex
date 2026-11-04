// @vitest-environment jsdom
import { APP_ERROR_MESSAGE } from '@project-scope/ui';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { AppLayout, AppProviders } from './App';
import { createTestQueryClient } from '../testing/renderApp';

const Boom: React.FC = () => {
  throw new Error('boom-secret');
};

describe('app composition', () => {
  it('VT-24 TBI-022 DoD-0 a render error stays inside main and shows the recoverable boundary', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <AppProviders client={createTestQueryClient()}>
        <MemoryRouter>
          <AppLayout>
            <Boom />
          </AppLayout>
        </MemoryRouter>
      </AppProviders>
    );

    const main = screen.getByRole('main');
    expect(main).toContainElement(screen.getByRole('alert'));
    expect(screen.getByText(APP_ERROR_MESSAGE)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Try again' })
    ).toBeInTheDocument();
    expect(screen.getByTestId('app-shell-header')).toBeInTheDocument();
    expect(screen.queryByText('boom-secret')).not.toBeInTheDocument();
  });

  it('shows Profile in the shell navigation', () => {
    render(
      <AppProviders client={createTestQueryClient()}>
        <MemoryRouter initialEntries={['/profile']}>
          <AppLayout>
            <div>content</div>
          </AppLayout>
        </MemoryRouter>
      </AppProviders>
    );

    expect(screen.getByTestId('app-shell-nav-item-profile')).toHaveAttribute(
      'href',
      '/profile'
    );
  });
});
