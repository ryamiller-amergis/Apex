import {
  HARNESS_AREA_IDS,
  isHarnessAreaId,
  isHarnessContextKind,
  type HarnessAreaId,
  type HarnessContextKind,
} from '../../../shared/types/chatHarness';
import type {
  FrozenHarnessCustomTool,
  FrozenHarnessSafety,
  FrozenHarnessWriteConfirmation,
} from '../../../shared/types/durableInteractiveTurn';
import {
  INTERACTIVE_WORKFLOW_CLASSES,
  type InteractiveWorkflowClass,
} from '../../../shared/types/interactiveWorkflow';
import {
  BRAINSTORM_ARTIFACT_MAX_BYTES,
  BRAINSTORM_UPDATE_ARTIFACT_TOOL,
} from '../../../shared/types/brainstormArtifact';

/**
 * Environment variables that must be removed from any agent process when
 * `safety.shell === 'scrubbed'`. `@cursor/sdk@1.4.0` `LocalAgentOptions` has
 * no `env` field yet, so every profile currently sets `shell: 'none'` and
 * disallows `'Shell'`.
 */
export const SCRUBBED_SHELL_ENV_KEYS = [
  'CURSOR_API_KEY',
  'REDIS_KEY',
  'AI_RUNS_RUNNER_CALLBACK_TOKEN',
  'REPO_READ_SERVICE_TOKEN',
  'APPLICATIONINSIGHTS_CONNECTION_STRING',
  'AZURE_CLIENT_ID',
  'AI_PLATFORM_V2_IDENTITY_CLIENT_ID',
  'IDENTITY_ENDPOINT',
  'IDENTITY_HEADER',
] as const;

/** Repository read/search tools excluded whenever `safety.repositoryCode === 'none'`. */
export const REPOSITORY_CODE_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'LS',
  'SemanticSearch',
] as const;

export const AREA_SETTINGS_LANES = [
  'agent_home',
  'interview',
  'adr_interview',
  'prd_assistant',
  'design_doc_assistant',
  'ask_apex',
  'calendar_assistant',
  'test_case',
  'brainstorm',
  'cab_release',
  'build_intake',
  'standup',
] as const;

export type AreaSettingsLane = (typeof AREA_SETTINGS_LANES)[number];

export type HarnessProfileErrorCode =
  | 'unknown-area'
  | 'invalid-profile'
  | 'missing-skill'
  | 'missing-model'
  | 'invalid-context';

export class HarnessProfileError extends Error {
  readonly code: HarnessProfileErrorCode;
  readonly field?: string;

  constructor(
    code: HarnessProfileErrorCode,
    message: string,
    field?: string,
  ) {
    super(message);
    this.name = 'HarnessProfileError';
    this.code = code;
    if (field !== undefined) {
      this.field = field;
    }
  }
}

export type AreaProfileWriteConfirmation = FrozenHarnessWriteConfirmation &
  Readonly<{
    confirmEndpoint: string;
  }>;

export type AreaProfileSafety = FrozenHarnessSafety;

export type AreaProfileRating = Readonly<{
  endpoint: string;
  storage: string;
}>;

export type AreaProfile = Readonly<{
  area: HarnessAreaId;
  version: number;
  workflowClass: InteractiveWorkflowClass;
  permission: string;
  settingsLane: AreaSettingsLane;
  requiresSkill: boolean;
  contextKinds: ReadonlyArray<HarnessContextKind>;
  toolAllowlist: ReadonlyArray<string>;
  disallowedTools: ReadonlyArray<string>;
  customTools: ReadonlyArray<FrozenHarnessCustomTool>;
  writeConfirmation: ReadonlyArray<AreaProfileWriteConfirmation>;
  safety: AreaProfileSafety;
  recreationCapChars: number;
  rating: AreaProfileRating;
}>;

const DEFAULT_RECREATION_CAP_CHARS = 24_000;

