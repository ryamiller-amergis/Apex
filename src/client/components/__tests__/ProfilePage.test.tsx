/**
 * FEAT-003 — Modern Profile Page tests.
 * Criterion ids (AC, DoD, VT) in names for Requirements → Test Matrix traceability.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProfilePage } from '../ProfilePage';
import type { CurrentProfileResponse } from '../../../shared/types/profile';
import type { NotificationPreference } from '../../../shared/types/notification';

const mockRefetch = jest.fn();
const mockMutateAsync = jest.fn();
const mockUpdatePrefMutate = jest.fn();

let profileQuery: {
  data: CurrentProfileResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: typeof mockRefetch;
};

let notificationQuery: {
  data: NotificationPreference[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: jest.Mock;
};

let updatePrefState: {
  mutate: typeof mockUpdatePrefMutate;
  isError: boolean;
  error: Error | null;
};

jest.mock('../../hooks/useProfile', () => ({
  useCurrentProfile: () => profileQuery,
  useUpdateCurrentProfile: () => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
    isError: false,
  }),
}));

jest.mock('../../hooks/useNotifications', () => ({
  useNotificationPreferences: () => notificationQuery,
  useUpdateNotificationPreference: () => updatePrefState,
}));

jest.mock('../AvatarEditor', () => ({
  AvatarEditor: ({
    displayName,
    uploadControlTestId,
    removeButtonTestId,
    avatarVersion,
  }: {
    displayName: string;
    uploadControlTestId?: string;
    removeButtonTestId?: string;
    avatarVersion?: string | null;
  }) => (
    <div data-testid="avatar-editor-mock">
      <span>{displayName}</span>
      <label data-testid={uploadControlTestId ?? 'avatar-upload-control'}>
        {avatarVersion ? 'Change photo' : 'Upload avatar'}
      </label>
      {avatarVersion ? (
        <button type="button" data-testid={removeButtonTestId ?? 'avatar-remove-open'}>
          Remove avatar
        </button>
      ) : null}
    </div>
  ),
}));

const baseProfile: CurrentProfileResponse = {
  userOid: 'oid-a',
  displayName: 'Ada Lovelace',
  email: 'ada@example.com',
  bio: null,
  avatar: { userOid: 'oid-a', version: null },
  updatedAt: null,
};

function renderPage(theme: 'amergis' | 'light' | 'neon' = 'amergis', onThemeChange = jest.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    onThemeChange,
    ...render(
      <QueryClientProvider client={client}>
        <ProfilePage theme={theme} onThemeChange={onThemeChange} />
      </QueryClientProvider>
    ),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  profileQuery = {
    data: baseProfile,
    isLoading: false,
    isError: false,
    refetch: mockRefetch,
  };
  notificationQuery = {
    data: [
      {
        id: '1',
        userId: 'oid-a',
        notificationType: 'user-action',
        enabled: true,
        toastEnabled: true,
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
      {
        id: '2',
        userId: 'oid-a',
        notificationType: 'ai',
        enabled: false,
        toastEnabled: true,
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
    ],
    isLoading: false,
    isError: false,
    error: null,
    refetch: jest.fn(),
  };
  updatePrefState = {
    mutate: mockUpdatePrefMutate,
    isError: false,
    error: null,
  };
});

describe('ProfilePage — TBI-005 DoD-0 / PBI-005 AC-0 / VT-01', () => {
  it('renders identity (with avatar), bio, theme, and notifications with read-only Azure AD identity', () => {
    renderPage();

    expect(screen.getByTestId('profile-page')).toBeInTheDocument();
    expect(screen.getByTestId('profile-identity-section')).toBeInTheDocument();
    expect(screen.getByTestId('profile-avatar-section')).toBeInTheDocument();
    expect(screen.getByTestId('profile-bio-section')).toBeInTheDocument();
    expect(screen.getByTestId('profile-theme-section')).toBeInTheDocument();
    expect(screen.getByTestId('profile-notification-section')).toBeInTheDocument();

    // Avatar lives inside the merged Identity card, not as a sibling section.
    expect(screen.getByTestId('profile-identity-section')).toContainElement(
      screen.getByTestId('profile-avatar-section')
    );

    const name = screen.getByTestId('profile-identity-name');
    const email = screen.getByTestId('profile-identity-email');
    expect(name).toHaveTextContent('Ada Lovelace');
    expect(email).toHaveTextContent('ada@example.com');
    expect(name.tagName).not.toBe('INPUT');
    expect(email.tagName).not.toBe('INPUT');
    expect(screen.queryByRole('textbox', { name: /display name/i })).not.toBeInTheDocument();
  });
});

describe('ProfilePage — TBI-005 DoD-2 / PBI-005 AC-1 / VT-02', () => {
  it('contains profile load failure and keeps Theme operable', () => {
    profileQuery = {
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: mockRefetch,
    };
    const { onThemeChange } = renderPage();

    expect(screen.getByTestId('profile-section-error-identity')).toHaveTextContent('Identity unavailable');
    expect(screen.getByTestId('profile-section-error-bio')).toBeInTheDocument();
    expect(screen.getByTestId('profile-theme-section')).toBeInTheDocument();
    expect(screen.getByTestId('profile-notification-section')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('profile-theme-option-light'));
    expect(onThemeChange).toHaveBeenCalledWith('light');
  });
});

describe('ProfilePage — PBI-005 AC-2 / VT-03', () => {
  it('shows empty bio affordance and avatar upload when no bio or upload', () => {
    renderPage();

    expect(screen.getByTestId('profile-bio-input')).toHaveValue('');
    expect(screen.getByTestId('profile-bio-counter')).toHaveTextContent('0/500');
    expect(screen.getByTestId('profile-avatar-upload')).toHaveTextContent('Upload avatar');
    expect(screen.queryByTestId('profile-avatar-remove')).not.toBeInTheDocument();
  });
});

describe('ProfilePage — TBI-005 DoD-1 identity source', () => {
  it('shows Email unavailable when email is blank', () => {
    profileQuery = {
      ...profileQuery,
      data: { ...baseProfile, email: '   ' },
    };
    renderPage();
    expect(screen.getByTestId('profile-identity-email')).toHaveTextContent('Email unavailable');
  });
});

describe('ProfileBioSection — VT-09 / BR-004', () => {
  it('AC bio validation: empty and 500 accepted; 501 and HTML rejected', async () => {
    renderPage();
    const bio = screen.getByTestId('profile-bio-input');
    const save = screen.getByTestId('profile-bio-save');

    fireEvent.change(bio, { target: { value: '' } });
    expect(save).toBeDisabled();

    const exactly500 = 'a'.repeat(500);
    fireEvent.change(bio, { target: { value: exactly500 } });
    expect(screen.getByTestId('profile-bio-counter')).toHaveTextContent('500/500');
    await waitFor(() => expect(save).not.toBeDisabled());

    fireEvent.change(bio, { target: { value: 'a'.repeat(501) } });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/at most 500/i));
    expect(save).toBeDisabled();

    fireEvent.change(bio, { target: { value: '<script>x</script>' } });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/plain text/i));
    expect(save).toBeDisabled();
  });
});

describe('ProfileBioSection — VT-10 / PBI-005 AC-1 bio save failure', () => {
  it('preserves draft and identity when save fails', async () => {
    mockMutateAsync.mockRejectedValueOnce(new Error('Save failed'));
    profileQuery = {
      ...profileQuery,
      data: { ...baseProfile, bio: 'Prior bio' },
    };
    renderPage();

    const bio = screen.getByTestId('profile-bio-input');
    fireEvent.change(bio, { target: { value: 'Draft bio text' } });
    fireEvent.click(screen.getByTestId('profile-bio-save'));

    await waitFor(() => {
      expect(screen.getByTestId('profile-bio-status')).toHaveTextContent('Save failed');
    });
    expect(bio).toHaveValue('Draft bio text');
    expect(screen.getByTestId('profile-identity-name')).toHaveTextContent('Ada Lovelace');
  });

  it('AC-0 path: successful save persists bio via mutateAsync payload without target user', async () => {
    mockMutateAsync.mockResolvedValueOnce({
      ...baseProfile,
      bio: 'Saved bio',
    });
    renderPage();

    fireEvent.change(screen.getByTestId('profile-bio-input'), { target: { value: 'Saved bio' } });
    fireEvent.click(screen.getByTestId('profile-bio-save'));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({ bio: 'Saved bio' });
    });
    const payload = mockMutateAsync.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(['bio']);
  });
});

describe('ProfileThemeSection / NotificationPreferences — TBI-006 / PBI-006', () => {
  it('DoD-0 / AC-0: theme change invokes existing onThemeChange contract', () => {
    const { onThemeChange } = renderPage('amergis');
    fireEvent.click(screen.getByTestId('profile-theme-option-dark'));
    expect(onThemeChange).toHaveBeenCalledWith('dark');
  });

  it('categorizes themes with radio category filters and exposes neon', () => {
    const { onThemeChange } = renderPage('amergis');

    expect(screen.getByTestId('profile-theme-category-classic')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getAllByTestId(/profile-theme-option-/)).toHaveLength(6);
    expect(screen.getByTestId('profile-theme-option-amergis')).toBeInTheDocument();
    expect(screen.queryByTestId('profile-theme-option-neon')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('profile-theme-category-atmosphere'));
    expect(screen.getAllByTestId(/profile-theme-option-/)).toHaveLength(6);

    fireEvent.click(screen.getByTestId('profile-theme-category-neon'));
    expect(screen.getByTestId('profile-theme-category-neon')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getAllByTestId(/profile-theme-option-/)).toHaveLength(6);
    expect(screen.getByTestId('profile-theme-option-neon')).toBeInTheDocument();
    expect(screen.getByTestId('profile-theme-option-pink')).toBeInTheDocument();
    expect(screen.queryByTestId('profile-theme-option-amergis')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('profile-theme-option-pink'));
    expect(onThemeChange).toHaveBeenCalledWith('pink');
  });

  it('DoD-0 / AC-1: theme failure restores prior selection with contained error', () => {
    const onThemeChange = jest.fn(() => {
      throw new Error('Theme persistence failed');
    });
    renderPage('amergis', onThemeChange);

    fireEvent.click(screen.getByTestId('profile-theme-option-light'));
    expect(screen.getByTestId('profile-section-error-theme')).toHaveTextContent('Theme persistence failed');
    expect(screen.getByTestId('profile-theme-option-amergis')).toHaveAttribute('aria-checked', 'true');
  });

  it('DoD-1 / AC-0: supported notification toggle uses existing mutation contract', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('notification-pref-enabled-user-action'));
    expect(mockUpdatePrefMutate).toHaveBeenCalledWith({
      notificationType: 'user-action',
      enabled: false,
    });
    const payload = mockUpdatePrefMutate.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('userId');
    expect(payload).not.toHaveProperty('userOid');
    expect(payload).not.toHaveProperty('targetUser');
  });

  it('DoD-2 / AC-2: coming-soon rows lack toggles; disabled parent disables Toast', () => {
    renderPage();
    const notifications = screen.getByTestId('profile-notification-section');
    expect(within(notifications).getByTestId('notification-pref-enabled-system')).toBeInTheDocument();
    expect(within(notifications).queryByTestId('notification-pref-enabled-background')).not.toBeInTheDocument();
    expect(within(notifications).getAllByText('Coming soon').length).toBe(1);
    expect(screen.getByTestId('notification-pref-toast-ai')).toBeDisabled();
  });

  it('DoD-3 / AC-1: notification update failure shows contained non-destructive error', () => {
    updatePrefState = {
      mutate: mockUpdatePrefMutate,
      isError: true,
      error: new Error('Preference update failed'),
    };
    renderPage();
    expect(screen.getByTestId('profile-section-error-notifications')).toHaveTextContent(
      'Preference update failed'
    );
    expect(screen.getByTestId('notification-pref-enabled-user-action')).toBeChecked();
  });

  it('AC-3: preference mutation payload is self-scoped (no target user fields)', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('notification-pref-toast-user-action'));
    expect(mockUpdatePrefMutate).toHaveBeenCalledWith({
      notificationType: 'user-action',
      toastEnabled: false,
    });
  });
});

describe('ProfilePage — PBI-005 AC-3 auth boundary (client)', () => {
  it('does not render editable profile when no profile data and error (simulates denied API)', () => {
    profileQuery = {
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: mockRefetch,
    };
    renderPage();
    expect(screen.queryByTestId('profile-bio-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('profile-identity-name')).not.toBeInTheDocument();
  });
});

describe('ProfilePage — identity org fields from Graph', () => {
  it('renders job title, department, and direct reports when org is present', () => {
    profileQuery = {
      data: {
        ...baseProfile,
        org: {
          jobTitle: 'Software Engineer',
          department: 'Platform Engineering',
          officeLocation: 'Richmond',
          companyName: 'Amergis',
          manager: {
            userOid: 'oid-mgr',
            displayName: 'Charles Babbage',
            jobTitle: 'Engineering Manager',
            email: 'charles@example.com',
          },
          directReports: [
            {
              userOid: 'oid-r1',
              displayName: 'Grace Hopper',
              jobTitle: 'Developer',
              email: 'grace@example.com',
            },
          ],
        },
      },
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
    };

    renderPage();

    expect(screen.getByTestId('profile-org-job-title')).toHaveTextContent('Software Engineer');
    expect(screen.getByTestId('profile-org-department')).toHaveTextContent(
      'Platform Engineering'
    );
    expect(screen.getByTestId('profile-org-location')).toHaveTextContent('Richmond · Amergis');
    expect(screen.queryByTestId('profile-org-manager')).not.toBeInTheDocument();
    expect(screen.getByTestId('profile-org-reports')).toHaveTextContent('Grace Hopper');
  });

  it('omits org block when Graph org is unavailable', () => {
    profileQuery = {
      data: { ...baseProfile, org: null },
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
    };

    renderPage();

    expect(screen.queryByTestId('profile-org-job-title')).not.toBeInTheDocument();
    expect(screen.queryByTestId('profile-org-reports')).not.toBeInTheDocument();
  });
});
