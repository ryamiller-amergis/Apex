/**
 * @jest-environment node
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { SDKCustomTool } from '@cursor/sdk';
import type { ChatThreadKickoff } from '../../shared/types/chat';
import type { GroundingProfileId } from '../../shared/types/repoReader';
import type { RunGrounding, RunRef } from '../../shared/types/runGrounding';

const mockResolveConnectionProfile = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock('@cursor/sdk', () => ({
  Agent: { create: jest.fn(), resume: jest.fn() },
  CursorAgentError: class CursorAgentError extends Error {},
}));

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      interviews: { findFirst: jest.fn().mockResolvedValue(null) },
      prds: { findFirst: jest.fn().mockResolvedValue(null) },
      designDocs: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    insert: jest.fn(() => ({
      values: jest.fn(() =>
        Object.assign(Promise.resolve(), {
          onConflictDoNothing: jest.fn(() => Promise.resolve()),
        }),
      ),
    })),
    delete: jest.fn(() => ({ where: jest.fn(() => Promise.resolve()) })),
  },
}));

jest.mock('../db/schema', () => ({
  interviews: {},
  prds: {},
  designDocs: {},
  chatThreads: {},
  agentRuns: { id: 'id' },
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn(),
  and: jest.fn(),
  isNull: jest.fn(),
  or: jest.fn(),
}));

jest.mock('../services/chatThreadRepository', () => ({
  upsertThread: jest.fn().mockResolvedValue(undefined),
  insertMessage: jest.fn().mockResolvedValue(undefined),
  listThreadsByUser: jest.fn().mockResolvedValue([]),
  loadFullThread: jest.fn().mockResolvedValue(null),
  deleteThread: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/prdService', () => ({ syncPrdContent: jest.fn() }));
jest.mock('../services/designDocService', () => ({
  syncDesignDocContent: jest.fn(),
  syncValidationResult: jest.fn(),
  syncPerFeatureDesignDocs: jest.fn(),
  finalizeSingleFeatureDoc: jest.fn(),
  isSingleFeatureDesignDocRow: jest.fn().mockReturnValue(false),
}));
jest.mock('../services/telemetry', () => ({
  trackAgentError: jest.fn(),
  trackEvent: mockTrackEvent,
}));
jest.mock('../utils/dataDir', () => ({
  resolveDataRoot: () => path.join(os.tmpdir(), 'native-read-test-data'),
  isAzureWwwroot: () => false,
}));
jest.mock('../utils/retry', () => ({ retryWithBackoff: jest.fn() }));
jest.mock('../services/teamsBotService', () => ({
  sendTeamsNotification: jest.fn().mockResolvedValue(undefined),
  handleIncoming: jest.fn(),
}));
jest.mock('../services/agentRunReaperService', () => ({
  isThreadRunAlive: jest.fn().mockReturnValue(false),
}));
jest.mock('../services/pgNotifyService', () => ({
  clearRunEventSequence: jest.fn(),
  nextRunEventSequence: jest.fn(),
  notifyRunEvent: jest.fn(),
  RUN_EVENT_SOURCE_INSTANCE: 'native-read-s5-test',
  subscribeRunEvents: jest.fn(),
}));
jest.mock('../services/groundingProfileResolver', () => ({
  groundingProfileResolver: {
    resolveConnectionProfile: mockResolveConnectionProfile,
  },
}));

import {
  createCallerGroundingService,
  type CallerGroundingDependencies,
  type CallerGroundingSelection,
} from '../services/callerGroundingService';
import {
  prepareRepositoryReadRuntime,
  type RepositoryReadRuntime,
} from '../services/chatAgentService';
import {
  createGroundingTelemetry,
  sanitizeGroundingTelemetryProperties,
} from '../services/groundingTelemetry';
import { LocalCheckoutReader } from '../services/localCheckoutReader';
import { createNativeReadTools } from '../services/nativeReadToolAdapter';

const run: RunRef = {
  runType: 'chat',
  runId: 'native-read-s5',
  project: 'Apex',
};
const sha = 'a'.repeat(40);
const grounding: RunGrounding = {
  ...run,
  id: 'grounding-s5',
  repoRole: 'target',
  provider: 'github',
  repository: 'target-repo',
  branch: 'release/s5',
  groundedSha: sha,
  groundedAt: '2026-08-03T12:00:00.000Z',
  isActive: true,
  createdAt: '2026-08-03T12:00:00.000Z',
  updatedAt: '2026-08-03T12:00:00.000Z',
};
const profileId = 'native-read-s5-profile' as GroundingProfileId;

function kickoff(overrides: Partial<ChatThreadKickoff> = {}): ChatThreadKickoff {
  return {
    project: 'Apex',
    repo: 'org/target-repo',
    branch: 'release/s5',
    skillProvider: 'github',
    ...overrides,
  };
}

function dependencies(
  checkoutPath: string,
  overrides: Partial<CallerGroundingDependencies> = {},
): CallerGroundingDependencies {
  return {
    isGroundingEnabledForCaller: jest.fn().mockResolvedValue(true),
    isNativeReadEnabledForCaller: jest.fn().mockResolvedValue(false),
    isSharedReadCheckoutEnabledForCaller: jest.fn().mockResolvedValue(false),
    evaluateNativeReadCapability: jest.fn().mockReturnValue({
      proven: false,
      reason: 'harness-not-run',
    }),
    sharedReadCheckout: {
      getReady: jest.fn().mockReturnValue(null),
      materialize: jest.fn().mockResolvedValue({
        workspacePath: checkoutPath,
        outcome: 'materialized',
      }),
      retain: jest.fn(),
      releaseRef: jest.fn(),
    },
    ensureRepoCache: jest.fn().mockResolvedValue({ baseSha: sha }),
    groundingService: {
      activateGroundings: jest.fn().mockResolvedValue({
        ok: true,
        durableGrounding: true,
        fallback: 'none',
        groundings: [grounding],
      }),
      getGroundings: jest.fn().mockResolvedValue([grounding]),
      findActiveByRepoBranch: jest.fn().mockResolvedValue([grounding]),
      markTerminalInactive: jest.fn().mockResolvedValue(1),
      reground: jest.fn().mockImplementation(
        async (_run, _role, newSha) => ({
          ...grounding,
          groundedSha: newSha,
        }),
      ),
    },
    materialize: jest.fn().mockResolvedValue({
      state: 'materialized',
      workspacePath: checkoutPath,
    }),
    profiles: {
      registerConnectionProfile: jest.fn().mockReturnValue({
        id: profileId,
        expiresAt: Date.now() + 60_000,
      }),
      revokeProfile: jest.fn(),
    },
    impactContexts: {
      register: jest.fn(),
      unregister: jest.fn(),
    },
    trackEvent: jest.fn(),
    ...overrides,
  };
}

async function start(
  deps: CallerGroundingDependencies,
): Promise<CallerGroundingSelection> {
  return createCallerGroundingService(deps).start({
    caller: 'chat-agent',
    userId: 'developer-s5',
    run,
    repository: {
      provider: 'github',
      repo: 'org/target-repo',
      branch: 'release/s5',
    },
    reauthorize: async () => true,
  });
}

async function runtime(
  selection: CallerGroundingSelection,
): Promise<RepositoryReadRuntime> {
  return prepareRepositoryReadRuntime({
    grounding: selection,
    kickoff: kickoff(),
    adoSkillsUrl: 'http://localhost:3001/mcp/ado-skills',
    sandboxCwd: path.join(os.tmpdir(), 'native-read-sandbox'),
  });
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function checkout(label: string): { root: string; sha: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `native-read-s5-${label}-`));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'README.md'), `${label} repository content\n`);
  fs.writeFileSync(
    path.join(root, 'src', `${label}.ts`),
    `export const fixtureNeedle = '${label}';\n`,
  );
  git(root, ['init']);
  git(root, ['config', 'user.name', 'Apex Test']);
  git(root, ['config', 'user.email', 'apex-test@example.com']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', `${label} fixture`]);
  return { root, sha: git(root, ['rev-parse', 'HEAD']) };
}

function reader(root: string, repo: string, pinnedSha: string, now?: () => number) {
  return new LocalCheckoutReader({
    identity: {
      provider: 'github',
      project: 'Apex',
      repo,
      sha: pinnedSha,
    },
    checkoutPath: root,
    telemetryContext: {
      caller: 'chat-agent',
      project: 'Apex',
      runId: run.runId,
      runType: run.runType,
    },
    telemetry: mockTrackEvent,
    now,
  });
}

async function execute(
  tool: SDKCustomTool,
  args: Parameters<SDKCustomTool['execute']>[0],
): Promise<unknown> {
  return tool.execute(args, {});
}

describe('FEAT-005 S5 VT-09 fail-closed repository read integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    {
      criterion: 'BR-008 flag off',
      nativeFlag: jest.fn().mockResolvedValue(false),
      capability: jest.fn().mockReturnValue({
        proven: true,
        reason: 'pinned-checkout-confined',
      }),
      fallbackReason: 'native-read-flag-off',
      capabilityCalls: 0,
    },
    {
      criterion: 'BR-008 flag evaluation error',
      nativeFlag: jest.fn().mockImplementation(async (_context, onError) => {
        onError?.();
        return false;
      }),
      capability: jest.fn().mockReturnValue({
        proven: true,
        reason: 'pinned-checkout-confined',
      }),
      fallbackReason: 'native-read-flag-evaluation-failed',
      capabilityCalls: 0,
    },
    {
      criterion: 'AC-2 capability unproven',
      nativeFlag: jest.fn().mockResolvedValue(true),
      capability: jest.fn().mockReturnValue({
        proven: false,
        reason: 'path-confinement-unproven',
      }),
      fallbackReason: 'native-read-capability-unproven',
      capabilityCalls: 1,
    },
  ])(
    '$criterion keeps provider browse, attaches no local tools, sanitizes fallback, and emits no engagement',
    async ({ nativeFlag, capability, fallbackReason, capabilityCalls }) => {
      // Arrange
      const deps = dependencies('C:\\sensitive\\checkout', {
        isNativeReadEnabledForCaller: nativeFlag,
        evaluateNativeReadCapability: capability,
      });

      // Act
      const selection = await start(deps);
      const prepared = await runtime(selection);

      // Assert
      expect(selection).toMatchObject({ mode: 'local', nativeReads: false });
      expect(capability).toHaveBeenCalledTimes(capabilityCalls);
      expect(mockResolveConnectionProfile).not.toHaveBeenCalled();
      expect(prepared.local.customTools).toBeUndefined();
      expect(prepared.mcpServers['github-repo']).toEqual({
        url: `http://localhost:3001/mcp/github-repo/grounding/${profileId}`,
      });
      expect(deps.trackEvent).toHaveBeenCalledWith(
        'grounding.fallback',
        expect.objectContaining({ reason: fallbackReason }),
        { fallbackCount: 1 },
      );
      expect(
        jest.mocked(deps.trackEvent).mock.calls.some(([name]) =>
          name === 'native-read.engaged'),
      ).toBe(false);
      expect(JSON.stringify(jest.mocked(deps.trackEvent).mock.calls))
        .not.toContain('sensitive');
    },
  );

  it('AC-2 / DoD-2 reader-resolution failure restores provider browse and records only sanitized fallback telemetry', async () => {
    // Arrange
    mockResolveConnectionProfile.mockRejectedValue(
      new Error('token=private C:\\secret\\checkout --raw-args'),
    );
    const selection = {
      mode: 'local',
      cwd: 'C:\\secret\\checkout',
      profileId,
      resolvedSha: sha,
      nativeReads: true,
      release: jest.fn(),
    } satisfies CallerGroundingSelection;

    // Act
    const prepared = await runtime(selection);

    // Assert
    expect(prepared.nativeReads).toBe(false);
    expect(prepared.local.customTools).toBeUndefined();
    expect(prepared.mcpServers['github-repo']).toEqual({
      url: 'http://localhost:3001/mcp/github-repo',
    });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      'grounding.fallback',
      {
        caller: 'agent-home',
        project: 'Apex',
        provider: 'github',
        repository: 'target-repo',
        branch: 'release/s5',
        reason: 'native-read-reader-resolution-failed',
      },
      { fallbackCount: 1 },
    );
    expect(mockTrackEvent.mock.calls.some(([name]) =>
      name === 'native-read.engaged')).toBe(false);
    const serialized = JSON.stringify(mockTrackEvent.mock.calls);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('raw-args');
    expect(serialized).not.toContain('private');
  });

  it('DoD-2 checkout materialization failure retains provider MCP and never exposes native tools or engagement', async () => {
    // Arrange
    const deps = dependencies('C:\\sensitive\\unavailable-checkout', {
      isNativeReadEnabledForCaller: jest.fn().mockResolvedValue(true),
      evaluateNativeReadCapability: jest.fn().mockReturnValue({
        proven: true,
        reason: 'pinned-checkout-confined',
      }),
      materialize: jest.fn().mockResolvedValue({ state: 'unavailable' }),
    });

    // Act
    const selection = await start(deps);
    const prepared = await runtime(selection);

    // Assert
    expect(selection.mode).toBe('remote');
    expect(deps.evaluateNativeReadCapability).not.toHaveBeenCalled();
    expect(prepared.nativeReads).toBe(false);
    expect(prepared.local.customTools).toBeUndefined();
    expect(prepared.mcpServers['github-repo']).toEqual({
      url: 'http://localhost:3001/mcp/github-repo',
    });
    expect(deps.trackEvent).toHaveBeenCalledWith(
      'grounding.fallback',
      expect.objectContaining({ reason: 'materialization-unavailable' }),
      { fallbackCount: 1 },
    );
    expect(jest.mocked(deps.trackEvent).mock.calls.some(([name]) =>
      name === 'native-read.engaged')).toBe(false);
  });
});

describe('FEAT-005 S5 VT-10 actual custom-tool confinement', () => {
  it('DoD-3 / BR-012 rejects traversal, symlink escape, host-absolute, and out-of-root reads without disclosure', async () => {
    // Arrange
    const target = checkout('target');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'native-read-s5-outside-'));
    const outsideContent = 'outside repository secret';
    fs.writeFileSync(path.join(outside, 'secret.txt'), outsideContent);
    // Same fixture style as repoReader.test.ts (junction is treated as dir on POSIX).
    fs.symlinkSync(outside, path.join(target.root, 'escape-link'), 'junction');
    const tools = createNativeReadTools(
      reader(target.root, 'target-repo', target.sha),
    );

    try {
      // Act — start each attempt only after the previous settles so rejected
      // promises are never briefly unhandled (Jest treats that as a failure).
      // Host-absolute samples must be win32/UNC forms: a POSIX `/tmp/...` path is
      // indistinguishable from MCP's leading-slash repo-root contract and is
      // normalized to an in-checkout relative miss (LOCAL_READ_UNAVAILABLE).
      const attempts = [
        () => execute(tools.get_skill_file, { path: '../secret.txt' }),
        () => execute(tools.get_skill_file, { path: 'C:\\outside\\secret.txt' }),
        () => execute(tools.get_skill_file, { path: '//host/share/secret.txt' }),
        () => execute(tools.get_skill_file, { path: 'escape-link/secret.txt' }),
      ];

      // Assert
      for (const attempt of attempts) {
        const denied = await attempt().then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(denied).toMatchObject({
          name: 'RepoReaderError',
          code: 'ACCESS_DENIED',
          fallbackEligible: false,
          message: 'Repository path access denied',
        });
        expect(String(denied)).not.toContain(target.root);
        expect(String(denied)).not.toContain(outside);
        expect(String(denied)).not.toContain(outsideContent);
      }
    } finally {
      fs.rmSync(target.root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('BR-012 ignores root-widening tool arguments and remains bound to the constructed reader root', async () => {
    // Arrange
    const target = checkout('target');
    const sibling = checkout('sibling');
    const tools = createNativeReadTools(
      reader(target.root, 'target-repo', target.sha),
    );

    try {
      // Act
      const content = await execute(tools.get_skill_file, {
        path: 'README.md',
        root: sibling.root,
        checkoutPath: sibling.root,
        command: `cat ${path.join(sibling.root, 'README.md')}`,
      });

      // Assert
      expect(content).toBe('target repository content\n');
      expect(content).not.toContain('sibling');
      expect(tools.get_skill_file.inputSchema?.additionalProperties).toBe(false);
    } finally {
      fs.rmSync(target.root, { recursive: true, force: true });
      fs.rmSync(sibling.root, { recursive: true, force: true });
    }
  });
});

describe('FEAT-005 S5 VT-11 content-free telemetry', () => {
  it('DoD-4 / BR-011 drops content, paths, commands, raw arguments, credentials, and secrets through the production sanitizer', () => {
    // Arrange
    const sanitized = sanitizeGroundingTelemetryProperties({
      caller: 'chat-agent',
      project: 'Apex',
      provider: 'github',
      repository: 'org/target-repo',
      branch: 'release/s5',
      outcome: 'failure',
      reason: 'native-read-reader-resolution-failed',
      content: 'export const secretContent = true',
      path: 'C:\\private\\checkout\\README.md',
      command: 'git show HEAD:README.md',
      rawArgument: '{"path":"../../secret"}',
      credential: 'Bearer credential-value',
      secret: 'apiKey=secret-value',
    });
    const emit = jest.fn();
    const telemetry = createGroundingTelemetry(emit);

    // Act
    telemetry.fallback(
      {
        caller: 'chat-agent',
        project: 'Apex',
        runId: run.runId,
        runType: run.runType,
        content: 'repository content',
        path: 'C:\\private\\checkout',
      },
      'native-read-reader-resolution-failed',
    );

    // Assert
    expect(sanitized).toEqual({
      caller: 'chat-agent',
      project: 'Apex',
      provider: 'github',
      repository: 'org/target-repo',
      branch: 'release/s5',
      outcome: 'failure',
      reason: 'native-read-reader-resolution-failed',
    });
    expect(emit).toHaveBeenCalledWith(
      'grounding.fallback',
      {
        caller: 'chat-agent',
        project: 'Apex',
        runId: run.runId,
        runType: run.runType,
        reason: 'native-read-reader-resolution-failed',
      },
      { fallbackCount: 1 },
    );
    expect(JSON.stringify(emit.mock.calls)).not.toContain('repository content');
    expect(JSON.stringify(emit.mock.calls)).not.toContain('private');
  });
});

describe('FEAT-005 S5 VT-15 exact targeted repository identity and NFRs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('BR-013 reads only the targeted checkout and rejects a sibling reader selected under the same project', async () => {
    // Arrange
    const target = checkout('target');
    const sibling = checkout('sibling');
    const targetReader = reader(target.root, 'target-repo', target.sha);
    const siblingReader = reader(sibling.root, 'sibling-repo', sibling.sha);
    const selection = {
      mode: 'local',
      cwd: target.root,
      profileId,
      resolvedSha: target.sha,
      nativeReads: true,
      release: jest.fn(),
    } satisfies CallerGroundingSelection;

    try {
      mockResolveConnectionProfile.mockResolvedValueOnce(targetReader);

      // Act
      const targetedRuntime = await runtime(selection);
      const content = await execute(
        targetedRuntime.local.customTools!.get_skill_file,
        {
          path: 'README.md',
          repo: 'sibling-repo',
          profileId: 'sibling-profile',
          checkoutPath: sibling.root,
        },
      );
      mockResolveConnectionProfile.mockResolvedValueOnce(siblingReader);
      const siblingRuntime = await runtime(selection);

      // Assert
      expect(mockResolveConnectionProfile).toHaveBeenNthCalledWith(1, profileId);
      expect(mockResolveConnectionProfile).toHaveBeenNthCalledWith(2, profileId);
      expect(content).toBe('target repository content\n');
      expect(content).not.toContain('sibling repository content');
      expect(targetedRuntime.nativeReads).toBe(true);
      // Native reads engaged → the read-only github-repo MCP is de-mounted entirely.
      expect(targetedRuntime.mcpServers['github-repo']).toBeUndefined();
      expect(siblingRuntime.nativeReads).toBe(false);
      expect(siblingRuntime.local.customTools).toBeUndefined();
      expect(siblingRuntime.mcpServers['github-repo']).toEqual({
        url: 'http://localhost:3001/mcp/github-repo',
      });
    } finally {
      fs.rmSync(target.root, { recursive: true, force: true });
      fs.rmSync(sibling.root, { recursive: true, force: true });
    }
  });

  it('performance NFR uses deterministic reader timing for read/list/search and makes zero provider calls', async () => {
    // Arrange
    const target = checkout('performance');
    const providerCall = jest.fn().mockRejectedValue(
      new Error('provider browse must not be called'),
    );
    const deterministicNow = jest
      .fn()
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_012)
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(2_018)
      .mockReturnValueOnce(3_000)
      .mockReturnValueOnce(3_030);
    const targetReader = reader(
      target.root,
      'target-repo',
      target.sha,
      deterministicNow,
    );
    mockResolveConnectionProfile.mockResolvedValue(targetReader);
    const selection = {
      mode: 'local',
      cwd: target.root,
      profileId,
      resolvedSha: target.sha,
      nativeReads: true,
      release: jest.fn(),
    } satisfies CallerGroundingSelection;

    try {
      // Act
      const prepared = await runtime(selection);
      const tools = prepared.local.customTools;
      if (!prepared.nativeReads || !tools) {
        await providerCall();
        throw new Error('native read runtime was not prepared');
      }
      await execute(tools.get_skill_file, { path: 'README.md' });
      await execute(tools.list_repo_dir, { path: 'src' });
      await execute(tools.search_repo_code, {
        query: 'fixtureNeedle',
        limit: 5,
      });

      // Assert
      const durations = mockTrackEvent.mock.calls
        .filter(([name]) => name === 'grounding.read.latency')
        .map(([, , measurements]) => measurements.durationMs);
      expect(durations).toEqual([12, 18, 30]);
      expect(Math.max(...durations)).toBeLessThanOrEqual(50);
      // Native reads engaged → github-repo is not mounted at all (zero provider surface).
      expect(prepared.mcpServers['github-repo']).toBeUndefined();
      expect(providerCall).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(target.root, { recursive: true, force: true });
    }
  });
});