const MESSAGE_FEEDBACK_RATING: AreaProfileRating = {
  endpoint: 'PUT /api/projects/:projectId/workflow-evaluations/message-feedback/:messageId',
  storage: 'workflow_message_feedback',
};

const SKILL_SIGNALS_RATING: AreaProfileRating = {
  endpoint: 'PUT /api/projects/:projectId/workflow-evaluations/skill-ratings',
  storage: 'skill_signals',
};

const FULL_REPO_READ_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'LS',
  'SemanticSearch',
] as const;

const SCOPED_REPO_READ_TOOLS = ['Read', 'Grep', 'Glob', 'LS'] as const;

const NO_REPO_DISALLOWED_TOOLS = ['Shell', ...REPOSITORY_CODE_TOOLS] as const;
const SHELL_ONLY_DISALLOWED_TOOLS = ['Shell'] as const;

const SAFETY_READ_ONLY: AreaProfileSafety = {
  repositoryCode: 'read',
  shell: 'none',
  settingSources: [],
};

const SAFETY_NO_REPO: AreaProfileSafety = {
  repositoryCode: 'none',
  shell: 'none',
  settingSources: [],
};

const QA_LAB_CONFIRM_ENDPOINT =
  'POST /api/interviews/qa-lab/assistant-threads/:threadId/proposals/:proposalId/confirm';

