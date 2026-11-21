/**
 * W5-A / S11 — Per-area cutover, inferHarnessArea in-place upgrade, and
 * Standup Facilitator migration to CursorSdkAdapter.
 *
 * Covers:
 *  - TBI-014 DoD-0: All 12 chat areas create threads carrying harnessArea & harnessVersion
 *  - TBI-014 DoD-1: Standup Facilitator runs through CursorSdkAdapter (no area profile, no chat UI)
 *  - TBI-014 DoD-2: Per-area permission checks behave unchanged across all 12 areas
 *  - TBI-014 DoD-3: Legacy per-area SDK/sendMessage paths remain exported and callable
 *  - PBI-007 AC-0 / BR-012 / VT-17: Pre-release unstamped thread upgrades in place on first harness turn
 *  - VT-49: Table-driven 12-area cutover + permission parity + Standup Facilitator adapter execution
 *  - assumptions.md guard: Every stamped thread admitted via durableInteractiveTurnService carries specification.harness
 */

const mockDbUpdate = jest.fn();
const mockDbFindFirstStandupSession = jest.fn();

jest.mock('../../db/drizzle', () => ({
  db: {
    update: (...args: unknown[]) => mockDbUpdate(...args),
    query: {
      standupSessions: {
        findFirst: (...args: unknown[]) => mockDbFindFirstStandupSession(...args),
      },
    },
  },
}));

jest.mock('../../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue({}),
}));

jest.mock('../../services/teamsBotService', () => ({
  sendTeamsNotification: jest.fn().mockResolvedValue(undefined),
}));

import fs from 'node:fs';
import path from 'node:path';
import type { ChatThread, ChatThreadKickoff } from '../../../shared/types/chat';
import {
  HARNESS_AREA_IDS,
  type HarnessAreaId,
  type HarnessReceipt,
} from '../../../shared/types/chatHarness';
import type { DurableInteractiveTurnSpecification } from '../../../shared/types/durableInteractiveTurn';
import { getAreaProfile } from '../../services/chatHarness/areaProfiles';
import type { ResolvedAreaProfile } from '../../services/chatHarness/areaProfileResolver';
import { createChatHarnessCommandHandler } from '../../services/chatHarness/chatHarnessCommandHandler';
import {
  rowToHarnessReceipt,
  type ChatHarnessCommandRepository,
  type ChatHarnessCommandRow,
} from '../../services/chatHarness/chatHarnessCommandRepository';
import {
  inferHarnessArea,
  inferHarnessAreaFromKickoff,
  stampThreadHarnessIfMissing,
} from '../../services/chatHarness/inferHarnessArea';
import { createDurableInteractiveTurnService } from '../../services/durableInteractiveTurnService';
import type { DurableInteractiveTurnRepository } from '../../services/durableInteractiveTurnRepository';
import { validateAdapterSpecification } from '../../services/cursorSdkAdapter/options';
import type {
  AdapterAgent,
  AdapterRun,
  AdapterSpecification,
  CursorSdkAdapter,
} from '../../services/cursorSdkAdapter/types';
import { runFacilitator } from '../../services/standupService';
import * as chatAgentService from '../../services/chatAgentService';
import * as askApexService from '../../services/askApexService';

const THREAD_ID = '10000000-0000-4000-8000-000000000111';
const USER_ID = '20000000-0000-4000-8000-000000000222';
const CMD_ID_1 = '40000000-0000-4000-8000-000000000101';
const CMD_ID_2 = '40000000-0000-4000-8000-000000000102';
const RUN_ID_1 = '30000000-0000-4000-8000-000000000301';

