import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { EmptyState } from '../states/EmptyState.js';
import { LoadingState } from '../states/LoadingState.js';
import { resolvedStyle } from '../testing/resolvedStyle.js';
import { setViewport } from '../testing/setViewport.js';
import { TEST_ID_PATTERN } from '../testing/testId.js';
import { AppThemeProvider } from '../theme/AppThemeProvider.js';
import { AppShell, type AppShellProps, type NavItem } from './AppShell.js';

const navItems: NavItem[] = [
  { id: 'home', label: 'Home', to: '/' },
  { id: 'profile', label: 'Profile', to: '/profile' },
  { id: 'settings', label: 'Settings', to: '/settings' },
];

function renderShell(
  props: Partial<AppShellProps> = {},
  { path = '/', children = <button type="button">Content action</button> } = {}
) {
  return render(
    <AppThemeProvider>
      <MemoryRouter initialEntries={[path]}>
        <AppShell appName="project-name" navItems={navItems} {...props}>
          {props.children ?? children}
        </AppShell>
      </MemoryRouter>
    </AppThemeProvider>
  );
}

describe('AppShell desktop layout', () => {
  it('VT-09 PBI-018 AC-0 renders landmarks and a permanent drawer; the skip link moves focus to main', async () => {
    setViewport(1280);
    renderShell();

    expect(screen.getByRole('banner')).toHaveAttribute(
      'data-testid',
      'app-shell-header'
    );
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getAllByRole('link')).toHaveLength(3);
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
    expect(screen.queryByTestId('app-shell-menu-button')).toBeNull();
    expect(screen.getByText('project-name')).toBeInTheDocument();

    await userEvent.tab();
    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    expect(skip).toHaveFocus();
    expect(skip).toHaveAttribute('data-testid', 'app-shell-skip-link');

    await userEvent.keyboard('{Enter}');
    expect(screen.getByTestId('app-shell-main')).toHaveFocus();
  });

  it('VT-16 TBI-021 NFR tab order is skip link, nav links, colour toggle, then main content', async () => {
    setViewport(1280);
    renderShell();

    const expected = [
      screen.getByRole('link', { name: 'Skip to main content' }),
      screen.getByRole('link', { name: 'Home' }),
      screen.getByRole('link', { name: 'Profile' }),
      screen.getByRole('link', { name: 'Settings' }),
      screen.getByRole('switch', { name: 'Dark mode' }),
      screen.getByRole('button', { name: 'Content action' }),
    ];
    for (const element of expected) {
      await userEvent.tab();
      expect(element).toHaveFocus();
    }
  });

  it('VT-17 PBI-018 AC-0 marks only the current nav item with aria-current', () => {
    setViewport(1280);
    renderShell({}, { path: '/profile' });

    expect(screen.getByTestId('app-shell-nav-item-profile')).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(screen.getByTestId('app-shell-nav-item-home')).not.toHaveAttribute(
      'aria-current'
    );
    expect(
      screen.getByTestId('app-shell-nav-item-settings')
    ).not.toHaveAttribute('aria-current');
  });

  it('renders header actions supplied by the host', () => {
    renderShell({ headerActions: <span>Signed in</span> });
    expect(within(screen.getByRole('banner')).getByText('Signed in'));
  });
});

describe('AppShell phone layout', () => {
  it('VT-11 PBI-018 AC-2 opens the drawer from the menu button and Escape returns focus', async () => {
    setViewport(320);
    renderShell();

    const menu = screen.getByRole('button', { name: 'Open navigation' });
    expect(menu).toHaveAttribute('data-testid', 'app-shell-menu-button');
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('navigation')).toBeNull();

    await userEvent.click(menu);

    expect(menu).toHaveAttribute('aria-expanded', 'true');
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('link', { name: 'Home' })).toHaveFocus();

    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('navigation')).toBeNull());
    expect(menu).toHaveFocus();
    expect(menu).toHaveAttribute('aria-expanded', 'false');
  });

  it('VT-11 closes the drawer on link activation and returns focus to the menu button', async () => {
    setViewport(320);
    renderShell();
    const menu = screen.getByTestId('app-shell-menu-button');

    await userEvent.click(menu);
    await userEvent.click(await screen.findByRole('link', { name: 'Profile' }));

    await waitFor(() => expect(screen.queryByRole('navigation')).toBeNull());
    expect(menu).toHaveFocus();
  });

  it('VT-11 offers a close button inside the drawer', async () => {
    setViewport(320);
    renderShell();
    await userEvent.click(screen.getByTestId('app-shell-menu-button'));

    await userEvent.click(
      await screen.findByRole('button', { name: 'Close navigation' })
    );

    await waitFor(() => expect(screen.queryByRole('navigation')).toBeNull());
    expect(screen.getByTestId('app-shell-menu-button')).toHaveFocus();
  });

  it('PBI-018 AC-2 main content can shrink and wraps long text instead of scrolling sideways', () => {
    setViewport(320);
    renderShell();
    const main = screen.getByTestId('app-shell-main');
    expect(resolvedStyle(main, 'min-width')).toBe('0px');
    expect(resolvedStyle(main, 'overflow-wrap')).toBe('anywhere');
  });
});

