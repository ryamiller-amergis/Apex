// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { installFetch, jsonResponse } from '../testing/fetchMock';
import { sampleProfile } from '../testing/profileFixture';
import { renderRoutes } from '../testing/renderApp';
import { profileTestIds } from '../features/profile/profileTestIds';

describe('profile routes', () => {
  it('VT-21 TBI-022 DoD-0 and PBI-020 AC-0 / redirects to /profile and the edit route stays put', async () => {
    installFetch(() => jsonResponse(sampleProfile));
    const index = renderRoutes('/');
    expect(
      await screen.findByTestId(profileTestIds.loading)
    ).toBeInTheDocument();
    expect(screen.getByTestId('current-path')).toHaveTextContent('/profile');
    expect(
      await screen.findByTestId(profileTestIds.displayName)
    ).toHaveTextContent('Sam Example');
    index.unmount();

    installFetch(() => jsonResponse(sampleProfile));
    renderRoutes('/profile/details/edit');
    expect(screen.getByTestId('current-path')).toHaveTextContent(
      '/profile/details/edit'
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Loading your profile…'
    );
    expect(screen.getByTestId('current-path')).toHaveTextContent(
      '/profile/details/edit'
    );
    expect(await screen.findByTestId(profileTestIds.form)).toBeInTheDocument();
    expect(screen.getByTestId('current-path')).toHaveTextContent(
      '/profile/details/edit'
    );
  });
});