/** Representative pre-release (legacy) kickoff shapes for all 12 harness areas. */
const LEGACY_KICKOFF_BY_AREA: Record<HarnessAreaId, ChatThreadKickoff> = {
  'agent-home': {
    project: 'Apex',
    repo: 'AI-Pilot',
    branch: 'main',
    pillLabel: 'Free chat',
  },
  interview: {
    project: 'Apex',
    repo: 'AI-Pilot',
    branch: 'main',
    agentModule: 'interview',
    skillPath: '.cursor/skills/grill-with-docs/SKILL.md',
  },
  adr: {
    project: 'Apex',
    repo: 'AI-Pilot',
    branch: 'main',
    agentModule: 'adr',
    assistantType: 'adr',
    skillPath: '.cursor/skills/adr-interview/SKILL.md',
  },
  'prd-assistant': {
    project: 'Apex',
    repo: 'AI-Pilot',
    branch: 'main',
    agentModule: 'prdAssistant',
    assistantType: 'prd',
    skillPath: '.cursor/skills/prd-assistant/SKILL.md',
  },
  'design-doc-assistant': {
    project: 'Apex',
    repo: 'AI-Pilot',
    branch: 'main',
    agentModule: 'designDocAssistant',
    assistantType: 'design-doc',
    skillPath: '.cursor/skills/design-doc-assistant/SKILL.md',
  },
  'ask-apex': {
    project: 'Apex',
    repo: 'org/AI-Pilot',
    branch: 'main',
    askApex: true,
    skillPath: '.cursor/skills/app-knowledge/SKILL.md',
  },
  'calendar-work-item': {
    project: 'Apex',
    repo: 'AI-Pilot',
    branch: 'main',
    agentModule: 'calendarAssistant',
    assistantType: 'calendar-work-item',
    calendarAnchorWorkItemId: 42,
    calendarAssistantSessionId: 'cal-session-1',
  },
  'qa-lab': {
    project: 'Apex',
    repo: 'AI-Pilot',
    branch: 'main',
    qaLabSuiteId: 'suite-1',
  },
  brainstorm: {
    project: 'Apex',
    repo: 'AI-Pilot',
    branch: 'main',
    agentModule: 'brainstorm',
    skillPath: '.cursor/skills/brainstorm/SKILL.md',
  },
  'cab-release': {
    project: 'Apex',
    repo: 'AI-Pilot',
    branch: 'main',
    skillPath: '.cursor/skills/cab-release/SKILL.md',
    pillLabel: 'Create CAB request',
  },
  'build-intake': {
    project: 'Apex',
    repo: 'org/target',
    branch: 'main',
    skillPath: '.cursor/skills/build-intake/SKILL.md',
    playbookInterview: {
      runId: 'pb-run-1',
      stepId: 'intake',
      snapshot: { key: 'build-intake', mode: 'human_led' },
    },
  } as ChatThreadKickoff,
  'standup-participant': {
    project: 'Apex',
    repo: 'AI-Pilot',
    branch: 'main',
    agentModule: 'standup',
    mode: 'standup-participant',
    standupSessionId: 'standup-sess-1',
    standupParticipantId: 'standup-part-1',
  },
};

function makeThread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: THREAD_ID,
    userId: USER_ID,
    status: 'idle',
    harnessArea: null,
    harnessVersion: null,
    cursorAgentId: 'cursor-agent-pre-release-1',
    kickoff: LEGACY_KICKOFF_BY_AREA['agent-home'],
    messages: [
      {
        id: 'm-1',
        role: 'user',
        text: 'Earlier user context before release',
        ts: '2026-11-18T10:00:00.000Z',
      },
      {
        id: 'm-2',
        role: 'agent',
        text: 'Earlier agent reply before release',
        ts: '2026-11-18T10:00:05.000Z',
      },
    ],
    workspaceDir: '/tmp/apex-cutover-thread',
    flagged: false,
    createdAt: '2026-11-18T10:00:00.000Z',
    lastActivityAt: '2026-11-18T10:00:05.000Z',
    ...overrides,
  };
}

