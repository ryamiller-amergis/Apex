// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { deferred, installFetch, jsonResponse } from '../../testing/fetchMock';
import {
  problemResponse,
  sampleProfile,
  SECRET_PROBLEM_DETAIL,
  SECRET_PROBLEM_TITLE,
  SECRET_REQUEST_ID,
} from '../../testing/profileFixture';
import { createTestQueryClient, renderApp } from '../../testing/renderApp';
import { profileKeys } from './profileKeys';
import { profileTestIds } from './profileTestIds';

function expectNoTechnicalDetail(): void {
  const text = document.body.textContent ?? '';
  expect(text).not.toContain(SECRET_PROBLEM_TITLE);
  expect(text).not.toContain(SECRET_PROBLEM_DETAIL);
  expect(text).not.toContain(SECRET_REQUEST_ID);
  expect(text).not.toMatch(/\b500\b/);
}

describe('ProfileViewPage', () => {
  it('VT-01 PBI-019 AC-0 shows a loading status, then name, email, and status', async () => {
    const gate = deferred<Response>();
    installFetch(() => gate.promise);
    renderApp('/profile');

    const loading = await screen.findByTestId(profileTestIds.loading);
    expect(loading).toHaveTextContent('Loading your profile…');
    expect(loading).toHaveAttribute('role', 'status');
    expect(
      screen.queryByTestId(profileTestIds.details)
    ).not.toBeInTheDocument();

    gate.resolve(jsonResponse(sampleProfile));

    expect(
      await screen.findByTestId(profileTestIds.displayName)
    ).toHaveTextContent('Sam Example');
    expect(screen.getByTestId(profileTestIds.email)).toHaveTextContent(
      'sam@example.test'
    );
    expect(screen.getByTestId(profileTestIds.status)).toHaveTextContent(
      'Active'
    );
    expect(document.title).toBe('Profile');
  });

  it('VT-02 PBI-019 AC-1 shows a retryable error without technical detail, then the profile', async () => {
    const user = userEvent.setup();
    let calls = 0;
    installFetch(() => {
      calls += 1;
      return calls === 1 ? problemResponse(500) : jsonResponse(sampleProfile);
    });
    renderApp('/profile');

    expect(await screen.findByTestId(profileTestIds.error)).toHaveTextContent(
      "We couldn't load your profile"
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toHaveAttribute(
      'data-testid',
      profileTestIds.retry
    );
    expectNoTechnicalDetail();

    await user.click(screen.getByTestId(profileTestIds.retry));

    expect(
      await screen.findByTestId(profileTestIds.displayName)
    ).toHaveTextContent('Sam Example');
  });

  it('VT-03 PBI-019 AC-2 a null email shows the empty copy, not null or a blank value', async () => {
    installFetch(() => jsonResponse({ ...sampleProfile, email: null }));
    renderApp('/profile');

    const empty = await screen.findByTestId(profileTestIds.emailEmpty);
    expect(empty).toHaveTextContent('No email on file');
    expect(empty.textContent?.trim()).not.toBe('');
    expect(screen.queryByText('null')).not.toBeInTheDocument();
    expect(screen.queryByTestId(profileTestIds.email)).not.toBeInTheDocument();
  });

  it('VT-03 PBI-019 AC-2 a blank email string on the loaded profile shows the empty copy', async () => {
    const client = createTestQueryClient();
    client.setQueryDefaults(profileKeys.me, { staleTime: Infinity });
    client.setQueryData(profileKeys.me, { ...sampleProfile, email: '' });
    renderApp('/profile', client);

    const empty = await screen.findByTestId(profileTestIds.emailEmpty);
    expect(empty).toHaveTextContent('No email on file');
    expect(empty.textContent?.trim()).not.toBe('');
    expect(screen.queryByText('null')).not.toBeInTheDocument();
  });

  it('VT-04 PBI-019 AC-3 a 401 tells the user to sign in and shows no profile data', async () => {
    installFetch(() => problemResponse(401));
    renderApp('/profile');

    const alert = await screen.findByTestId(profileTestIds.unauthenticated);
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('Sign in to view your profile');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(profileTestIds.displayName)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(sampleProfile.displayName)
    ).not.toBeInTheDocument();
    expect(screen.queryByText('sam@example.test')).not.toBeInTheDocument();
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
    expectNoTechnicalDetail();
  });

  it('VT-04 PBI-019 AC-3 a 401 refetch clears cached profile data', async () => {
    const client = createTestQueryClient();
    client.setQueryData(profileKeys.me, sampleProfile);
    const calls = installFetch(() => problemResponse(401));
    renderApp('/profile', client);

    expect(
      await screen.findByTestId(profileTestIds.unauthenticated)
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(client.getQueryData(profileKeys.me)).toBeUndefined();
    });
    expect(
      screen.queryByText(sampleProfile.displayName)
    ).not.toBeInTheDocument();
    expect(calls.length).toBe(1);
  });

  it('PBI-019 a failed background refetch keeps the profile on screen', async () => {
    let calls = 0;
    installFetch(() => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(sampleProfile);
      }
      return problemResponse(500);
    });
    const { client } = renderApp('/profile');
    expect(
      await screen.findByTestId(profileTestIds.displayName)
    ).toHaveTextContent('Sam Example');

    await client.invalidateQueries({ queryKey: profileKeys.me });

    await waitFor(() => {
      expect(calls).toBeGreaterThanOrEqual(2);
    });
    expect(screen.getByTestId(profileTestIds.displayName)).toHaveTextContent(
      'Sam Example'
    );
    expect(screen.queryByTestId(profileTestIds.error)).not.toBeInTheDocument();
  });

  it('VT-15 PBI-021 AC-2 loading is a status region and the empty email is read with its label', async () => {
    const gate = deferred<Response>();
    installFetch(() => gate.promise);
    renderApp('/profile');

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Loading your profile…'
    );

    gate.resolve(jsonResponse({ ...sampleProfile, email: null }));
    const value = await screen.findByTestId(profileTestIds.emailEmpty);
    expect(value.tagName).toBe('DD');
    expect(value).toHaveTextContent('No email on file');
    const label = screen.getByText('Email');
    expect(label.tagName).toBe('DT');
    expect(value.closest('dl')).toContainElement(label);
  });
});
