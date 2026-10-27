// @vitest-environment jsdom
import {
  displayNameMaxLength,
  displayNameSchema,
  emailSchema,
  type Profile,
} from '@project-scope/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  deferred,
  installFetch,
  jsonResponse,
  type FetchCall,
} from '../../testing/fetchMock';
import {
  problemResponse,
  sampleProfile,
  SECRET_PROBLEM_DETAIL,
  SECRET_PROBLEM_TITLE,
  SECRET_REQUEST_ID,
} from '../../testing/profileFixture';
import { renderApp } from '../../testing/renderApp';
import { profileTestIds } from './profileTestIds';

function schemaMessage(parsed: {
  success: boolean;
  error?: { issues: { message: string }[] };
}): string {
  const message = parsed.success ? undefined : parsed.error?.issues[0]?.message;
  if (!message) {
    throw new Error('expected a schema message');
  }
  return message;
}

function puts(calls: FetchCall[]): FetchCall[] {
  return calls.filter((call) => call.method === 'PUT');
}

async function openEditor(calls: FetchCall[]): Promise<void> {
  expect(await screen.findByTestId(profileTestIds.form)).toBeInTheDocument();
  expect(calls.some((call) => call.url.includes('?'))).toBe(false);
}

describe('ProfileEditPage', () => {
  it('VT-06 PBI-020 AC-0 saves a new display name and shows it without waiting for the next read', async () => {
    const followUp = deferred<Response>();
    let gets = 0;
    const updated = { ...sampleProfile, displayName: 'Sam Updated' };
    const calls = installFetch((call) => {
      if (call.method === 'PUT') {
        return jsonResponse(updated);
      }
      gets += 1;
      return gets === 1 ? jsonResponse(sampleProfile) : followUp.promise;
    });
    const user = userEvent.setup();
    renderApp('/profile/details/edit');
    await openEditor(calls);

    const name = screen.getByRole('textbox', { name: /Display name/ });
    await user.clear(name);
    await user.type(name, 'Sam Updated');
    await user.click(screen.getByTestId(profileTestIds.saveButton));

    expect(
      await screen.findByTestId(profileTestIds.savedMessage)
    ).toHaveAttribute('role', 'status');
    expect(screen.getByTestId(profileTestIds.savedMessage)).toHaveTextContent(
      'Your profile was saved.'
    );
    expect(screen.getByTestId('current-path')).toHaveTextContent('/profile');
    expect(screen.getByTestId(profileTestIds.displayName)).toHaveTextContent(
      'Sam Updated'
    );
    expect(screen.getByRole('heading', { name: 'Profile' })).toHaveFocus();
    expect(puts(calls)).toHaveLength(1);
    expect(puts(calls)[0]?.body).toEqual({
      displayName: 'Sam Updated',
      email: sampleProfile.email,
    });
    expect(gets).toBeGreaterThanOrEqual(2);
    followUp.resolve(jsonResponse(updated));
  });

  it('VT-05 PBI-019 NFR and PBI-020 NFR requests stay on /api/v1/me and send only display name and email', async () => {
    const calls = installFetch((call) =>
      jsonResponse(
        call.method === 'PUT'
          ? { ...sampleProfile, displayName: 'Renamed Person' }
          : sampleProfile
      )
    );
    const user = userEvent.setup();
    renderApp('/profile');
    await user.click(await screen.findByTestId(profileTestIds.editButton));
    const name = await screen.findByRole('textbox', { name: /Display name/ });
    await user.clear(name);
    await user.type(name, 'Renamed Person');
    await user.click(screen.getByTestId(profileTestIds.saveButton));
    await screen.findByTestId(profileTestIds.savedMessage);

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url).toBe('/api/v1/me');
      expect(call.url.includes('?')).toBe(false);
      const serialized = JSON.stringify(call.body ?? {});
      expect(serialized).not.toContain('subject');
      expect(serialized).not.toContain('externalSubject');
      expect(serialized).not.toContain('"id"');
    }
    const put = puts(calls)[0];
    expect(Object.keys(put?.body as object).sort()).toEqual([
      'displayName',
      'email',
    ]);
  });

  it('VT-07 PBI-020 AC-1 keeps entered values and retries the same body after a save failure', async () => {
    let current: Profile = sampleProfile;
    let putsSeen = 0;
    const calls = installFetch((call) => {
      if (call.method !== 'PUT') {
        return jsonResponse(current);
      }
      putsSeen += 1;
      if (putsSeen === 1) {
        return problemResponse(500);
      }
      current = {
        ...sampleProfile,
        displayName: 'Kept Name',
        email: 'kept@example.test',
      };
      return jsonResponse(current);
    });
    const user = userEvent.setup();
    renderApp('/profile/details/edit');
    await openEditor(calls);

    const name = screen.getByRole('textbox', { name: /Display name/ });
    const email = screen.getByRole('textbox', { name: /^Email/ });
    await user.clear(name);
    await user.type(name, 'Kept Name');
    await user.clear(email);
    await user.type(email, 'kept@example.test');
    await user.click(screen.getByTestId(profileTestIds.saveButton));

    const alert = await screen.findByTestId(profileTestIds.saveError);
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent(
      "We couldn't save your changes. Your entries are still here."
    );
    await waitFor(() => expect(alert).toHaveFocus());
    expect(screen.getByTestId(profileTestIds.form)).toHaveAttribute(
      'aria-describedby',
      'profile-save-error-text'
    );
    expect(name).toHaveValue('Kept Name');
    expect(email).toHaveValue('kept@example.test');
    expect(document.body.textContent).not.toContain(SECRET_PROBLEM_TITLE);
    expect(document.body.textContent).not.toContain(SECRET_PROBLEM_DETAIL);
    expect(document.body.textContent).not.toContain(SECRET_REQUEST_ID);

    await user.click(screen.getByTestId(profileTestIds.saveRetry));
    expect(
      await screen.findByTestId(profileTestIds.displayName)
    ).toHaveTextContent('Kept Name');
    expect(puts(calls).map((call) => call.body)).toEqual([
      { displayName: 'Kept Name', email: 'kept@example.test' },
      { displayName: 'Kept Name', email: 'kept@example.test' },
    ]);
  });

  it('VT-08 PBI-020 AC-2 a cleared email is sent as null', async () => {
    let current: Profile = sampleProfile;
    const calls = installFetch((call) => {
      if (call.method === 'PUT') {
        const body = call.body as { displayName: string; email: string | null };
        current = {
          ...sampleProfile,
          displayName: body.displayName,
          email: body.email,
        };
        return jsonResponse(current);
      }
      return jsonResponse(current);
    });
    const user = userEvent.setup();
    renderApp('/profile/details/edit');
    await openEditor(calls);
    await user.clear(screen.getByRole('textbox', { name: /^Email/ }));
    await user.click(screen.getByTestId(profileTestIds.saveButton));

    await screen.findByTestId(profileTestIds.emailEmpty);
    expect(puts(calls)[0]?.body).toEqual({
      displayName: sampleProfile.displayName,
      email: null,
    });
  });

  it('VT-08 PBI-020 AC-2 the contract maximum display name is accepted', async () => {
    const nameValue = 'A'.repeat(displayNameMaxLength);
    let current: Profile = sampleProfile;
    const calls = installFetch((call) => {
      if (call.method === 'PUT') {
        const body = call.body as { displayName: string; email: string | null };
        current = {
          ...sampleProfile,
          displayName: body.displayName,
          email: body.email,
        };
        return jsonResponse(current);
      }
      return jsonResponse(current);
    });
    const user = userEvent.setup();
    renderApp('/profile/details/edit');
    await openEditor(calls);
    const name = screen.getByRole('textbox', { name: /Display name/ });
    await user.clear(name);
    await user.paste(nameValue);
    await user.click(screen.getByTestId(profileTestIds.saveButton));

    expect(
      await screen.findByTestId(profileTestIds.displayName)
    ).toHaveTextContent(nameValue);
    expect(puts(calls)[0]?.body).toEqual({
      displayName: nameValue,
      email: sampleProfile.email,
    });
  });

  it('VT-08 PBI-020 AC-2 one character over the maximum shows a field error and sends nothing', async () => {
    const calls = installFetch(() => jsonResponse(sampleProfile));
    const user = userEvent.setup();
    renderApp('/profile/details/edit');
    await openEditor(calls);
    const tooLong = 'A'.repeat(displayNameMaxLength + 1);
    const message = schemaMessage(displayNameSchema.safeParse(tooLong));
    const name = screen.getByRole('textbox', { name: /Display name/ });
    expect(name).not.toHaveAttribute('maxLength');
    await user.clear(name);
    await user.paste(tooLong);

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(puts(calls)).toHaveLength(0);
    expect(screen.getByTestId('current-path')).toHaveTextContent(
      '/profile/details/edit'
    );
  });

  it('VT-09 PBI-020 AC-3 an empty display name or a malformed email sends nothing and focuses the first invalid field', async () => {
    const calls = installFetch(() => jsonResponse(sampleProfile));
    const user = userEvent.setup();
    renderApp('/profile/details/edit');
    await openEditor(calls);
    const name = screen.getByRole('textbox', { name: /Display name/ });
    const email = screen.getByRole('textbox', { name: /^Email/ });
    const emptyName = schemaMessage(displayNameSchema.safeParse(''));
    const badEmail = schemaMessage(emailSchema.safeParse('not-an-email'));

    await user.clear(name);
    await user.click(screen.getByTestId(profileTestIds.saveButton));
    expect(await screen.findByRole('alert')).toHaveTextContent(emptyName);
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveFocus();
    expect(puts(calls)).toHaveLength(0);

    await user.type(name, 'Sam Example');
    await user.clear(email);
    await user.type(email, 'not-an-email');
    await user.click(screen.getByTestId(profileTestIds.saveButton));
    expect(await screen.findByText(badEmail)).toBeInTheDocument();
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(email).toHaveFocus();
    expect(puts(calls)).toHaveLength(0);

    await user.clear(name);
    await user.click(screen.getByTestId(profileTestIds.saveButton));
    expect(name).toHaveFocus();
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(puts(calls)).toHaveLength(0);
  });

  it('VT-10 PBI-020 AC-1 a validation problem names the email field and keeps the values', async () => {
    const message = 'The value does not have the required format.';
    const calls = installFetch((call) => {
      if (call.method === 'PUT') {
        return problemResponse(400, [
          { pointer: '/email', code: 'invalid_format', message },
        ]);
      }
      return jsonResponse(sampleProfile);
    });
    const user = userEvent.setup();
    renderApp('/profile/details/edit');
    await openEditor(calls);
    const name = screen.getByRole('textbox', { name: /Display name/ });
    const email = screen.getByRole('textbox', { name: /^Email/ });
    await user.clear(email);
    await user.type(email, 'ada@example.test');
    await user.click(screen.getByTestId(profileTestIds.saveButton));

    expect(await screen.findByText(message)).toBeInTheDocument();
    await waitFor(() => expect(email).toHaveFocus());
    expect(email).toHaveAccessibleDescription(message);
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(name).not.toHaveAttribute('aria-invalid', 'true');
    expect(email).toHaveValue('ada@example.test');
    expect(
      screen.queryByTestId(profileTestIds.saveError)
    ).not.toBeInTheDocument();
  });

  it('VT-11 PBI-020 AC-3 a 401 on save shows sign-in text, no retry, and keeps the values', async () => {
    const calls = installFetch((call) =>
      call.method === 'PUT' ? problemResponse(401) : jsonResponse(sampleProfile)
    );
    const user = userEvent.setup();
    renderApp('/profile/details/edit');
    await openEditor(calls);
    const name = screen.getByRole('textbox', { name: /Display name/ });
    await user.clear(name);
    await user.type(name, 'Still Here');
    await user.click(screen.getByTestId(profileTestIds.saveButton));

    const alert = await screen.findByTestId(profileTestIds.saveError);
    expect(alert).toHaveTextContent('Sign in to save your profile.');
    expect(
      screen.queryByTestId(profileTestIds.saveRetry)
    ).not.toBeInTheDocument();
    expect(name).toHaveValue('Still Here');
    expect(screen.getByTestId(profileTestIds.form)).toBeInTheDocument();
  });

  it('VT-12 PBI-020 NFR a second submit while saving sends one request and keeps focus', async () => {
    const calls = installFetch((call) => {
      if (call.method === 'PUT') {
        return deferred<Response>().promise;
      }
      return jsonResponse(sampleProfile);
    });
    const user = userEvent.setup();
    renderApp('/profile/details/edit');
    await openEditor(calls);
    const save = screen.getByTestId(profileTestIds.saveButton);
    await user.click(save);
    expect(save).toHaveTextContent('Saving…');
    expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(save).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(puts(calls)).toHaveLength(1);
    expect(save).toHaveFocus();
    expect(save).not.toBeDisabled();
  });

  it('VT-14 PBI-021 AC-1 a field failure describes the input and a general failure describes the form', async () => {
    const message = 'The value does not have the required format.';
    let putsSeen = 0;
    const calls = installFetch((call) => {
      if (call.method !== 'PUT') {
        return jsonResponse(sampleProfile);
      }
      putsSeen += 1;
      return putsSeen === 1
        ? problemResponse(500)
        : problemResponse(400, [
            { pointer: '/email', code: 'invalid_format', message },
          ]);
    });
    const user = userEvent.setup();
    renderApp('/profile/details/edit');
    await openEditor(calls);
    await user.click(screen.getByTestId(profileTestIds.saveButton));

    const alert = await screen.findByTestId(profileTestIds.saveError);
    expect(alert).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId(profileTestIds.form)).toHaveAttribute(
      'aria-describedby',
      alert.id
    );

    await user.click(screen.getByTestId(profileTestIds.saveRetry));
    const email = screen.getByRole('textbox', { name: /^Email/ });
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(email).toHaveAccessibleDescription(message);
  });

  it('PBI-020 Cancel returns to the profile without saving', async () => {
    const calls = installFetch(() => jsonResponse(sampleProfile));
    const user = userEvent.setup();
    renderApp('/profile/details/edit');
    await openEditor(calls);
    await user.click(screen.getByTestId(profileTestIds.cancelButton));
    expect(
      await screen.findByTestId(profileTestIds.displayName)
    ).toHaveTextContent('Sam Example');
    expect(puts(calls)).toHaveLength(0);
    expect(screen.getByTestId('current-path')).toHaveTextContent('/profile');
  });

  it('PBI-019 NFR profile values are not written to browser storage or the console', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const writes: string[] = [];
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, value) => {
      writes.push(`${key}=${value}`);
    });
    installFetch((call) =>
      jsonResponse(
        call.method === 'PUT'
          ? { ...sampleProfile, displayName: 'Stored Name' }
          : sampleProfile
      )
    );
    const user = userEvent.setup();
    renderApp('/profile/details/edit');
    await openEditor([]);
    const name = screen.getByRole('textbox', { name: /Display name/ });
    await user.clear(name);
    await user.type(name, 'Stored Name');
    await user.click(screen.getByTestId(profileTestIds.saveButton));
    await screen.findByTestId(profileTestIds.savedMessage);

    const stored = writes.join('\n');
    expect(stored).not.toContain('sam@example.test');
    expect(stored).not.toContain('Stored Name');
    expect(stored).not.toContain('Sam Example');
    expect(log).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });
});