function makeResolvedProfile(area: HarnessAreaId): ResolvedAreaProfile {
  const profile = getAreaProfile(area);
  return {
    profile,
    project: 'Apex',
    settingsId: 'settings-1',
    skill: profile.requiresSkill
      ? {
          name: area,
          path: `.cursor/skills/${area}/SKILL.md`,
          source: 'project-setting',
        }
      : null,
    model: 'claude-sonnet-4-6',
    effort: null,
    permission: profile.permission,
    workflowClass: profile.workflowClass,
    toolAllowlist: profile.toolAllowlist,
    disallowedTools: profile.disallowedTools,
    customTools: profile.customTools,
    writeConfirmation: profile.writeConfirmation,
    safety: profile.safety,
    recreationCapChars: profile.recreationCapChars,
    rating: profile.rating,
  };
}

function makeInMemoryCommandRepository(): {
  repo: ChatHarnessCommandRepository;
  rows: Map<string, ChatHarnessCommandRow>;
} {
  const rows = new Map<string, ChatHarnessCommandRow>();
  let seq = 0;
  const keyFor = (threadId: string, commandId: string) =>
    `${threadId}:${commandId}`;

  const repo: ChatHarnessCommandRepository = {
    async insertIfAbsent(input) {
      const key = keyFor(input.threadId, input.commandId);
      const existing = rows.get(key);
      if (existing) return { inserted: false, row: { ...existing } };
      seq += 1;
      const nowIso = new Date().toISOString();
      const created: ChatHarnessCommandRow = {
        id: `cmd-row-${seq}`,
        threadId: input.threadId,
        commandId: input.commandId,
        runId: input.runId ?? null,
        kind: input.kind,
        status: input.status,
        reason: input.reason ?? null,
        payload: input.payload ?? null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      rows.set(key, created);
      return { inserted: true, row: { ...created } };
    },
    async findByCommandId(threadId, commandId) {
      const row = rows.get(keyFor(threadId, commandId));
      return row ? { ...row } : null;
    },
    async updateReceipt(threadId, commandId, patch) {
      const key = keyFor(threadId, commandId);
      const existing = rows.get(key);
      if (!existing) return null;
      if (patch.expectedStatus && existing.status !== patch.expectedStatus) {
        return null;
      }
      const updated: ChatHarnessCommandRow = {
        ...existing,
        status: patch.status,
        reason: 'reason' in patch ? (patch.reason ?? null) : existing.reason,
        runId: 'runId' in patch ? (patch.runId ?? null) : existing.runId,
        updatedAt: new Date().toISOString(),
      };
      rows.set(key, updated);
      return { ...updated };
    },
    async countActiveSteersForRun(threadId, runId) {
      let count = 0;
      for (const row of rows.values()) {
        if (
          row.threadId === threadId &&
          row.runId === runId &&
          row.kind === 'steer' &&
          (row.status === 'accepted' || row.status === 'applied')
        ) {
          count += 1;
        }
      }
      return count;
    },
    async listPendingCommands(threadId) {
      return [...rows.values()]
        .filter(
          (row) =>
            row.threadId === threadId &&
            (row.status === 'accepted' || row.status === 'queued'),
        )
        .map((row) => ({
          commandId: row.commandId,
          kind: row.kind,
          status: row.status as 'accepted' | 'queued',
        }));
    },
    async listPendingControlForRun() {
      return [];
    },
  };

  return { repo, rows };
}

function makeTurnServiceForTest(options: {
  thread: ChatThread;
  stampThreadHarness: jest.Mock<Promise<boolean>, [string, HarnessAreaId, number]>;
}): {
  service: ReturnType<typeof createDurableInteractiveTurnService>;
  capturedSpecs: DurableInteractiveTurnSpecification[];
} {
  const capturedSpecs: DurableInteractiveTurnSpecification[] = [];
  const repository: DurableInteractiveTurnRepository = {
    admit: jest.fn(async (input) => {
      capturedSpecs.push(input.specification);
      return {
        status: 'queued' as const,
        turnId: input.turnId,
        runId: RUN_ID_1,
        interactiveClass: input.interactiveClass,
        idempotent: false,
      };
    }),
    retry: jest.fn(),
  };

  const service = createDurableInteractiveTurnService({
    repository,
    attachmentStore: {
      upload: jest.fn(async () => {
        throw new Error('unexpected upload');
      }),
    },
    resolveThreadAccess: jest.fn(async () => ({
      access: 'owner' as const,
      thread: options.thread,
    })),
    resolveSkillConfig: jest.fn(async () => ({
      id: 'settings-1',
      project: 'Apex',
      skillRepo: 'AI-Pilot',
      skillBranch: 'main',
      defaultModel: 'claude-sonnet-4-6',
    })) as never,
    loadSkill: jest.fn(async ({ skill }) => ({
      path: skill.path,
      content: `# Skill ${skill.name}`,
    })),
    resolveGrounding: jest.fn(async () => ({
      provider: 'ado' as const,
      project: 'Apex',
      repository: 'AI-Pilot',
      sha: 'a'.repeat(40),
      profileId: 'grounding-profile-1',
    })),
    hasPinnedGrounding: jest.fn(async () => true),
    loadRepositoryContext: jest.fn(async () => null),
    resolveMaxviewCapability: jest.fn(async () => 'disabled' as const),
    resolveDeadlines: jest.fn(() => ({
      repositoryPreparationMs: null,
      firstEventMs: 45_000,
      toolCallMs: 60_000,
      absoluteTurnMs: 300_000 as const,
    })),
    encryptToolGrant: jest.fn(() => ({
      userId: USER_ID,
      projectId: 'Apex',
      allowedOperations: ['ado:read'] as const,
      expiresAt: '2026-11-19T12:00:00.000Z',
      encryptedAdoToken: {
        algorithm: 'aes-256-gcm' as const,
        iv: 'iv',
        ciphertext: 'ct',
        authTag: 'tag',
      },
    })),
    loadRetrySource: jest.fn(async () => null),
    isGuidedInterviewEnabled: jest.fn(async () => false),
    isBackgroundGroundingEnabled: jest.fn(async () => false),
    loadInterviewContext: jest.fn(async () => null),
    loadReferenceSources: jest.fn(async () => null),
    loadLinkedContext: jest.fn(async () => null),
    loadLatestFullSummary: jest.fn(async () => null),
    stampThreadHarness: options.stampThreadHarness,
    trackEvent: jest.fn(),
    now: () => new Date('2026-11-19T01:00:00.000Z'),
  });

  return { service, capturedSpecs };
}

describe('W5-A / S11 — Per-area cutover, inferHarnessArea, and Standup Facilitator adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('VT-17 / PBI-007 AC-0 / BR-012 — Pre-release unstamped thread upgrades in place on first harness turn', () => {
    it('stamps harnessArea and harnessVersion, preserves full message history & cursorAgentId, and populates specification.harness', async () => {
      const legacyThread = makeThread({
        harnessArea: null,
        harnessVersion: null,
        cursorAgentId: 'cursor-agent-pre-release-1',
        kickoff: LEGACY_KICKOFF_BY_AREA['prd-assistant'],
      });
      const initialMessages = [...legacyThread.messages];
      const initialCursorAgentId = legacyThread.cursorAgentId;

      const stampSpy = jest.fn<Promise<boolean>, [string, HarnessAreaId, number]>(
        async (_threadId, area, version) => {
          if (legacyThread.harnessArea === null) {
            legacyThread.harnessArea = area;
            legacyThread.harnessVersion = version;
            return true;
          }
          return false;
        },
      );

      const { service, capturedSpecs } = makeTurnServiceForTest({
        thread: legacyThread,
        stampThreadHarness: stampSpy,
      });

      const store = makeInMemoryCommandRepository();
      const handler = createChatHarnessCommandHandler({
        repository: store.repo,
        resolveThreadAccess: async () => ({
          access: 'owner',
          thread: legacyThread,
        }),
        canWriteThread: async () => true,
        getUserPermissions: async () => new Set(['interviews:view']),
        resolveAreaProfile: async (area) =>
          makeResolvedProfile(area as HarnessAreaId),
        resolveToolGrant: async () => ({ ok: true, toolGrant: null }),
        admitTurn: (input) => service.admit(input),
        stampThreadHarness: stampSpy,
        trackEvent: jest.fn(),
      });

      const receipt: HarnessReceipt = await handler.handle({
        userId: USER_ID,
        threadId: THREAD_ID,
        transport: 'socket',
        body: {
          commandId: CMD_ID_1,
          kind: 'send',
          text: 'Continue from our earlier discussion about acceptance criteria',
        },
      });

      expect(receipt.status).toBe('accepted');
      expect(receipt.runId).toBe(RUN_ID_1);

      // Thread stamped in place with inferred area & version
      expect(stampSpy).toHaveBeenCalledWith(THREAD_ID, 'prd-assistant', 1);
      expect(legacyThread.harnessArea).toBe('prd-assistant');
      expect(legacyThread.harnessVersion).toBe(1);

      // Full history visible and preserved intact
      expect(legacyThread.messages).toEqual(initialMessages);
      expect(capturedSpecs).toHaveLength(1);
      expect(capturedSpecs[0].transcript).toHaveLength(2);
      expect(capturedSpecs[0].transcript[0].text).toBe(
        'Earlier user context before release',
      );
      expect(capturedSpecs[0].transcript[1].text).toBe(
        'Earlier agent reply before release',
      );

      // specification.harness populated
      expect(capturedSpecs[0].harness).toBeDefined();
      expect(capturedSpecs[0].harness?.area).toBe('prd-assistant');
      expect(capturedSpecs[0].harness?.version).toBe(1);

      // Stored cursorAgentId preserved untouched so actor attempts resume first
      expect(legacyThread.cursorAgentId).toBe(initialCursorAgentId);

      handler.dispose();
    });

    it('stampThreadHarnessIfMissing executes an idempotent conditional UPDATE (harness_area IS NULL) without touching messages or cursor_agent_id', async () => {
      const returningMock = jest.fn().mockResolvedValue([{ id: THREAD_ID }]);
      const whereMock = jest.fn().mockReturnValue({ returning: returningMock });
      const setMock = jest.fn().mockReturnValue({ where: whereMock });
      mockDbUpdate.mockReturnValue({ set: setMock });

      const stamped = await stampThreadHarnessIfMissing(
        THREAD_ID,
        'interview',
        1,
      );

      expect(stamped).toBe(true);
      expect(mockDbUpdate).toHaveBeenCalledTimes(1);
      expect(setMock).toHaveBeenCalledWith({
        harnessArea: 'interview',
        harnessVersion: 1,
      });
      // Must NOT overwrite cursorAgentId or messages
      const setPayload = setMock.mock.calls[0][0] as Record<string, unknown>;
      expect(Object.keys(setPayload).sort()).toEqual([
        'harnessArea',
        'harnessVersion',
      ]);
    });
  });

  describe('assumptions.md guard — every stamped thread admitted through durableInteractiveTurnService carries specification.harness', () => {
    it.each(HARNESS_AREA_IDS)(
      'populates specification.harness for already-stamped area "%s" even when caller omits input.harness',
      async (area) => {
        const profile = getAreaProfile(area);
        const stampedThread = makeThread({
          harnessArea: area,
          harnessVersion: profile.version,
          kickoff: LEGACY_KICKOFF_BY_AREA[area],
        });
        const stampSpy = jest.fn<Promise<boolean>, [string, HarnessAreaId, number]>(
          async () => false,
        );
        const { service, capturedSpecs } = makeTurnServiceForTest({
          thread: stampedThread,
          stampThreadHarness: stampSpy,
        });

        await service.admit({
          threadId: THREAD_ID,
          userId: USER_ID,
          workflowClass: profile.workflowClass,
          turnId: CMD_ID_2,
          text: 'Follow up question',
        });

        expect(capturedSpecs).toHaveLength(1);
        expect(capturedSpecs[0].harness).toBeDefined();
        expect(capturedSpecs[0].harness).toMatchObject({
          area: profile.area,
          version: profile.version,
          safety: profile.safety,
        });
        expect(stampSpy).not.toHaveBeenCalled();
      },
    );
  });

  describe('VT-49 / TBI-014 DoD-0 & DoD-2 — Table-driven across all 12 HARNESS_AREA_IDS', () => {
    it.each(HARNESS_AREA_IDS)(
      'DoD-0: inferHarnessArea maps legacy kickoff for "%s" and preserves an already-stamped area',
      (area) => {
        const inferred = inferHarnessArea({
          harnessArea: null,
          kickoff: LEGACY_KICKOFF_BY_AREA[area],
        });
        expect(inferred).toBe(area);
        expect(inferHarnessAreaFromKickoff(LEGACY_KICKOFF_BY_AREA[area])).toBe(
          area,
        );

        // Already-stamped harnessArea always takes precedence
        expect(
          inferHarnessArea({
            harnessArea: area,
            kickoff: { project: 'Apex', repo: 'AI-Pilot' },
          }),
        ).toBe(area);
      },
    );

    it.each(HARNESS_AREA_IDS)(
      'DoD-2: permitted user succeeds and non-permitted user is rejected for "%s" with unchanged permission check',
      async (area) => {
        const profile = getAreaProfile(area);
        const thread = makeThread({
          harnessArea: area,
          harnessVersion: profile.version,
          kickoff: LEGACY_KICKOFF_BY_AREA[area],
        });

        // 1. Permitted user succeeds
        const permittedStore = makeInMemoryCommandRepository();
        const admitPermitted = jest.fn(async () => ({
          runId: RUN_ID_1,
          turnId: CMD_ID_1,
          status: 'queued' as const,
          interactiveClass: 'fast' as const,
          idempotent: false,
        }));
        const permittedHandler = createChatHarnessCommandHandler({
          repository: permittedStore.repo,
          resolveThreadAccess: async () => ({ access: 'owner', thread }),
          canWriteThread: async () => true,
          getUserPermissions: async () => new Set([profile.permission]),
          resolveAreaProfile: async () => makeResolvedProfile(area),
          resolveToolGrant: async () => ({ ok: true, toolGrant: null }),
          admitTurn: admitPermitted,
          trackEvent: jest.fn(),
        });

        const allowedReceipt = await permittedHandler.handle({
          userId: USER_ID,
          threadId: THREAD_ID,
          transport: 'http',
          body: {
            commandId: CMD_ID_1,
            kind: 'send',
            text: `Hello from ${area}`,
          },
        });
        expect(allowedReceipt.status).toBe('accepted');
        expect(admitPermitted).toHaveBeenCalledTimes(1);
        expect(admitPermitted).toHaveBeenCalledWith(
          expect.objectContaining({
            harness: expect.objectContaining({
              area,
              version: profile.version,
            }),
          }),
        );
        permittedHandler.dispose();

        // 2. Non-permitted user is rejected with zero DB writes and zero admits
        const deniedStore = makeInMemoryCommandRepository();
        const admitDenied = jest.fn();
        const deniedHandler = createChatHarnessCommandHandler({
          repository: deniedStore.repo,
          resolveThreadAccess: async () => ({ access: 'owner', thread }),
          canWriteThread: async () => true,
          getUserPermissions: async () => new Set<string>(),
          resolveAreaProfile: async () => makeResolvedProfile(area),
          resolveToolGrant: async () => ({ ok: true, toolGrant: null }),
          admitTurn: admitDenied,
          trackEvent: jest.fn(),
        });

        const deniedReceipt = await deniedHandler.handle({
          userId: USER_ID,
          threadId: THREAD_ID,
          transport: 'http',
          body: {
            commandId: CMD_ID_1,
            kind: 'send',
            text: `Unauthorized ${area}`,
          },
        });
        expect(deniedReceipt.status).toBe('rejected');
        expect(deniedReceipt.reason).toBe(
          'You have read-only access to this chat',
        );
        expect(admitDenied).not.toHaveBeenCalled();
        expect(deniedStore.rows.size).toBe(0);
        deniedHandler.dispose();
      },
    );

    it('DoD-0: every per-area thread-create call site stamps harness { area, version } while devWorkbench.ts remains untouched', () => {
      const serverRoot = path.resolve(__dirname, '../..');
      const callSiteAssertions: Array<{ file: string; area: HarnessAreaId }> = [
        { file: 'routes/chat.ts', area: 'agent-home' },
        { file: 'routes/interviews.ts', area: 'prd-assistant' },
        { file: 'routes/interviews.ts', area: 'design-doc-assistant' },
        { file: 'routes/adr.ts', area: 'adr' },
        { file: 'routes/api.ts', area: 'calendar-work-item' },
        { file: 'services/askApexService.ts', area: 'ask-apex' },
        { file: 'services/qaLabAssistantService.ts', area: 'qa-lab' },
        { file: 'services/brainstormSessionService.ts', area: 'brainstorm' },
        { file: 'services/playbookSteps/interviewAdapter.ts', area: 'build-intake' },
        { file: 'services/playbookSteps/interviewAdapter.ts', area: 'interview' },
        { file: 'services/standupService.ts', area: 'standup-participant' },
      ];

      for (const { file, area } of callSiteAssertions) {
        const content = fs.readFileSync(path.join(serverRoot, file), 'utf8');
        if (file === 'routes/chat.ts') {
          expect(content).toContain('inferHarnessAreaFromKickoff');
          expect(content).toContain('harness:');
        } else {
          expect(content).toContain(`'${area}'`);
          expect(content).toContain('harness:');
        }
      }

      // devWorkbench.ts (My Work) must NOT be cut over to the chat harness
      const devWorkbenchContent = fs.readFileSync(
        path.join(serverRoot, 'routes/devWorkbench.ts'),
        'utf8',
      );
      expect(devWorkbenchContent).not.toContain('harnessArea');
      expect(devWorkbenchContent).not.toContain('getAreaProfile');
    });
  });

  describe('TBI-014 DoD-1 / VT-49 — Standup Facilitator executes through CursorSdkAdapter (no area profile, no chat UI)', () => {
    it('acquires an agent via CursorSdkAdapter with an explicit validated AdapterSpecification, runs the facilitator prompt, and disposes cleanly', async () => {
      const setMock = jest
        .fn()
        .mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });
      mockDbUpdate.mockReturnValue({ set: setMock });
      mockDbFindFirstStandupSession.mockResolvedValue({
        id: 'standup-session-99',
        status: 'collecting',
        config: {
          project: 'Apex',
          skillSettingsId: 'settings-1',
        },
      });

      const waitMock = jest.fn().mockResolvedValue({ status: 'completed' });
      const sendMock = jest
        .fn()
        .mockResolvedValue({ wait: waitMock } as unknown as AdapterRun);
      const disposeMock = jest.fn().mockResolvedValue(undefined);
      const releaseMock = jest.fn().mockResolvedValue(undefined);

      let capturedSpec: AdapterSpecification | null = null;
      const adapter: CursorSdkAdapter = {
        acquire: jest.fn(async (spec: AdapterSpecification) => {
          validateAdapterSpecification(spec);
          capturedSpec = spec;
          return {
            agentId: 'facilitator-agent-1',
            mode: 'recreated',
            workspaceRef: spec.workspaceRef,
            compatibilityKey: spec.compatibilityKey,
            send: sendMock,
            steer: jest.fn(),
            summarize: jest.fn(),
            cancel: jest.fn(),
            readUsage: jest.fn(),
            dispose: disposeMock,
          } satisfies AdapterAgent;
        }),
        prewarm: jest.fn(),
        markUnresumable: jest.fn(),
        isUnresumable: jest.fn(() => false),
        release: releaseMock,
        evictIdle: jest.fn(async () => []),
        disposeAll: jest.fn(),
      };

      const createThreadSpy = jest.spyOn(chatAgentService, 'createThread');

      await runFacilitator('standup-session-99', {
        adapter,
        resolveSkillConfig: jest.fn(async () => ({
          id: 'settings-1',
          project: 'Apex',
          standupModel: 'claude-sonnet-4-6',
        })) as never,
        getDefaultModel: jest.fn(async () => 'fallback-app-model'),
        workspaceDir: '/tmp/standup-facilitator-test',
      });

      // Runs through adapter — NOT createThread (no chat UI, no area profile)
      expect(createThreadSpy).not.toHaveBeenCalled();
      expect(adapter.acquire).toHaveBeenCalledTimes(1);
      expect(capturedSpec).not.toBeNull();
      expect(capturedSpec!.model).toEqual({ id: 'claude-sonnet-4-6' });
      expect(capturedSpec!.sessionKey).toBe('standup-facilitator:standup-session-99');
      expect(capturedSpec!.settingSources).toEqual([]);
      expect(capturedSpec!.disallowedTools).toContain('Shell');
      expect(capturedSpec!.mcpServers['ado-skills']).toBeDefined();

      // Sends facilitator prompt referencing the session and awaits completion
      expect(sendMock).toHaveBeenCalledTimes(1);
      const [sentPrompt] = sendMock.mock.calls[0] as [string];
      expect(sentPrompt).toContain('standup-session-99');
      expect(sentPrompt).toContain('get_standup_session');
      expect(sentPrompt).toContain('complete_standup_session');
      expect(waitMock).toHaveBeenCalledTimes(1);

      // Cleans up handle and releases adapter slot
      expect(disposeMock).toHaveBeenCalledTimes(1);
      expect(releaseMock).toHaveBeenCalledWith(
        'standup-facilitator:standup-session-99',
      );
      createThreadSpy.mockRestore();
    });

    it('fails fast without a hardcoded model default when neither project settings nor app default supplies a model', async () => {
      const setMock = jest
        .fn()
        .mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });
      mockDbUpdate.mockReturnValue({ set: setMock });
      mockDbFindFirstStandupSession.mockResolvedValue({
        id: 'standup-session-no-model',
        status: 'collecting',
        config: {
          project: 'Apex',
          skillSettingsId: null,
        },
      });

      const acquireMock = jest.fn();
      const adapter = {
        acquire: acquireMock,
        prewarm: jest.fn(),
        markUnresumable: jest.fn(),
        isUnresumable: jest.fn(() => false),
        release: jest.fn(),
        evictIdle: jest.fn(async () => []),
        disposeAll: jest.fn(),
      } as unknown as CursorSdkAdapter;

      await expect(
        runFacilitator('standup-session-no-model', {
          adapter,
          resolveSkillConfig: jest.fn(async () => null) as never,
          getDefaultModel: jest.fn(async () => ''),
          workspaceDir: '/tmp/standup-facilitator-test',
        }),
      ).rejects.toThrow(/model/i);
      expect(acquireMock).not.toHaveBeenCalled();
    });
  });

  describe('TBI-014 DoD-3 — Legacy per-area SDK and sendMessage paths remain exported and callable until FEAT-003 removal', () => {
    it('keeps chatAgentService.sendMessage, chatAgentService.createThread, and askApexService.sendMessage callable', () => {
      expect(typeof chatAgentService.sendMessage).toBe('function');
      expect(typeof chatAgentService.createThread).toBe('function');
      expect(typeof askApexService.createSession).toBe('function');
      expect(typeof askApexService.sendMessage).toBe('function');
    });
  });
});
