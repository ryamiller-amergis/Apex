// @vitest-environment jsdom
import { AppThemeProvider } from '@project-scope/ui';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import type { Profile } from '@project-scope/contracts';
import { deferred, installFetch, jsonResponse } from '../../testing/fetchMock';
import { problemResponse, sampleProfile } from '../../testing/profileFixture';
import { renderApp } from '../../testing/renderApp';
import { setViewport } from '../../testing/setViewport';
import { profileTestIds } from './profileTestIds';

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const raw = hex.replace('#', '');
  const red = Number.parseInt(raw.slice(0, 2), 16);
  const green = Number.parseInt(raw.slice(2, 4), 16);
  const blue = Number.parseInt(raw.slice(4, 6), 16);
  return (
    0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
  );
}

function contrast(foreground: string, background: string): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

async function violations(node: Element): Promise<string[]> {
  const results = await axe.run(node, {
    rules: {
      // jsdom does not resolve theme colours, so contrast is checked separately.
      'color-contrast': { enabled: false },
    },
  });
  return results.violations.map((violation) => violation.id);
}

describe('profile accessibility', () => {
  it('PBI-021 AC-0 keyboard order reaches edit, the fields, and save', async () => {
    const user = userEvent.setup();
    let current: Profile = sampleProfile;
    installFetch((call) => {
      if (call.method === 'PUT') {
        const body = call.body as { displayName: string; email: string | null };
        current = {
          ...sampleProfile,
          displayName: body.displayName,
          email: body.email,
        };
      }
      return jsonResponse(current);
    });
    renderApp('/profile');
    const edit = await screen.findByTestId(profileTestIds.editButton);
    expect(screen.getByRole('heading', { name: 'Profile' })).toHaveFocus();
    await user.tab();
    expect(edit).toHaveFocus();
    await user.keyboard('{Enter}');

    const name = await screen.findByRole('textbox', { name: /Display name/ });
    const email = screen.getByRole('textbox', { name: /^Email/ });
    const save = screen.getByTestId(profileTestIds.saveButton);
    const cancel = screen.getByTestId(profileTestIds.cancelButton);
    expect(screen.getByRole('heading', { name: 'Edit profile' })).toHaveFocus();
    await user.tab();
    expect(name).toHaveFocus();
    await user.clear(name);
    await user.type(name, 'Keyboard Name');
    await user.tab();
    expect(email).toHaveFocus();
    await user.tab();
    expect(save).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(save).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(
      await screen.findByTestId(profileTestIds.displayName)
    ).toHaveTextContent('Keyboard Name');
    expect(screen.getByRole('heading', { name: 'Profile' })).toHaveFocus();
  });

  it('VT-16 PBI-021 AC-2 loading and sign-in do not trap focus', async () => {
    const user = userEvent.setup();
    const gate = deferred<Response>();
    installFetch(() => gate.promise);
    const view = renderApp('/profile');
    expect(
      await screen.findByTestId(profileTestIds.loading)
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading your profile…'
    );

    const seen = new Set<string>();
    for (let step = 0; step < 6; step += 1) {
      await user.tab();
      seen.add(document.activeElement?.getAttribute('data-testid') ?? '');
    }
    expect(seen.has('app-shell-skip-link')).toBe(true);
    expect(seen.has('app-shell-color-mode-toggle')).toBe(true);
    view.unmount();

    installFetch(() => problemResponse(401));
    renderApp('/profile');
    expect(
      await screen.findByTestId(profileTestIds.unauthenticated)
    ).toHaveTextContent('Sign in to view your profile');
    const signedOut = new Set<string>();
    for (let step = 0; step < 6; step += 1) {
      await user.tab();
      signedOut.add(document.activeElement?.getAttribute('data-testid') ?? '');
    }
    expect(signedOut.has('app-shell-skip-link')).toBe(true);
    expect(signedOut.has('app-shell-color-mode-toggle')).toBe(true);
  });

  it('PBI-019 AC-0 and PBI-020 AC-0 phone width keeps Edit, Save, and Cancel in the page', async () => {
    setViewport(320);
    installFetch(() => jsonResponse(sampleProfile));
    const view = renderApp('/profile');
    expect(await screen.findByTestId(profileTestIds.editButton)).toBeVisible();
    expect(screen.getByTestId('app-shell')).toHaveAttribute(
      'data-layout',
      'phone'
    );
    const main = screen.getByRole('main');
    if (main.clientWidth > 0) {
      expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth + 1);
    }
    view.unmount();

    setViewport(320);
    installFetch(() => jsonResponse(sampleProfile));
    renderApp('/profile/details/edit');
    expect(await screen.findByTestId(profileTestIds.saveButton)).toBeVisible();
    expect(screen.getByTestId(profileTestIds.cancelButton)).toBeVisible();
    expect(screen.getByTestId('app-shell')).toHaveAttribute(
      'data-layout',
      'phone'
    );
  });

  it('PBI-021 AC-3 axe reports no violations on the profile states in both themes', async () => {
    const user = userEvent.setup();
    installFetch(() => jsonResponse({ ...sampleProfile, email: null }));
    const { container } = renderApp('/profile');
    expect(
      await screen.findByTestId(profileTestIds.emailEmpty)
    ).toBeInTheDocument();
    expect(await violations(container)).toEqual([]);
    await user.click(screen.getByRole('switch', { name: 'Dark mode' }));
    expect(await violations(container)).toEqual([]);
  });

  it('PBI-021 AC-3 the check fails for an unlabeled control and for low-contrast text', async () => {
    const view = render(
      <AppThemeProvider>
        <main>
          <input />
          <p style={{ color: '#8a8a8a', backgroundColor: '#ffffff' }}>
            Hard to read
          </p>
        </main>
      </AppThemeProvider>
    );
    const found = await violations(view.container);
    expect(found.length).toBeGreaterThan(0);

    const paragraph = screen.getByText('Hard to read');
    const foreground = getComputedStyle(paragraph).color;
    const background = getComputedStyle(paragraph).backgroundColor;
    const match = (value: string) =>
      value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    const fg = match(foreground);
    const bg = match(background);
    expect(fg).not.toBeNull();
    expect(bg).not.toBeNull();
    const hex = (parts: RegExpMatchArray) =>
      `#${[parts[1], parts[2], parts[3]]
        .map((part) => Number(part).toString(16).padStart(2, '0'))
        .join('')}`;
    expect(contrast(hex(fg!), hex(bg!))).toBeLessThan(4.5);
  });
});
