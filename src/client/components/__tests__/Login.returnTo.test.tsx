import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Login } from '../Login';

jest.mock('../BrandLogo', () => ({
  BrandLogo: () => <div data-testid="brand-logo">Apex</div>,
}));

function mockJsonResponse(body: unknown, ok = true) {
  return Promise.resolve({
    ok,
    json: async () => body,
  } as Response);
}

describe('Login — returnTo deep link', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        pathname: '/ui-lab/design-1',
        search: '?project=MaxView',
        hash: '',
        href: 'http://localhost:3000/ui-lab/design-1?project=MaxView',
        origin: 'http://localhost:3000',
        assign: jest.fn(),
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  it('starts SSO with the current internal path as returnTo', async () => {
    (global.fetch as jest.Mock) = jest.fn(async (url: string) => {
      if (String(url).includes('/auth/status')) {
        return mockJsonResponse({ authenticated: false });
      }
      if (String(url).includes('/auth/dev-login-available')) {
        return mockJsonResponse({ available: false });
      }
      return mockJsonResponse({});
    });

    render(<Login />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sign in with amergis sso/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /sign in with amergis sso/i }));
    expect(window.location.href).toContain('/auth/login?returnTo=');
    expect(decodeURIComponent(String(window.location.href))).toContain(
      '/ui-lab/design-1?project=MaxView',
    );
  });
});
