// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { deferred } from '../../testing/fetchMock';
import { renderApp } from '../../testing/renderApp';
import { profileTestIds } from './profileTestIds';

const profile = {
  displayName: 'test-name-loaded',
  email: 'test-loaded@example.test',
  status: 'active' as const,
};

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'bypass' });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

function problem(status: number) {
  return HttpResponse.json(
    {
      type:
        status === 401
          ? 'urn:problem-type:authentication-required'
          : 'urn:problem-type:internal-error',
      title: 'Request failed',
      status,
      detail: 'The request failed.',
      requestId: 'test-request-id',
    },
    { status, headers: { 'Content-Type': 'application/problem+json' } }
  );
}

describe('profile screen at the network edge (TBI-023)', () => {
  it('DoD-1 shows loading, then the loaded profile', async () => {
    const gate = deferred<void>();
    server.use(
      http.get('*/api/v1/me', async () => {
        await gate.promise;
        return HttpResponse.json(profile);
      })
    );
    renderApp('/profile');
    expect(await screen.findByTestId(profileTestIds.loading)).toBeVisible();
    gate.resolve();
    expect(
      await screen.findByTestId(profileTestIds.displayName)
    ).toHaveTextContent(profile.displayName);
    expect(screen.getByTestId(profileTestIds.email)).toHaveTextContent(
      profile.email
    );
  });

  it('DoD-1 shows an empty email as a clear empty value', async () => {
    server.use(
      http.get('*/api/v1/me', () =>
        HttpResponse.json({ ...profile, email: null })
      )
    );
    renderApp('/profile');
    expect(
      await screen.findByTestId(profileTestIds.emailEmpty)
    ).toHaveTextContent('No email on file');
  });

  it('DoD-1 a load error offers retry and then shows the profile', async () => {
    let calls = 0;
    server.use(
      http.get('*/api/v1/me', () => {
        calls += 1;
        return calls === 1 ? problem(500) : HttpResponse.json(profile);
      })
    );
    const user = userEvent.setup();
    renderApp('/profile');
    expect(await screen.findByTestId(profileTestIds.error)).toBeVisible();
    await user.click(screen.getByTestId(profileTestIds.retry));
    expect(
      await screen.findByTestId(profileTestIds.displayName)
    ).toHaveTextContent(profile.displayName);
  });

  it('DoD-1 a valid save shows the updated profile', async () => {
    let current: {
      displayName: string;
      email: string | null;
      status: 'active';
    } = profile;
    server.use(
      http.get('*/api/v1/me', () => HttpResponse.json(current)),
      http.put('*/api/v1/me', async ({ request }) => {
        const body = (await request.json()) as {
          displayName: string;
          email: string | null;
        };
        current = {
          ...current,
          displayName: body.displayName,
          email: body.email ?? null,
        };
        return HttpResponse.json(current);
      })
    );
    const user = userEvent.setup();
    renderApp('/profile/details/edit');
    const name = await screen.findByTestId(profileTestIds.displayNameInput);
    await user.clear(name);
    await user.type(name, 'test-name-saved');
    await user.click(screen.getByTestId(profileTestIds.saveButton));
    expect(
      await screen.findByTestId(profileTestIds.displayName)
    ).toHaveTextContent('test-name-saved');
  });

  it('DoD-1 an empty display name focuses the first invalid field and sends nothing', async () => {
    let puts = 0;
    server.use(
      http.get('*/api/v1/me', () => HttpResponse.json(profile)),
      http.put('*/api/v1/me', () => {
        puts += 1;
        return HttpResponse.json(profile);
      })
    );
    const user = userEvent.setup();
    renderApp('/profile/details/edit');
    const name = await screen.findByTestId(profileTestIds.displayNameInput);
    await user.clear(name);
    await user.click(screen.getByTestId(profileTestIds.saveButton));
    await waitFor(() => {
      expect(name).toHaveAttribute('aria-invalid', 'true');
    });
    expect(name).toHaveFocus();
    expect(puts).toBe(0);
  });

  it('DoD-1 a save failure keeps the typed values', async () => {
    server.use(
      http.get('*/api/v1/me', () => HttpResponse.json(profile)),
      http.put('*/api/v1/me', () => problem(500))
    );
    const user = userEvent.setup();
    renderApp('/profile/details/edit');
    const name = await screen.findByTestId(profileTestIds.displayNameInput);
    const email = screen.getByTestId(profileTestIds.emailInput);
    await user.clear(name);
    await user.type(name, 'test-name-kept');
    await user.clear(email);
    await user.type(email, 'test-kept@example.test');
    await user.click(screen.getByTestId(profileTestIds.saveButton));
    expect(await screen.findByTestId(profileTestIds.saveError)).toBeVisible();
    expect(name).toHaveValue('test-name-kept');
    expect(email).toHaveValue('test-kept@example.test');
  });

  it('DoD-1 an unauthenticated response shows the sign-in message', async () => {
    server.use(http.get('*/api/v1/me', () => problem(401)));
    renderApp('/profile');
    expect(
      await screen.findByTestId(profileTestIds.unauthenticated)
    ).toHaveTextContent('Sign in to view your profile');
  });
});
