import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BuildProfileSection } from '../BuildProfileSection';
import { BUILD_PROFILE_ROLES, type BuildProfile, type BuildProfileRole } from '../../../shared/types/build';
import {
  emptyBuildProfile,
  type BuildModelSource,
  type BuildProfileResponse,
} from '../../../shared/types/buildPreflight';
import type { UserWithRoles } from '../../../shared/types/rbac';

const SETTINGS_ID = 'cfg-1';
const PROFILE_URL = `/api/admin/project-settings/${SETTINGS_ID}/build-profile`;
const PLANNER_SKILL = '.cursor/skills/planner/SKILL.md';

const skillList = [
  { id: 'planner', path: PLANNER_SKILL, name: 'Planner' },
  { id: 'impl', path: '.cursor/skills/implementer/SKILL.md', name: 'Implementer' },
];
const availableModels = [
  { id: 'gpt-dev', displayName: 'GPT Dev' },
  { id: 'gpt-default', displayName: 'GPT Default' },
  { id: 'claude-plan', displayName: 'Claude Plan' },
];
const users: UserWithRoles[] = [
  { oid: 'u-1', displayName: 'Dana Lee', email: 'dana@example.com', lastSeenAt: null, roles: ['admin'] },
  { oid: 'u-2', displayName: 'Sam Roe', email: 'sam@example.com', lastSeenAt: null, roles: ['member'] },
];

function makeResponse(
  overrides: { profile?: Partial<BuildProfile>; implementer?: { model: string | null; modelSource: BuildModelSource | null } } = {},
): BuildProfileResponse {
  const profile = { ...emptyBuildProfile(), ...overrides.profile };
  const roles = {} as BuildProfileResponse['resolution']['roles'];
  for (const role of BUILD_PROFILE_ROLES) {
    roles[role] = { skillPath: null, model: 'gpt-default', modelSource: 'defaultModel', unresolved: ['skillPath'] };
  }
  if (overrides.implementer) {
    roles.implementer = {
      skillPath: null,
      ...overrides.implementer,
      unresolved: overrides.implementer.model ? ['skillPath'] : ['skillPath', 'model'],
    };
  }
  return {
    settingsId: SETTINGS_ID,
    project: 'Apex',
    repository: 'apex-repo',
    profile,
    resolution: {
      roles,
      caps: { costUsd: null, elapsedMinutesPerRevision: 240, maxRevisions: 5, maxParallelism: 4 },
      unresolvedRoles: [...BUILD_PROFILE_ROLES] as BuildProfileRole[],
      capsUnresolved: ['costUsd'],
    },
    supportContacts: [],
    updatedAt: null,
    updatedBy: null,
  };
}

let putBodies: unknown[] = [];

function mockFetch(getResponse: BuildProfileResponse) {
  putBodies = [];
  let current = getResponse;
  global.fetch = jest.fn((url: string, init?: RequestInit) => {
    if (url === PROFILE_URL && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as BuildProfile;
      putBodies.push(body);
      current = { ...current, profile: body, updatedAt: '2026-10-26T15:00:00.000Z', updatedBy: 'u-1' };
      const saved = current;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(saved) });
    }
    if (url === PROFILE_URL) {
      const snapshot = current;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(snapshot) });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  }) as unknown as typeof fetch;
}

function renderSection(settingsId: string | null = SETTINGS_ID) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <BuildProfileSection
        settingsId={settingsId}
        project="Apex"
        skillList={skillList}
        availableModels={availableModels}
        users={users}
      />
    </QueryClientProvider>,
  );
}

function putCalls() {
  return (global.fetch as jest.Mock).mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
}

