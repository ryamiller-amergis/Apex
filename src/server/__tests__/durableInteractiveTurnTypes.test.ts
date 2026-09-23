import {
  absoluteTurnMsForClass,
  isCanonicalUuid,
  isDurableInteractiveTurnSpecification,
  isInteractiveDispatchOutboxPayload,
  type DurableInteractiveTurnSpecification,
} from '../../shared/types/durableInteractiveTurn';
import { isAiRunTransportVersion } from '../../shared/types/aiRunV2';

const SHA256 = 'a'.repeat(64);
const TURN_ID = '10000000-0000-4000-8000-000000000001';
const THREAD_ID = '10000000-0000-4000-8000-000000000002';
const USER_ID = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const TRANSCRIPT_MESSAGE_ID = '10000000-0000-4000-8000-000000000003';
const ATTACHMENT_ID = '10000000-0000-4000-8000-000000000004';
const CALENDAR_SESSION_ID = '10000000-0000-4000-8000-000000000005';
const RUN_ID = '20000000-0000-4000-8000-000000000001';
const ATTEMPT_ID = '20000000-0000-4000-8000-000000000002';
const DISPATCH_MESSAGE_ID = '20000000-0000-4000-8000-000000000003';

const validSpecification: DurableInteractiveTurnSpecification = {
  schemaVersion: 1,
  kind: 'interactive-turn',
  turnId: TURN_ID,
  threadId: THREAD_ID,
  userId: USER_ID,
  projectId: 'project-1',
  interactiveClass: 'fast',
  workflowClass: 'home-chat',
  model: 'model-a',
  effort: 'low',
  skill: null,
  currentMessage: {
    id: TURN_ID,
    text: 'Hello',
    hidden: false,
    attachments: [],
  },
  transcript: [
    {
      id: TRANSCRIPT_MESSAGE_ID,
      role: 'agent',
      text: 'How can I help?',
      timestamp: '2026-09-23T14:00:00.000Z',
    },
  ],
  grounding: null,
  mcpServers: [],
  toolGrant: null,
  currentPrompt: 'Hello',
  recreationPrompt: 'How can I help?\nHello',
  deadlines: {
    absoluteTurnMs: 300_000,
    repositoryPreparationMs: null,
    firstEventMs: 30_000,
    toolCallMs: 60_000,
  },
};

const validDispatch = {
  schemaVersion: 2,
  kind: 'interactive_dispatch',
  transport: 'dapr-actor-v2',
  runId: RUN_ID,
  attemptId: ATTEMPT_ID,
  attemptNumber: 1,
  dispatchMessageId: DISPATCH_MESSAGE_ID,
  threadId: THREAD_ID,
  userId: USER_ID,
  interactiveClass: 'fast',
  workloadLane: 'fast',
  capacityClass: 'interactive',
  deadlineAt: '2026-09-23T15:00:00.000Z',
} as const;

