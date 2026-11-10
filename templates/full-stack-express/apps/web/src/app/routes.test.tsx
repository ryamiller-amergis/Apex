// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { installFetch, jsonResponse } from '../testing/fetchMock';
import { sampleProfile } from '../testing/profileFixture';
import { renderRoutes } from '../testing/renderApp';
import { homeTestIds } from '../features/home/HomeDashboardPage';
import { profileTestIds } from '../features/profile/profileTestIds';

describe('app routes', () => {
  it('VT-21 TBI-022 DoD-0 and PBI-020 AC-0 / renders the home dashboard and /profile/details/edit stays put', async () => {
    installFetch(() => jsonResponse(sampleProfile));
    const index = renderRoutes('/');
    expect(await screen.findByTestId(homeTestIds.page)).toBeInTheDocument();
    expect(screen.getByTestId('current-path')).toHaveTextContent('/');
    index.unmount();

    installFetch(() => jsonResponse(sampleProfile));
    renderRoutes('/profile/details/edit');
    expect(screen.getByTestId('current-path')).toHaveTextContent(
      '/profile/details/edit'
    );
    expect(await screen.findByTestId(profileTestIds.form)).toBeInTheDocument();
    expect(screen.getByTestId('current-path')).toHaveTextContent(
      '/profile/details/edit'
    );
  });
});
