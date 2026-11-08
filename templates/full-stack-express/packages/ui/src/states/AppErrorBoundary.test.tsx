import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppThemeProvider } from '../theme/AppThemeProvider.js';
import {
  APP_ERROR_MESSAGE,
  AppErrorBoundary,
  type AppErrorBoundaryProps,
} from './AppErrorBoundary.js';

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

function renderBoundary(
  children: React.ReactNode,
  props: Omit<AppErrorBoundaryProps, 'children'> = {}
) {
  return render(
    <AppThemeProvider>
      <AppErrorBoundary {...props}>{children}</AppErrorBoundary>
    </AppThemeProvider>
  );
}

describe('AppErrorBoundary', () => {
  it('VT-10 PBI-018 AC-1 TBI-021 DoD-1 shows a recoverable error state and recovers on retry', async () => {
    let shouldThrow = true;
    const Flaky: React.FC = () => {
      if (shouldThrow) {
        throw new Error('render failed');
      }
      return <p>Recovered content</p>;
    };
    renderBoundary(<Flaky />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(APP_ERROR_MESSAGE);
    const retry = screen.getByTestId('error-state-retry');
    expect(retry).toHaveAccessibleName('Try again');

    shouldThrow = false;
    await userEvent.click(retry);

    expect(screen.getByText('Recovered content')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('VT-18 PBI-018 AC-1 clears the error when resetKeys change, without a retry click', async () => {
    const Page: React.FC<{ path: string }> = ({ path }) => {
      if (path === '/a') {
        throw new Error('page a failed');
      }
      return <p>Page {path}</p>;
    };
    const Host: React.FC = () => {
      const [path, setPath] = useState('/a');
      return (
        <>
          <button type="button" onClick={() => setPath('/b')}>
            go to b
          </button>
          <AppErrorBoundary resetKeys={[path]}>
            <Page path={path} />
          </AppErrorBoundary>
        </>
      );
    };
    render(
      <AppThemeProvider>
        <Host />
      </AppThemeProvider>
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'go to b' }));

    expect(screen.getByText('Page /b')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByTestId('error-state-retry')).not.toBeInTheDocument();
  });

  it('VT-22 BR-007 never renders the thrown message and passes the error to onError', () => {
    const thrown = new Error('synthetic.user@example.test');
    const Leaky: React.FC = () => {
      throw thrown;
    };
    const onError = vi.fn();
    renderBoundary(<Leaky />, { onError });

    expect(document.body.textContent).not.toContain(
      'synthetic.user@example.test'
    );
    expect(screen.getByRole('alert')).toHaveTextContent(APP_ERROR_MESSAGE);
    expect(onError).toHaveBeenCalledWith(
      thrown,
      expect.objectContaining({ componentStack: expect.any(String) })
    );
  });
});