describe('durable interactive turn contracts', () => {
  it('recognizes the direct actor transport', () => {
    expect(isAiRunTransportVersion('dapr-actor-v2')).toBe(true);
  });

  it('freezes only the approved class absolute deadlines', () => {
    expect(absoluteTurnMsForClass('fast')).toBe(300_000);
    expect(absoluteTurnMsForClass('agentic')).toBe(1_200_000);
  });

  it.each([
    '10000000-0000-4000-8000-000000000001',
    'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
  ])('accepts canonical UUID %s case-insensitively', (value) => {
    expect(isCanonicalUuid(value)).toBe(true);
  });

  it.each([
    'run-1',
    '10000000000040008000000000000001',
    '{10000000-0000-4000-8000-000000000001}',
    '10000000-0000-4000-8000-00000000000g',
    '10000000-0000-4000-8000-00000000001',
  ])('rejects malformed UUID %s', (value) => {
    expect(isCanonicalUuid(value)).toBe(false);
  });

  it('accepts a complete frozen turn specification', () => {
    expect(isDurableInteractiveTurnSpecification(validSpecification)).toBe(
      true
    );
    expect(
      isDurableInteractiveTurnSpecification({
        ...validSpecification,
        interactiveClass: 'agentic',
        skill: {
          name: 'Daily standup',
          path: '.cursor/skills/daily-standup/SKILL.md',
          sha256: SHA256,
          content: '# Daily standup',
        },
        currentMessage: {
          ...validSpecification.currentMessage,
          attachments: [
            {
              attachmentId: ATTACHMENT_ID,
              name: 'notes.txt',
              contentType: 'text/plain',
              sizeBytes: 12,
              sha256: SHA256,
              blobRef: {
                container: 'ai-run-artifacts',
                key: 'interactive/thread-1/turn-1/attachment-1',
              },
              materializedPath: 'attachments/notes.txt',
            },
          ],
        },
        grounding: {
          provider: 'ado',
          project: 'Apex',
          repository: 'Apex',
          sha: 'abc123',
          profileId: 'profile-1',
        },
        mcpServers: [
          {
            kind: 'internal-proxy',
            serverName: 'ado-skills',
            profileId: 'profile-1',
            calendarSessionId: CALENDAR_SESSION_ID,
            enableRepoBrowse: true,
          },
          {
            kind: 'external-http-proxy',
            serverName: 'external',
            url: 'https://mcp.example.test',
            headerEnvRefs: { Authorization: 'MCP_TOKEN' },
          },
        ],
        toolGrant: {
          userId: USER_ID,
          projectId: 'project-1',
          allowedOperations: ['ado:read', 'ado:write'],
          expiresAt: '2026-09-23T15:00:00.000Z',
          encryptedAdoToken: {
            algorithm: 'aes-256-gcm',
            iv: 'iv',
            ciphertext: 'ciphertext',
            authTag: 'tag',
          },
        },
        deadlines: {
          absoluteTurnMs: 1_200_000,
          repositoryPreparationMs: 120_000,
          firstEventMs: 30_000,
          toolCallMs: 60_000,
        },
      })
    ).toBe(true);
  });

  it.each(['turnId', 'threadId', 'userId'] as const)(
    'rejects malformed top-level %s',
    (field) => {
      expect(
        isDurableInteractiveTurnSpecification({
          ...validSpecification,
          [field]: `${field}-1`,
        })
      ).toBe(false);
    }
  );

  it.each([
    [
      'current message id',
      {
        ...validSpecification,
        currentMessage: {
          ...validSpecification.currentMessage,
          id: 'message-1',
        },
      },
    ],
    [
      'attachment id',
      {
        ...validSpecification,
        currentMessage: {
          ...validSpecification.currentMessage,
          attachments: [
            {
              attachmentId: 'attachment-1',
              name: 'notes.txt',
              contentType: 'text/plain',
              sizeBytes: 12,
              sha256: SHA256,
              blobRef: {
                container: 'ai-run-artifacts',
                key: 'interactive/attachment',
              },
              materializedPath: 'attachments/notes.txt',
            },
          ],
        },
      },
    ],
    [
      'transcript message id',
      {
        ...validSpecification,
        transcript: [
          {
            id: 'message-0',
            role: 'agent',
            text: 'How can I help?',
            timestamp: '2026-09-23T14:00:00.000Z',
          },
        ],
      },
    ],
    [
      'calendar session id',
      {
        ...validSpecification,
        mcpServers: [
          {
            kind: 'internal-proxy',
            serverName: 'calendar-assistant',
            calendarSessionId: 'calendar-session-1',
            enableRepoBrowse: false,
          },
        ],
      },
    ],
    [
      'tool grant user id',
      {
        ...validSpecification,
        toolGrant: {
          userId: 'user-1',
          projectId: 'project-1',
          allowedOperations: ['ado:read'],
          expiresAt: '2026-09-23T15:00:00.000Z',
          encryptedAdoToken: null,
        },
      },
    ],
  ])('rejects malformed nested %s', (_name, candidate) => {
    expect(isDurableInteractiveTurnSpecification(candidate)).toBe(false);
  });

  it('keeps semantic strings outside UUID validation', () => {
    expect(
      isDurableInteractiveTurnSpecification({
        ...validSpecification,
        projectId: 'project-1',
        model: 'model-a',
        skill: {
          name: 'skill-name',
          path: '.cursor/skills/skill-name/SKILL.md',
          sha256: SHA256,
          content: '# Skill',
        },
        grounding: {
          provider: 'ado',
          project: 'Apex',
          repository: 'Apex',
          sha: 'abc123',
          profileId: 'profile-1',
        },
        mcpServers: [
          {
            kind: 'internal-proxy',
            serverName: 'ado-skills',
            profileId: 'profile-1',
            enableRepoBrowse: true,
          },
        ],
      })
    ).toBe(true);
  });

  it.each([
    'runId',
    'attemptId',
    'dispatchMessageId',
    'threadId',
    'userId',
  ] as const)('rejects a dispatch with malformed %s', (field) => {
    expect(
      isInteractiveDispatchOutboxPayload({
        ...validDispatch,
        [field]: `${field}-1`,
      })
    ).toBe(false);
  });

  it('accepts strict ISO timestamps on a real leap day', () => {
    expect(
      isDurableInteractiveTurnSpecification({
        ...validSpecification,
        transcript: [
          {
            id: TRANSCRIPT_MESSAGE_ID,
            role: 'agent',
            text: 'Leap day',
            timestamp: '2024-02-29T23:59:59.123Z',
          },
        ],
        toolGrant: {
          userId: USER_ID,
          projectId: 'project-1',
          allowedOperations: ['ado:read'],
          expiresAt: '2024-02-29T23:59:59+05:30',
          encryptedAdoToken: null,
        },
      })
    ).toBe(true);
  });

  it.each([
    '2026-02-30T15:00:00.000Z',
    '2025-02-29T15:00:00.000Z',
    '2026-04-31T15:00:00.000Z',
    '2026-13-01T15:00:00.000Z',
    '2026-09-23T24:00:00.000Z',
    '2026-09-23T15:00:00+14:01',
  ])('rejects impossible ISO calendar timestamp %s', (deadlineAt) => {
    expect(
      isInteractiveDispatchOutboxPayload({
        ...validDispatch,
        deadlineAt,
      })
    ).toBe(false);
  });

  it.each([
    '2026-09-23 15:00:00Z',
    '2026-09-23T15:00:00',
    '2026-09-23',
    '09/23/2026 15:00:00Z',
  ])('rejects alternate timestamp format %s', (timestamp) => {
    expect(
      isDurableInteractiveTurnSpecification({
        ...validSpecification,
        transcript: [
          {
            id: TRANSCRIPT_MESSAGE_ID,
            role: 'agent',
            text: 'Invalid timestamp',
            timestamp,
          },
        ],
      })
    ).toBe(false);
  });

  it.each([
    [
      'a class/deadline mismatch',
      {
        ...validSpecification,
        deadlines: {
          ...validSpecification.deadlines,
          absoluteTurnMs: 1_200_000,
        },
      },
    ],
    [
      'a non-positive first-event deadline',
      {
        ...validSpecification,
        deadlines: {
          ...validSpecification.deadlines,
          firstEventMs: 0,
        },
      },
    ],
    [
      'a malformed transcript timestamp',
      {
        ...validSpecification,
        transcript: [
          {
            id: TRANSCRIPT_MESSAGE_ID,
            role: 'agent',
            text: 'How can I help?',
            timestamp: 'not-a-timestamp',
          },
        ],
      },
    ],
    [
      'an invalid attachment blob ref',
      {
        ...validSpecification,
        currentMessage: {
          ...validSpecification.currentMessage,
          attachments: [
            {
              attachmentId: ATTACHMENT_ID,
              name: 'notes.txt',
              contentType: 'text/plain',
              sizeBytes: 12,
              sha256: SHA256,
              blobRef: { container: '', key: 'attachment' },
              materializedPath: 'attachments/notes.txt',
            },
          ],
        },
      },
    ],
    [
      'an unsupported MCP descriptor',
      {
        ...validSpecification,
        mcpServers: [{ kind: 'stdio', serverName: 'unsafe' }],
      },
    ],
  ])('rejects %s', (_name, candidate) => {
    expect(isDurableInteractiveTurnSpecification(candidate)).toBe(false);
  });

  it('accepts a matching interactive dispatch', () => {
    expect(isInteractiveDispatchOutboxPayload(validDispatch)).toBe(true);
  });

  it('rejects a dispatch with a mismatched lane and class', () => {
    expect(
      isInteractiveDispatchOutboxPayload({
        ...validDispatch,
        workloadLane: 'agentic',
      })
    ).toBe(false);
  });

  it('rejects dispatches with malformed deadlines or attempt numbers', () => {
    expect(
      isInteractiveDispatchOutboxPayload({
        ...validDispatch,
        attemptNumber: 0,
      })
    ).toBe(false);
    expect(
      isInteractiveDispatchOutboxPayload({
        ...validDispatch,
        deadlineAt: 'not-a-timestamp',
      })
    ).toBe(false);
  });
});