const DEFAULT_AREA_PROFILES: ReadonlyArray<AreaProfile> = [
  {
    area: 'agent-home',
    version: 1,
    workflowClass: 'home-chat',
    permission: 'chat:create',
    settingsLane: 'agent_home',
    requiresSkill: false,
    contextKinds: [],
    toolAllowlist: FULL_REPO_READ_TOOLS,
    disallowedTools: SHELL_ONLY_DISALLOWED_TOOLS,
    customTools: [
      {
        name: 'propose_ado_work_item_write',
        description:
          'Stage a proposed Azure DevOps work item create or update for explicit user confirmation.',
        inputSchema: {
          type: 'object',
          properties: {
            operation: { type: 'string', enum: ['create', 'update', 'comment', 'link'] },
            workItemId: { type: 'number' },
            fields: { type: 'object', additionalProperties: true },
            summary: { type: 'string' },
          },
          required: ['operation', 'summary'],
          additionalProperties: false,
        },
        writes: true,
        proxyTarget: 'ado-skills/propose-work-item-write',
      },
    ],
    writeConfirmation: [
      {
        tool: 'propose_ado_work_item_write',
        writes: true,
        mode: 'ask',
        confirmEndpoint: 'POST /api/calendar-assistant/proposals/:id/apply',
      },
    ],
    safety: SAFETY_READ_ONLY,
    recreationCapChars: DEFAULT_RECREATION_CAP_CHARS,
    rating: MESSAGE_FEEDBACK_RATING,
  },
  {
    area: 'interview',
    version: 1,
    workflowClass: 'interview',
    permission: 'interviews:view',
    settingsLane: 'interview',
    requiresSkill: true,
    contextKinds: ['interview'],
    toolAllowlist: [],
    disallowedTools: NO_REPO_DISALLOWED_TOOLS,
    customTools: [],
    writeConfirmation: [],
    safety: SAFETY_NO_REPO,
    recreationCapChars: DEFAULT_RECREATION_CAP_CHARS,
    rating: MESSAGE_FEEDBACK_RATING,
  },
  {
    area: 'adr',
    version: 1,
    workflowClass: 'adr',
    permission: 'adr:create',
    settingsLane: 'adr_interview',
    requiresSkill: true,
    contextKinds: ['adr'],
    toolAllowlist: FULL_REPO_READ_TOOLS,
    disallowedTools: SHELL_ONLY_DISALLOWED_TOOLS,
    customTools: [],
    writeConfirmation: [],
    safety: SAFETY_READ_ONLY,
    recreationCapChars: DEFAULT_RECREATION_CAP_CHARS,
    rating: SKILL_SIGNALS_RATING,
  },
  {
    area: 'prd-assistant',
    version: 1,
    workflowClass: 'assistant',
    permission: 'interviews:view',
    settingsLane: 'prd_assistant',
    requiresSkill: true,
    contextKinds: ['prd'],
    toolAllowlist: FULL_REPO_READ_TOOLS,
    disallowedTools: SHELL_ONLY_DISALLOWED_TOOLS,
    customTools: [
      {
        name: 'update_prd',
        description:
          'Propose a revised PRD markdown section or backlog JSON diff for owner approval.',
        inputSchema: {
          type: 'object',
          properties: {
            prdId: { type: 'string' },
            threadId: { type: 'string' },
            section: { type: 'string', enum: ['content', 'backlog'] },
            content: { type: 'string' },
          },
          required: ['prdId', 'threadId', 'section', 'content'],
          additionalProperties: false,
        },
        writes: true,
        proxyTarget: 'prd-assistant/update-prd',
      },
      {
        name: 'add_test_case',
        description:
          'Propose a structured QA test case linked to a PRD backlog item for owner approval.',
        inputSchema: {
          type: 'object',
          properties: {
            prdId: { type: 'string' },
            threadId: { type: 'string' },
            pbiId: { type: 'string' },
            title: { type: 'string' },
            steps: { type: 'array', items: { type: 'object' } },
          },
          required: ['prdId', 'threadId', 'pbiId', 'title', 'steps'],
          additionalProperties: true,
        },
        writes: true,
        proxyTarget: 'prd-assistant/add-test-case',
      },
    ],
    writeConfirmation: [
      {
        tool: 'update_prd',
        writes: true,
        mode: 'ask',
        confirmEndpoint: 'POST /api/interviews/prds/:prdId/apply-proposed',
      },
      {
        tool: 'add_test_case',
        writes: true,
        mode: 'ask',
        confirmEndpoint: 'POST /api/interviews/prds/:prdId/apply-proposed',
      },
    ],
    safety: SAFETY_READ_ONLY,
    recreationCapChars: DEFAULT_RECREATION_CAP_CHARS,
    rating: SKILL_SIGNALS_RATING,
  },
  {
    area: 'design-doc-assistant',
    version: 1,
    workflowClass: 'assistant',
    permission: 'interviews:view',
    settingsLane: 'design_doc_assistant',
    requiresSkill: true,
    contextKinds: ['design-doc'],
    toolAllowlist: FULL_REPO_READ_TOOLS,
    disallowedTools: SHELL_ONLY_DISALLOWED_TOOLS,
    customTools: [
      {
        name: 'update_design_doc',
        description:
          'Propose a revised design, tech-spec, or assumptions markdown document for owner approval.',
        inputSchema: {
          type: 'object',
          properties: {
            docId: { type: 'string' },
            threadId: { type: 'string' },
            section: { type: 'string', enum: ['design', 'tech-spec', 'assumptions'] },
            content: { type: 'string' },
          },
          required: ['docId', 'threadId', 'section', 'content'],
          additionalProperties: false,
        },
        writes: true,
        proxyTarget: 'design-doc-assistant/update-design-doc',
      },
    ],
    writeConfirmation: [
      {
        tool: 'update_design_doc',
        writes: true,
        mode: 'ask',
        confirmEndpoint: 'POST /api/interviews/design-docs/:id/apply-proposed',
      },
    ],
    safety: SAFETY_READ_ONLY,
    recreationCapChars: DEFAULT_RECREATION_CAP_CHARS,
    rating: SKILL_SIGNALS_RATING,
  },
  {
    area: 'ask-apex',
    version: 1,
    workflowClass: 'ask-apex',
    permission: 'home:view',
    settingsLane: 'ask_apex',
    requiresSkill: true,
    contextKinds: [],
    toolAllowlist: FULL_REPO_READ_TOOLS,
    disallowedTools: SHELL_ONLY_DISALLOWED_TOOLS,
    customTools: [],
    writeConfirmation: [],
    safety: SAFETY_READ_ONLY,
    recreationCapChars: DEFAULT_RECREATION_CAP_CHARS,
    rating: MESSAGE_FEEDBACK_RATING,
  },
  {
    area: 'calendar-work-item',
    version: 1,
    workflowClass: 'home-chat',
    permission: 'calendar:view',
    settingsLane: 'calendar_assistant',
    requiresSkill: true,
    contextKinds: ['work-item'],
    toolAllowlist: SCOPED_REPO_READ_TOOLS,
    disallowedTools: SHELL_ONLY_DISALLOWED_TOOLS,
    customTools: [
      {
        name: 'propose_work_item_changes',
        description:
          'Stage proposed Azure DevOps Description and Acceptance Criteria edits for diff review and explicit apply.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
            threadId: { type: 'string' },
            changes: { type: 'array', items: { type: 'object' } },
          },
          required: ['sessionId', 'threadId', 'changes'],
          additionalProperties: true,
        },
        writes: true,
        proxyTarget: 'calendar-assistant/propose-work-item-changes',
      },
    ],
    writeConfirmation: [
      {
        tool: 'propose_work_item_changes',
        writes: true,
        mode: 'ask',
        confirmEndpoint: 'POST /api/calendar-assistant/proposals/:id/apply',
      },
    ],
    safety: SAFETY_READ_ONLY,
    recreationCapChars: DEFAULT_RECREATION_CAP_CHARS,
    rating: MESSAGE_FEEDBACK_RATING,
  },
  {
    area: 'qa-lab',
    version: 1,
    workflowClass: 'home-chat',
    permission: 'interviews:manage',
    settingsLane: 'test_case',
    requiresSkill: true,
    contextKinds: ['qa-suite'],
    toolAllowlist: SCOPED_REPO_READ_TOOLS,
    disallowedTools: SHELL_ONLY_DISALLOWED_TOOLS,
    customTools: [
      {
        name: 'qa_lab_list_suites',
        description: 'List every ready QA Lab test suite in the current project.',
        inputSchema: {
          type: 'object',
          properties: { threadId: { type: 'string' } },
          required: ['threadId'],
          additionalProperties: false,
        },
        writes: false,
        proxyTarget: 'qa-lab/list-suites',
      },
      {
        name: 'qa_lab_get_cases',
        description: 'Read current cases, publish status, runs, comments, and pending proposals for a QA suite.',
        inputSchema: {
          type: 'object',
          properties: {
            threadId: { type: 'string' },
            suiteId: { type: 'string' },
          },
          required: ['threadId'],
          additionalProperties: false,
        },
        writes: false,
        proxyTarget: 'qa-lab/get-cases',
      },
      {
        name: 'qa_lab_update_case',
        description: 'Propose an edit to a QA Lab test case for confirmation.',
        inputSchema: {
          type: 'object',
          properties: {
            threadId: { type: 'string' },
            suiteId: { type: 'string' },
            localCaseId: { type: 'string' },
            patch: { type: 'object', additionalProperties: true },
            reason: { type: 'string' },
          },
          required: ['threadId', 'localCaseId', 'patch', 'reason'],
          additionalProperties: false,
        },
        writes: true,
        proxyTarget: 'qa-lab/update-case',
      },
      {
        name: 'qa_lab_add_case',
        description: 'Propose adding a new QA Lab test case for confirmation.',
        inputSchema: {
          type: 'object',
          properties: {
            threadId: { type: 'string' },
            suiteId: { type: 'string' },
            pbiId: { type: 'string' },
            testCase: { type: 'object', additionalProperties: true },
            reason: { type: 'string' },
          },
          required: ['threadId', 'pbiId', 'testCase', 'reason'],
          additionalProperties: false,
        },
        writes: true,
        proxyTarget: 'qa-lab/add-case',
      },
      {
        name: 'qa_lab_delete_case',
        description: 'Propose removing a QA Lab test case for confirmation.',
        inputSchema: {
          type: 'object',
          properties: {
            threadId: { type: 'string' },
            suiteId: { type: 'string' },
            localCaseId: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['threadId', 'localCaseId', 'reason'],
          additionalProperties: false,
        },
        writes: true,
        proxyTarget: 'qa-lab/delete-case',
      },
      {
        name: 'qa_lab_comment_case',
        description: 'Propose a review comment on a QA Lab test case for confirmation.',
        inputSchema: {
          type: 'object',
          properties: {
            threadId: { type: 'string' },
            suiteId: { type: 'string' },
            localCaseId: { type: 'string' },
            body: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['threadId', 'localCaseId', 'body', 'reason'],
          additionalProperties: false,
        },
        writes: true,
        proxyTarget: 'qa-lab/comment-case',
      },
      {
        name: 'qa_lab_regenerate_case',
        description: 'Propose regenerating a QA Lab test case from its open comments.',
        inputSchema: {
          type: 'object',
          properties: {
            threadId: { type: 'string' },
            suiteId: { type: 'string' },
            localCaseId: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['threadId', 'localCaseId', 'reason'],
          additionalProperties: false,
        },
        writes: true,
        proxyTarget: 'qa-lab/regenerate-case',
      },
    ],
    writeConfirmation: [
      {
        tool: 'qa_lab_update_case',
        writes: true,
        mode: 'ask',
        confirmEndpoint: QA_LAB_CONFIRM_ENDPOINT,
      },
      {
        tool: 'qa_lab_add_case',
        writes: true,
        mode: 'ask',
        confirmEndpoint: QA_LAB_CONFIRM_ENDPOINT,
      },
      {
        tool: 'qa_lab_delete_case',
        writes: true,
        mode: 'ask',
        confirmEndpoint: QA_LAB_CONFIRM_ENDPOINT,
      },
      {
        tool: 'qa_lab_comment_case',
        writes: true,
        mode: 'ask',
        confirmEndpoint: QA_LAB_CONFIRM_ENDPOINT,
      },
      {
        tool: 'qa_lab_regenerate_case',
        writes: true,
        mode: 'ask',
        confirmEndpoint: QA_LAB_CONFIRM_ENDPOINT,
      },
    ],
    safety: SAFETY_READ_ONLY,
    recreationCapChars: DEFAULT_RECREATION_CAP_CHARS,
    rating: SKILL_SIGNALS_RATING,
  },
  {
    area: 'brainstorm',
    version: 1,
    workflowClass: 'brainstorm',
    permission: 'brainstorm:create',
    settingsLane: 'brainstorm',
    requiresSkill: true,
    contextKinds: ['brainstorm-session'],
    toolAllowlist: FULL_REPO_READ_TOOLS,
    disallowedTools: SHELL_ONLY_DISALLOWED_TOOLS,
    customTools: [
      {
        name: BRAINSTORM_UPDATE_ARTIFACT_TOOL,
        description:
          'Propose a complete revised Brainstorm artifact markdown document as a new version.',
        inputSchema: {
          type: 'object',
          properties: {
            markdown: {
              type: 'string',
              description: `Complete artifact Markdown (at most ${BRAINSTORM_ARTIFACT_MAX_BYTES} bytes).`,
            },
          },
          required: ['markdown'],
          additionalProperties: false,
        },
        writes: true,
        proxyTarget: 'brainstorm-artifact/update',
      },
    ],
    writeConfirmation: [
      {
        tool: BRAINSTORM_UPDATE_ARTIFACT_TOOL,
        writes: true,
        mode: 'ask',
        confirmEndpoint: 'POST /api/brainstorm/sessions/:id/artifact',
      },
    ],
    safety: SAFETY_READ_ONLY,
    recreationCapChars: DEFAULT_RECREATION_CAP_CHARS,
    rating: SKILL_SIGNALS_RATING,
  },
  {
    area: 'cab-release',
    version: 1,
    workflowClass: 'home-chat',
    permission: 'planning:releases',
    settingsLane: 'cab_release',
    requiresSkill: true,
    contextKinds: ['release'],
    toolAllowlist: SCOPED_REPO_READ_TOOLS,
    disallowedTools: SHELL_ONLY_DISALLOWED_TOOLS,
    customTools: [
      {
        name: 'cab-request',
        description:
          'Propose a ServiceNow CAB change request requiring an explicit dry-run or prod choice before submission.',
        inputSchema: {
          type: 'object',
          properties: {
            targetVersion: { type: 'string' },
            mode: { type: 'string', enum: ['dry-run', 'prod'] },
            summary: { type: 'string' },
          },
          required: ['targetVersion', 'mode'],
          additionalProperties: true,
        },
        writes: true,
        proxyTarget: 'cab-release/propose-request',
      },
    ],
    writeConfirmation: [
      {
        tool: 'cab-request',
        writes: true,
        mode: 'ask',
        confirmEndpoint: 'POST /api/internal/cab-release/ado',
      },
    ],
    safety: SAFETY_READ_ONLY,
    recreationCapChars: DEFAULT_RECREATION_CAP_CHARS,
    rating: MESSAGE_FEEDBACK_RATING,
  },
  {
    area: 'build-intake',
    version: 1,
    workflowClass: 'interview',
    permission: 'interviews:view',
    settingsLane: 'build_intake',
    requiresSkill: true,
    contextKinds: ['build-intake'],
    toolAllowlist: [],
    disallowedTools: NO_REPO_DISALLOWED_TOOLS,
    customTools: [],
    writeConfirmation: [],
    safety: SAFETY_NO_REPO,
    recreationCapChars: DEFAULT_RECREATION_CAP_CHARS,
    rating: SKILL_SIGNALS_RATING,
  },
  {
    area: 'standup-participant',
    version: 1,
    workflowClass: 'home-chat',
    permission: 'standup:participate',
    settingsLane: 'standup',
    requiresSkill: true,
    contextKinds: ['standup-session'],
    toolAllowlist: SCOPED_REPO_READ_TOOLS,
    disallowedTools: SHELL_ONLY_DISALLOWED_TOOLS,
    customTools: [],
    writeConfirmation: [],
    safety: SAFETY_READ_ONLY,
    recreationCapChars: DEFAULT_RECREATION_CAP_CHARS,
    rating: MESSAGE_FEEDBACK_RATING,
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isAreaSettingsLane(value: unknown): value is AreaSettingsLane {
  return (
    typeof value === 'string' &&
    (AREA_SETTINGS_LANES as readonly string[]).includes(value)
  );
}

function isWorkflowClass(value: unknown): value is InteractiveWorkflowClass {
  return (
    typeof value === 'string' &&
    (INTERACTIVE_WORKFLOW_CLASSES as readonly string[]).includes(value)
  );
}

export function assertAreaProfile(profile: unknown): asserts profile is AreaProfile {
  if (!isRecord(profile)) {
    throw new HarnessProfileError(
      'invalid-profile',
      'Area profile must be an object',
    );
  }

  if (!isHarnessAreaId(profile.area)) {
    throw new HarnessProfileError(
      'invalid-profile',
      'Area profile requires a valid area id',
      'area',
    );
  }

  const area = profile.area;

  if (!Number.isSafeInteger(profile.version) || (profile.version as number) <= 0) {
    throw new HarnessProfileError(
      'invalid-profile',
      `Area profile "${area}" requires a positive integer version`,
      'version',
    );
  }

  if (!isWorkflowClass(profile.workflowClass)) {
    throw new HarnessProfileError(
      'invalid-profile',
      `Area profile "${area}" requires a valid workflowClass`,
      'workflowClass',
    );
  }

  if (!isNonEmptyString(profile.permission)) {
    throw new HarnessProfileError(
      'invalid-profile',
      `Area profile "${area}" is missing required field "permission"`,
      'permission',
    );
  }

  if (!isAreaSettingsLane(profile.settingsLane)) {
    throw new HarnessProfileError(
      'invalid-profile',
      `Area profile "${area}" requires a valid settingsLane`,
      'settingsLane',
    );
  }

  if (typeof profile.requiresSkill !== 'boolean') {
    throw new HarnessProfileError(
      'invalid-profile',
      `Area profile "${area}" requires a boolean requiresSkill`,
      'requiresSkill',
    );
  }

  if (
    !Array.isArray(profile.contextKinds) ||
    !profile.contextKinds.every(isHarnessContextKind)
  ) {
    throw new HarnessProfileError(
      'invalid-profile',
      `Area profile "${area}" requires a valid contextKinds array`,
      'contextKinds',
    );
  }

  if (
    !Array.isArray(profile.toolAllowlist) ||
    !profile.toolAllowlist.every(isNonEmptyString)
  ) {
    throw new HarnessProfileError(
      'invalid-profile',
      `Area profile "${area}" requires a toolAllowlist array of tool names`,
      'toolAllowlist',
    );
  }

  if (
    !Array.isArray(profile.disallowedTools) ||
    !profile.disallowedTools.every(isNonEmptyString)
  ) {
    throw new HarnessProfileError(
      'invalid-profile',
      `Area profile "${area}" requires a disallowedTools array of tool names`,
      'disallowedTools',
    );
  }

  if (!Array.isArray(profile.customTools)) {
    throw new HarnessProfileError(
      'invalid-profile',
      `Area profile "${area}" requires a customTools array`,
      'customTools',
    );
  }

  for (const tool of profile.customTools) {
    if (
      !isRecord(tool) ||
      !isNonEmptyString(tool.name) ||
      typeof tool.description !== 'string' ||
      !isRecord(tool.inputSchema) ||
      typeof tool.writes !== 'boolean' ||
      !isNonEmptyString(tool.proxyTarget)
    ) {
      throw new HarnessProfileError(
        'invalid-profile',
        `Area profile "${area}" has an invalid customTools entry`,
        'customTools',
      );
    }
  }

  if (!Array.isArray(profile.writeConfirmation)) {
    throw new HarnessProfileError(
      'invalid-profile',
      `Area profile "${area}" requires a writeConfirmation array`,
      'writeConfirmation',
    );
  }

  const writeConfirmationByTool = new Map<string, AreaProfileWriteConfirmation>();
  for (const rule of profile.writeConfirmation) {
    if (
      !isRecord(rule) ||
      !isNonEmptyString(rule.tool) ||
      typeof rule.writes !== 'boolean' ||
      (rule.mode !== 'ask' && rule.mode !== 'allow') ||
      !isNonEmptyString(rule.confirmEndpoint)
    ) {
      throw new HarnessProfileError(
        'invalid-profile',
        `Area profile "${area}" has an invalid writeConfirmation entry`,
        'writeConfirmation',
      );
    }
    if (rule.writes && rule.mode !== 'ask') {
      throw new HarnessProfileError(
        'invalid-profile',
        `Area profile "${area}" write tool "${rule.tool}" must use writeConfirmation mode "ask"`,
        'writeConfirmation',
      );
    }
    writeConfirmationByTool.set(rule.tool, rule as AreaProfileWriteConfirmation);
  }

  for (const tool of profile.customTools as ReadonlyArray<FrozenHarnessCustomTool>) {
    if (!tool.writes) continue;
    const rule = writeConfirmationByTool.get(tool.name);
    if (!rule || !rule.writes || rule.mode !== 'ask') {
      throw new HarnessProfileError(
        'invalid-profile',
        `Area profile "${area}" write tool "${tool.name}" requires writeConfirmation mode "ask"`,
        'writeConfirmation',
      );
    }
  }

  if (!isRecord(profile.safety)) {
    throw new HarnessProfileError(
      'invalid-profile',
      `Area profile "${area}" requires a safety block`,
      'safety',
    );
  }

  const { repositoryCode, shell, settingSources } = profile.safety;
  if (repositoryCode !== 'none' && repositoryCode !== 'read') {
    throw new HarnessProfileError(
      'invalid-profile',
      `Area profile "${area}" requires safety.repositoryCode to be "none" or "read"`,
      'safety.repositoryCode',
    );
  }
  if (shell !== 'none' && shell !== 'scrubbed') {
    throw new HarnessProfileError(
      'invalid-profile',
      `Area profile "${area}" requires safety.shell to be "none" or "scrubbed"`,
      'safety.shell',
    );
  }
  if (!Array.isArray(settingSources) || settingSources.length !== 0) {
    throw new HarnessProfileError(
      'invalid-profile',
      `Area profile "${area}" requires safety.settingSources to be an empty array`,
      'safety.settingSources',
    );
  }

  const toolAllowlist = profile.toolAllowlist as ReadonlyArray<string>;
  const disallowedTools = profile.disallowedTools as ReadonlyArray<string>;

  if (shell === 'none') {
    if (!disallowedTools.includes('Shell') || toolAllowlist.includes('Shell')) {
      throw new HarnessProfileError(
        'invalid-profile',
        `Area profile "${area}" with safety.shell "none" must disallow "Shell"`,
        'disallowedTools',
      );
    }
  }

  if (repositoryCode === 'none') {
    for (const repoTool of REPOSITORY_CODE_TOOLS) {
      if (toolAllowlist.includes(repoTool)) {
        throw new HarnessProfileError(
          'invalid-profile',
          `Area profile "${area}" with safety.repositoryCode "none" must not allow "${repoTool}"`,
          'toolAllowlist',
        );
      }
    }
  }

  if (
    !Number.isSafeInteger(profile.recreationCapChars) ||
    (profile.recreationCapChars as number) <= 0
  ) {
    throw new HarnessProfileError(
      'invalid-profile',
      `Area profile "${area}" requires a positive integer recreationCapChars`,
      'recreationCapChars',
    );
  }

  if (!isRecord(profile.rating)) {
    throw new HarnessProfileError(
      'invalid-profile',
      `Area profile "${area}" requires a rating block`,
      'rating',
    );
  }
  if (!isNonEmptyString(profile.rating.endpoint)) {
    throw new HarnessProfileError(
      'invalid-profile',
      `Area profile "${area}" requires rating.endpoint`,
      'rating.endpoint',
    );
  }
  if (!isNonEmptyString(profile.rating.storage)) {
    throw new HarnessProfileError(
      'invalid-profile',
      `Area profile "${area}" requires rating.storage`,
      'rating.storage',
    );
  }
}

export function buildAreaProfileRegistry(
  profiles: ReadonlyArray<AreaProfile>,
  options?: { requireAllAreas?: boolean },
): ReadonlyMap<HarnessAreaId, AreaProfile> {
  const registry = new Map<HarnessAreaId, AreaProfile>();

  for (const profile of profiles) {
    assertAreaProfile(profile);
    if (registry.has(profile.area)) {
      throw new HarnessProfileError(
        'invalid-profile',
        `Duplicate area profile for "${profile.area}"`,
        'area',
      );
    }
    registry.set(profile.area, profile);
  }

  if (options?.requireAllAreas) {
    for (const area of HARNESS_AREA_IDS) {
      if (!registry.has(area)) {
        throw new HarnessProfileError(
          'invalid-profile',
          `Area profile registry is missing required area "${area}"`,
          'area',
        );
      }
    }
  }

  return registry;
}

export const AREA_PROFILES: ReadonlyMap<HarnessAreaId, AreaProfile> =
  buildAreaProfileRegistry(DEFAULT_AREA_PROFILES, { requireAllAreas: true });

export function getAreaProfile(area: string): AreaProfile {
  const trimmed = typeof area === 'string' ? area.trim() : '';
  if (!isHarnessAreaId(trimmed)) {
    throw new HarnessProfileError(
      'unknown-area',
      `Unknown chat harness area "${String(area)}"`,
      'area',
    );
  }
  const profile = AREA_PROFILES.get(trimmed);
  if (!profile) {
    throw new HarnessProfileError(
      'unknown-area',
      `Unknown chat harness area "${trimmed}"`,
      'area',
    );
  }
  return profile;
}
