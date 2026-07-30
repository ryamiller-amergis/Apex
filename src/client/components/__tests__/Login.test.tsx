import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Login } from '../Login';

jest.mock('../BrandLogo', () => ({
  BrandLogo: () => <div data-testid="brand-logo">Apex</div>,
}));

jest.mock('../../config/release', () => ({
  IS_BETA_RELEASE: false,
}));

function mockJsonResponse(body: unknown, ok = true): Promise<Response> {
  return Promise.resolve({
    ok,
    json: async () => body,
  } as Response);
}

describe('Login — split gate', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, href: 'http://localhost/' },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  it('shows checking state in the split layout while auth status loads', async () => {
    let resolveAuth!: (value: Response) => void;
    const authPromise = new Promise<Response>((resolve) => {
      resolveAuth = resolve;
    });

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/status')) return authPromise;
      if (url.includes('/auth/dev-login-available')) {
        return mockJsonResponse({ available: false });
      }
      return mockJsonResponse({});
    }) as jest.Mock;

    render(<Login />);

    expect(screen.getByTestId('login-split')).toBeInTheDocument();
    expect(screen.getByText('Checking authentication...')).toBeInTheDocument();
    expect(screen.getByTestId('brand-logo')).toBeInTheDocument();

    resolveAuth({
      ok: true,
      json: async () => ({ authenticated: false }),
    } as Response);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    });
  });

  it('renders brand panel and action panel with SSO CTA', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/status')) {
        return mockJsonResponse({ authenticated: false });
      }
      if (url.includes('/auth/dev-login-available')) {
        return mockJsonResponse({ available: false });
      }
      return mockJsonResponse({});
    }) as jest.Mock;

    render(<Login />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    });

    expect(screen.getByTestId('login-brand-panel')).toBeInTheDocument();
    expect(screen.getByTestId('login-action-panel')).toBeInTheDocument();
    expect(screen.getByTestId('brand-logo')).toBeInTheDocument();
    expect(screen.getByText('Continue with your Amergis account.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in with amergis sso/i })).toBeInTheDocument();
    expect(screen.queryByText(/interviews/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/prds/i)).not.toBeInTheDocument();
  });

  it('navigates to /auth/login when SSO button is clicked', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/status')) {
        return mockJsonResponse({ authenticated: false });
      }
      if (url.includes('/auth/dev-login-available')) {
        return mockJsonResponse({ available: false });
      }
      return mockJsonResponse({});
    }) as jest.Mock;

    render(<Login />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sign in with amergis sso/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /sign in with amergis sso/i }));
    expect(window.location.href).toBe('/auth/login');
  });

  it('shows dev persona buttons when dev login is available', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/status')) {
        return mockJsonResponse({ authenticated: false });
      }
      if (url.includes('/auth/dev-login-available')) {
        return mockJsonResponse({
          available: true,
          personas: [
            { id: 'developer', label: 'Developer', displayName: 'Dev User' },
            { id: 'ba', label: 'BA', displayName: 'BA Dev User' },
          ],
        });
      }
      return mockJsonResponse({});
    }) as jest.Mock;

    render(<Login />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Developer' })).toBeInTheDocument();
    });

    expect(screen.getByText('or sign in as')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'BA' })).toBeInTheDocument();
  });

  it('posts the selected persona and redirects on successful dev login', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/auth/status')) {
        return mockJsonResponse({ authenticated: false });
      }
      if (url.includes('/auth/dev-login-available')) {
        return mockJsonResponse({
          available: true,
          personas: [{ id: 'developer', label: 'Developer', displayName: 'Dev User' }],
        });
      }
      if (url.includes('/auth/dev-login') && init?.method === 'POST') {
        return mockJsonResponse({ ok: true });
      }
      return mockJsonResponse({});
    }) as jest.Mock;

    render(<Login />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Developer' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Developer' }));

    await waitFor(() => {
      expect(window.location.href).toBe('/');
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/auth/dev-login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ persona: 'developer' }),
      }),
    );
  });
});