describe('BuildProfileSection', () => {
  beforeEach(() => jest.clearAllMocks());

  it('asks to save the repository configuration first when it has no id', () => {
    mockFetch(makeResponse());
    renderSection(null);
    expect(screen.getByText('Save this repository configuration first, then set its Build profile')).toBeInTheDocument();
    expect(screen.queryByTestId('ps-build-profile-save')).not.toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('PBI-004 AC-1 (VT-04): empty contacts shows an alert, focuses the contacts field and sends no PUT', async () => {
    const user = userEvent.setup();
    mockFetch(makeResponse());
    renderSection();

    await user.click(await screen.findByTestId('ps-build-profile-save'));

    const error = await screen.findByTestId('ps-build-profile-error-supportContactUserIds');
    expect(error).toHaveTextContent('At least one support contact is required.');
    expect(error).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('ps-build-contacts')).toContainElement(document.activeElement as HTMLElement);
    expect(putCalls()).toHaveLength(0);
  });

  it('PBI-004 AC-3 (VT-07): parallelism 9 shows "The maximum is 6." and sends no PUT', async () => {
    const user = userEvent.setup();
    mockFetch(makeResponse({ profile: { supportContactUserIds: ['u-1'] } }));
    renderSection();

    const increase = await screen.findByTestId('ps-build-cap-parallelism-increase');
    for (let i = 0; i < 5; i += 1) await user.click(increase);
    expect(screen.getByTestId('ps-build-cap-parallelism-value')).toHaveTextContent('9');

    await user.click(screen.getByTestId('ps-build-profile-save'));

    const error = await screen.findByTestId('ps-build-profile-error-caps-maxParallelism');
    expect(error).toHaveTextContent('The maximum is 6.');
    expect(error).toHaveAttribute('role', 'alert');
    expect(putCalls()).toHaveLength(0);
  });

  it('PBI-004 AC-2: implementer with no model shows it uses the development model', async () => {
    mockFetch(makeResponse({ implementer: { model: 'gpt-dev', modelSource: 'developmentModel' } }));
    renderSection();

    const line = await screen.findByTestId('ps-build-role-implementer-effective-model');
    expect(line).toHaveTextContent('Uses the development model (GPT Dev)');
    expect(line).toHaveAttribute('aria-live', 'polite');
  });

  it('PBI-004 AC-2: implementer falls back to the default model when the development model is unset', async () => {
    mockFetch(makeResponse({ implementer: { model: 'gpt-default', modelSource: 'defaultModel' } }));
    renderSection();

    expect(await screen.findByTestId('ps-build-role-implementer-effective-model')).toHaveTextContent(
      'Uses the default model (GPT Default)',
    );
  });

  it('PBI-004 AC-2: shows "No model resolved" when no setting supplies a model', async () => {
    mockFetch(makeResponse({ implementer: { model: null, modelSource: null } }));
    renderSection();

    expect(await screen.findByTestId('ps-build-role-implementer-effective-model')).toHaveTextContent('No model resolved');
  });

  it('PBI-004 AC-0: saving sends a PUT with the planner skill and model, then shows the saved status', async () => {
    const user = userEvent.setup();
    mockFetch(makeResponse());
    renderSection();

    await user.selectOptions(await screen.findByTestId('ps-build-role-planner-skill'), PLANNER_SKILL);
    await user.selectOptions(screen.getByTestId('ps-build-role-planner-model'), 'claude-plan');
    await user.selectOptions(screen.getByTestId('ps-build-contact-picker'), 'u-1');
    await user.click(screen.getByTestId('ps-build-contact-add'));
    expect(screen.getByTestId('ps-build-contact-remove-u-1')).toBeInTheDocument();

    await user.click(screen.getByTestId('ps-build-profile-save'));

    await waitFor(() => expect(putBodies).toHaveLength(1));
    const body = putBodies[0] as BuildProfile;
    expect(body.roles.planner).toEqual({ skillPath: PLANNER_SKILL, model: 'claude-plan' });
    expect(body.supportContactUserIds).toEqual(['u-1']);
    expect(body.caps.elapsedMinutesPerRevision).toBe(240);
    expect(await screen.findByTestId('ps-build-profile-status')).toHaveTextContent(/Saved .* by Dana Lee/);
  });

  it('PBI-004: lists unresolved roles without blocking the save', async () => {
    mockFetch(makeResponse());
    renderSection();

    expect(await screen.findByTestId('ps-build-profile-unresolved')).toHaveTextContent(
      'intake, planner, implementer, qa, check',
    );
    expect(screen.getByTestId('ps-build-profile-save')).toBeEnabled();
  });
});