describe('AppShell breakpoints', () => {
  it.each([
    [320, 'temporary', '16px'],
    [599, 'temporary', '16px'],
    [600, 'temporary', '24px'],
    [899, 'temporary', '24px'],
    [900, 'permanent', '32px'],
    [1280, 'permanent', '32px'],
  ])(
    'VT-12 TBI-021 DoD-0 at %i px uses a %s drawer and %s content padding',
    (width, mode, padding) => {
      setViewport(width);
      renderShell();

      const menu = screen.queryByTestId('app-shell-menu-button');
      const nav = screen.queryByRole('navigation', { name: 'Primary' });
      if (mode === 'temporary') {
        expect(menu).toBeInTheDocument();
        expect(nav).toBeNull();
      } else {
        expect(menu).toBeNull();
        expect(nav).toBeInTheDocument();
      }
      expect(
        resolvedStyle(screen.getByTestId('app-shell-main'), 'padding-left')
      ).toBe(padding);
      expect(screen.getByTestId('app-shell')).toHaveAttribute(
        'data-layout',
        width < 600 ? 'phone' : width < 900 ? 'tablet' : 'desktop'
      );
    }
  );
});

describe('AppShell without navigation', () => {
  it.each([320, 1280])(
    'VT-23 PBI-018 AC-2 at %i px renders no navigation landmark and no menu button',
    (width) => {
      setViewport(width);
      renderShell({ navItems: [] });

      expect(screen.queryByRole('navigation')).toBeNull();
      expect(screen.queryByTestId('app-shell-menu-button')).toBeNull();
      expect(screen.getByRole('banner')).toBeInTheDocument();
      expect(screen.getByRole('main')).toBeInTheDocument();
    }
  );

  it('throws on duplicate nav item ids', () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    expect(() =>
      renderShell({
        navItems: [
          { id: 'home', label: 'Home', to: '/' },
          { id: 'home', label: 'Again', to: '/again' },
        ],
      })
    ).toThrow(/duplicate nav item id "home"/);
    consoleError.mockRestore();
  });
});

describe('AppShell selector convention', () => {
  function expectKebabTestIds(elements: HTMLElement[]) {
    expect(elements.length).toBeGreaterThan(0);
    for (const element of elements) {
      expect(element.getAttribute('data-testid')).toMatch(TEST_ID_PATTERN);
    }
  }

  it('VT-15 TBI-021 DoD-3 every button, link, and switch carries a kebab-case data-testid', async () => {
    setViewport(1280);
    renderShell({}, { children: <LoadingState /> });
    expectKebabTestIds([
      ...screen.getAllByRole('link'),
      ...screen.getAllByRole('switch'),
    ]);
    for (const id of [
      'app-shell',
      'app-shell-header',
      'app-shell-nav',
      'app-shell-main',
      'app-shell-color-mode-toggle',
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }

    setViewport(320);
    renderShell({}, { children: <EmptyState title="Nothing" /> });
    await userEvent.click(screen.getByTestId('app-shell-menu-button'));
    await screen.findByRole('navigation');
    expectKebabTestIds([
      ...screen.getAllByRole('button', { hidden: true }),
      ...screen.getAllByRole('link', { hidden: true }),
    ]);
  });
});

describe('AppShell content states', () => {
  it('VT-14 PBI-018 AC-3 main is never blank while a page switches between loading and empty', async () => {
    const Page: React.FC = () => {
      const [loaded, setLoaded] = useState(false);
      return loaded ? (
        <EmptyState title="No items yet" />
      ) : (
        <>
          <LoadingState />
          <button type="button" onClick={() => setLoaded(true)}>
            finish
          </button>
        </>
      );
    };
    renderShell({}, { children: <Page /> });
    const main = screen.getByTestId('app-shell-main');

    expect(within(main).getByRole('status')).toHaveTextContent('Loading');
    expect(main.textContent?.trim()).not.toBe('');

    await userEvent.click(screen.getByRole('button', { name: 'finish' }));

    expect(within(main).getByRole('status')).toHaveTextContent('No items yet');
    expect(main.textContent?.trim()).not.toBe('');
  });
});

describe('AppShell colour mode', () => {
  it('VT-08 PBI-017 AC-0 toggles the scheme without remounting children, then restores it', async () => {
    const Counter: React.FC = () => {
      const [count, setCount] = useState(0);
      return (
        <button type="button" onClick={() => setCount(count + 1)}>
          count {count}
        </button>
      );
    };
    const href = window.location.href;
    const { unmount } = renderShell({}, { children: <Counter /> });

    await userEvent.click(screen.getByRole('button', { name: 'count 0' }));
    const toggle = screen.getByTestId('app-shell-color-mode-toggle');
    expect(toggle).toHaveAccessibleName('Dark mode');
    expect(toggle).not.toBeChecked();

    await userEvent.click(toggle);

    expect(toggle).toBeChecked();
    expect(document.documentElement).toHaveAttribute(
      'data-mui-color-scheme',
      'dark'
    );
    expect(screen.getByRole('button', { name: 'count 1' })).toBeInTheDocument();
    expect(window.location.href).toBe(href);
    expect(window.localStorage.getItem('app-color-mode')).toBe('dark');

    unmount();
    renderShell();
    expect(screen.getByTestId('app-shell-color-mode-toggle')).toBeChecked();
    expect(document.documentElement).toHaveAttribute(
      'data-mui-color-scheme',
      'dark'
    );
  });
});
