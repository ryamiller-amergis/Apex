import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DURABLE_INTERACTIVE_SPEC_VERSION,
  type DurableInteractiveTurnSpecification,
  type FrozenHarnessSpec,
  type FrozenInteractiveMcpDescriptor,
  type FrozenInteractiveToolGrant,
} from '../../../shared/types/durableInteractiveTurn';
import { BRAINSTORM_UPDATE_ARTIFACT_TOOL } from '../../../shared/types/brainstormArtifact';
import { HARNESS_AREA_IDS } from '../../../shared/types/chatHarness';
import { AREA_PROFILES, getAreaProfile } from '../../services/chatHarness/areaProfiles';
import { toFrozenHarnessSpec } from '../../services/chatHarness/areaProfileResolver';
import {
  CustomToolRegistryError,
  confirmCustomToolProposal,
  dispatchHarnessCustomTool,
  listRegisteredCustomTools,
  type CustomToolProposalRecord,
  type CustomToolProposalResult,
} from '../../services/chatHarness/customToolRegistry';
import {
  InteractiveToolProxyError,
  invokeInteractiveToolProxy,
} from '../../services/interactiveToolProxyService';
import { encryptInteractiveToolGrant } from '../../services/interactiveToolGrantCrypto';
import {
  buildHarnessSdkCustomTools,
  resolveHarnessWritePermissionMode,
} from '../../services/interactiveActorHost/harnessCustomTools';
import { buildSdkAgentOptions } from '../../services/cursorSdkAdapter/options';

const SECRET = 'unit-test-session-secret-with-sufficient-entropy-for-custom-tools';
const FUTURE_ISO = '2099-01-01T00:00:00.000Z';
const PAST_ISO = '2020-01-01T00:00:00.000Z';

function makeGrant(
  overrides: Partial<{
    userId: string;
    projectId: string;
    allowedOperations: ReadonlyArray<'ado:read' | 'ado:write'>;
    delegatedAdoToken: string | null;
    expiresAt: string;
  }> = {},
): FrozenInteractiveToolGrant {
  return encryptInteractiveToolGrant(
    {
      userId: overrides.userId ?? 'user-1',
      projectId: overrides.projectId ?? 'project-1',
      allowedOperations: overrides.allowedOperations ?? ['ado:write'],
      delegatedAdoToken:
        overrides.delegatedAdoToken !== undefined
          ? overrides.delegatedAdoToken
          : 'delegated-ado-token',
      expiresAt: overrides.expiresAt ?? FUTURE_ISO,
    },
    { secret: SECRET },
  );
}

function makeCustomToolSpec(
  descriptor: Extract<FrozenInteractiveMcpDescriptor, { kind: 'custom-tool' }>,
  overrides: Partial<DurableInteractiveTurnSpecification> = {},
): DurableInteractiveTurnSpecification {
  return {
    schemaVersion: DURABLE_INTERACTIVE_SPEC_VERSION,
    kind: 'interactive-turn',
    turnId: '11111111-1111-4111-8111-111111111111',
    threadId: '22222222-2222-4222-8222-222222222222',
    userId: 'user-1',
    projectId: 'project-1',
    interactiveClass: 'fast',
    workflowClass: 'assistant',
    model: 'auto',
    effort: null,
    skill: null,
    currentMessage: {
      id: '33333333-3333-4333-8333-333333333333',
      text: 'propose change',
      hidden: false,
      attachments: [],
    },
    transcript: [],
    grounding: null,
    mcpServers: [descriptor],
    toolGrant: makeGrant(),
    currentPrompt: 'current',
    recreationPrompt: 'recreation',
    deadlines: {
      absoluteTurnMs: 300_000,
      repositoryPreparationMs: null,
      firstEventMs: 30_000,
      toolCallMs: 15_000,
    },
    ...overrides,
  };
}

function makeClaims(serverName: string) {
  return {
    runId: 'run-1',
    attemptId: 'attempt-1',
    dispatchMessageId: 'fence-1',
    serverName,
    expiresAt: FUTURE_ISO,
  };
}

describe('W3-B / S8 — Custom tools through the tool proxy (TBI-012, PBI-009)', () => {
  const originalSessionSecret = process.env.SESSION_SECRET;

  beforeEach(() => {
    process.env.SESSION_SECRET = SECRET;
  });

  afterEach(() => {
    if (originalSessionSecret === undefined) {
      delete process.env.SESSION_SECRET;
    } else {
      process.env.SESSION_SECRET = originalSessionSecret;
    }
  });

  describe('TBI-012 DoD-0 — Area profile declarations & registry parity', () => {
    it('declares every required area action as a custom tool in AREA_PROFILES', () => {
      const expectedDeclarations: ReadonlyArray<{
        area: (typeof HARNESS_AREA_IDS)[number];
        toolName: string;
        proxyTarget: string;
        writes: boolean;
      }> = [
        {
          area: 'brainstorm',
          toolName: BRAINSTORM_UPDATE_ARTIFACT_TOOL,
          proxyTarget: 'brainstorm-artifact/update',
          writes: true,
        },
        {
          area: 'prd-assistant',
          toolName: 'update_prd',
          proxyTarget: 'prd-assistant/update-prd',
          writes: true,
        },
        {
          area: 'prd-assistant',
          toolName: 'add_test_case',
          proxyTarget: 'prd-assistant/add-test-case',
          writes: true,
        },
        {
          area: 'design-doc-assistant',
          toolName: 'update_design_doc',
          proxyTarget: 'design-doc-assistant/update-design-doc',
          writes: true,
        },
        {
          area: 'agent-home',
          toolName: 'propose_ado_work_item_write',
          proxyTarget: 'ado-skills/propose-work-item-write',
          writes: true,
        },
        {
          area: 'calendar-work-item',
          toolName: 'propose_work_item_changes',
          proxyTarget: 'calendar-assistant/propose-work-item-changes',
          writes: true,
        },
        {
          area: 'qa-lab',
          toolName: 'qa_lab_list_suites',
          proxyTarget: 'qa-lab/list-suites',
          writes: false,
        },
        {
          area: 'qa-lab',
          toolName: 'qa_lab_get_cases',
          proxyTarget: 'qa-lab/get-cases',
          writes: false,
        },
        {
          area: 'qa-lab',
          toolName: 'qa_lab_update_case',
          proxyTarget: 'qa-lab/update-case',
          writes: true,
        },
        {
          area: 'qa-lab',
          toolName: 'qa_lab_add_case',
          proxyTarget: 'qa-lab/add-case',
          writes: true,
        },
        {
          area: 'qa-lab',
          toolName: 'qa_lab_delete_case',
          proxyTarget: 'qa-lab/delete-case',
          writes: true,
        },
        {
          area: 'qa-lab',
          toolName: 'qa_lab_comment_case',
          proxyTarget: 'qa-lab/comment-case',
          writes: true,
        },
        {
          area: 'qa-lab',
          toolName: 'qa_lab_regenerate_case',
          proxyTarget: 'qa-lab/regenerate-case',
          writes: true,
        },
        {
          area: 'cab-release',
          toolName: 'cab-request',
          proxyTarget: 'cab-release/propose-request',
          writes: true,
        },
      ];

      const registered = listRegisteredCustomTools();
      const registeredByTarget = new Map(
        registered.map((entry) => [entry.proxyTarget, entry]),
      );

      for (const expected of expectedDeclarations) {
        const profile = getAreaProfile(expected.area);
        const tool = profile.customTools.find((t) => t.name === expected.toolName);
        expect(tool).toBeDefined();
        expect(tool?.proxyTarget).toBe(expected.proxyTarget);
        expect(tool?.writes).toBe(expected.writes);

        const reg = registeredByTarget.get(expected.proxyTarget);
        expect(reg).toBeDefined();
        expect(reg?.toolName).toBe(expected.toolName);
        expect(reg?.writes).toBe(expected.writes);
      }
    });
  });

  describe('VT-27 / PBI-009 AC-0 / TBI-012 DoD-1 — PRD diff proposal waits for confirm', () => {
    it('records a PRD proposal through the tool proxy without mutating the PRD until confirmed', async () => {
      const prdStore = new Map<string, string>([
        ['prd-42', '# Original PRD\nUnchanged content'],
      ]);
      const recordedProposals: CustomToolProposalRecord[] = [];

      const descriptor: Extract<FrozenInteractiveMcpDescriptor, { kind: 'custom-tool' }> = {
        kind: 'custom-tool',
        serverName: 'prd-assistant/update-prd',
        toolName: 'update_prd',
        proxyTarget: 'prd-assistant/update-prd',
        writes: true,
        enableRepoBrowse: false,
      };

      const result = (await invokeInteractiveToolProxy({
        claims: makeClaims('prd-assistant/update-prd'),
        specification: makeCustomToolSpec(descriptor),
        body: {
          toolName: 'update_prd',
          args: {
            prdId: 'prd-42',
            threadId: '22222222-2222-4222-8222-222222222222',
            section: 'content',
            content: '# Updated PRD\nAccepted diff content',
          },
        },
        invokeCustomTool: (context) =>
          dispatchHarnessCustomTool(context, {
            recordProposal: (record) => {
              recordedProposals.push(record);
            },
          }),
      })) as CustomToolProposalResult;

      // Before accept, PRD is completely unchanged
      expect(prdStore.get('prd-42')).toBe('# Original PRD\nUnchanged content');
      expect(result.status).toBe('proposal_recorded');
      expect(result.requiresConfirmation).toBe(true);
      expect(result.proposalId).toBeTruthy();
      expect(result.confirmEndpoint).toBe(
        'POST /api/interviews/prds/:prdId/apply-proposed',
      );
      expect(result.message).toMatch(/waiting for explicit user confirmation/i);
      expect(recordedProposals).toHaveLength(1);

      // When the user accepts the diff, the change is applied
      const confirmResult = await confirmCustomToolProposal(
        {
          proposal: recordedProposals[0],
          actorUserId: 'user-1',
        },
        {
          authorizeWrite: () => true,
          applyProposal: async ({ proposal }) => {
            prdStore.set(
              String(proposal.args.prdId),
              String(proposal.args.content),
            );
            return { prdId: proposal.args.prdId, updated: true };
          },
        },
      );

      expect(confirmResult.status).toBe('applied');
      expect(confirmResult.applied).toBe(true);
      expect(confirmResult.canRetry).toBe(false);
      expect(prdStore.get('prd-42')).toBe('# Updated PRD\nAccepted diff content');
    });

    it('records proposals without direct writes for Brainstorm, Design Doc, and QA Lab write tools', async () => {
      const cases: ReadonlyArray<{
        proxyTarget: string;
        toolName: string;
        args: Record<string, unknown>;
        expectedEndpoint: string;
      }> = [
        {
          proxyTarget: 'brainstorm-artifact/update',
          toolName: BRAINSTORM_UPDATE_ARTIFACT_TOOL,
          args: { markdown: '# New brainstorm draft\n- Idea A' },
          expectedEndpoint: 'POST /api/brainstorm/sessions/:id/artifact',
        },
        {
          proxyTarget: 'design-doc-assistant/update-design-doc',
          toolName: 'update_design_doc',
          args: {
            docId: 'doc-9',
            threadId: '22222222-2222-4222-8222-222222222222',
            section: 'tech-spec',
            content: '## Revised Architecture',
          },
          expectedEndpoint: 'POST /api/interviews/design-docs/:id/apply-proposed',
        },
        {
          proxyTarget: 'qa-lab/update-case',
          toolName: 'qa_lab_update_case',
          args: {
            threadId: '22222222-2222-4222-8222-222222222222',
            localCaseId: 'tc-1',
            patch: { title: 'Updated login check' },
            reason: 'Clarify step 2',
          },
          expectedEndpoint:
            'POST /api/interviews/qa-lab/assistant-threads/:threadId/proposals/:proposalId/confirm',
        },
      ];

      for (const testCase of cases) {
        const descriptor: Extract<FrozenInteractiveMcpDescriptor, { kind: 'custom-tool' }> = {
          kind: 'custom-tool',
          serverName: testCase.proxyTarget,
          toolName: testCase.toolName,
          proxyTarget: testCase.proxyTarget,
          writes: true,
          enableRepoBrowse: false,
        };

        const result = (await invokeInteractiveToolProxy({
          claims: makeClaims(testCase.proxyTarget),
          specification: makeCustomToolSpec(descriptor),
          body: { toolName: testCase.toolName, args: testCase.args },
        })) as CustomToolProposalResult;

        expect(result.status).toBe('proposal_recorded');
        expect(result.requiresConfirmation).toBe(true);
        expect(result.confirmEndpoint).toBe(testCase.expectedEndpoint);
        expect(result.proposalId).toBeTruthy();
      }
    });
  });

  describe('VT-28 / PBI-009 AC-1 — Failed ADO write leaves no applied claim and allows retry', () => {
    it('marks proposal failed with error when ADO throws on confirm and supports retry', async () => {
      const recorded: CustomToolProposalRecord[] = [];
      const persistedStatuses: CustomToolProposalRecord[] = [];
      const adoApply = jest
        .fn()
        .mockRejectedValueOnce(new Error('ADO 503: Service Unavailable'))
        .mockResolvedValueOnce({ workItemId: 5001, rev: 2 });

      const descriptor: Extract<FrozenInteractiveMcpDescriptor, { kind: 'custom-tool' }> = {
        kind: 'custom-tool',
        serverName: 'ado-skills/propose-work-item-write',
        toolName: 'propose_ado_work_item_write',
        proxyTarget: 'ado-skills/propose-work-item-write',
        writes: true,
        enableRepoBrowse: false,
      };

      const staged = (await invokeInteractiveToolProxy({
        claims: makeClaims('ado-skills/propose-work-item-write'),
        specification: makeCustomToolSpec(descriptor),
        body: {
          toolName: 'propose_ado_work_item_write',
          args: {
            operation: 'update',
            workItemId: 5001,
            fields: { 'System.Title': 'Fix checkout timeout' },
            summary: 'Update title on PBI 5001',
          },
        },
        invokeCustomTool: (context) =>
          dispatchHarnessCustomTool(context, {
            recordProposal: (record) => {
              recorded.push(record);
            },
          }),
      })) as CustomToolProposalResult;

      expect(staged.status).toBe('proposal_recorded');
      expect(adoApply).not.toHaveBeenCalled();

      // First confirm fails downstream in ADO
      const failedConfirm = await confirmCustomToolProposal(
        {
          proposal: recorded[0],
          actorUserId: 'user-1',
        },
        {
          authorizeWrite: () => true,
          applyProposal: adoApply,
          updateProposalStatus: (updated) => {
            persistedStatuses.push(updated);
          },
        },
      );

      expect(failedConfirm.status).toBe('failed');
      expect(failedConfirm.applied).toBe(false);
      expect(failedConfirm.result).toBeUndefined();
      expect(failedConfirm.error).toContain('ADO 503: Service Unavailable');
      expect(failedConfirm.canRetry).toBe(true);
      expect(persistedStatuses[0].status).toBe('failed');

      // User retries confirming the failed proposal
      const retryConfirm = await confirmCustomToolProposal(
        {
          proposal: failedConfirm.proposal,
          actorUserId: 'user-1',
        },
        {
          authorizeWrite: () => true,
          applyProposal: adoApply,
          updateProposalStatus: (updated) => {
            persistedStatuses.push(updated);
          },
        },
      );

      expect(retryConfirm.status).toBe('applied');
      expect(retryConfirm.applied).toBe(true);
      expect(retryConfirm.result).toEqual({ workItemId: 5001, rev: 2 });
      expect(persistedStatuses[1].status).toBe('applied');
    });
  });

  describe('VT-29 / PBI-009 AC-2 — CAB request requires explicit dry-run or prod choice', () => {
    it('records a CAB proposal requiring dry-run or prod choice and submits nothing until chosen', async () => {
      const recorded: CustomToolProposalRecord[] = [];
      const submitCab = jest.fn().mockResolvedValue({ changeNumber: 'CHG0012345' });

      const descriptor: Extract<FrozenInteractiveMcpDescriptor, { kind: 'custom-tool' }> = {
        kind: 'custom-tool',
        serverName: 'cab-release/propose-request',
        toolName: 'cab-request',
        proxyTarget: 'cab-release/propose-request',
        writes: true,
        enableRepoBrowse: false,
      };

      const staged = (await invokeInteractiveToolProxy({
        claims: makeClaims('cab-release/propose-request'),
        specification: makeCustomToolSpec(descriptor),
        body: {
          toolName: 'cab-request',
          args: {
            targetVersion: '2026.11.1',
            mode: 'dry-run',
            summary: 'Release 2026.11.1 CAB request',
          },
        },
        invokeCustomTool: (context) =>
          dispatchHarnessCustomTool(context, {
            recordProposal: (record) => {
              recorded.push(record);
            },
          }),
      })) as CustomToolProposalResult;

      expect(staged.status).toBe('proposal_recorded');
      expect(staged.requiresConfirmation).toBe(true);
      expect(staged.requiresChoice).toEqual(['dry-run', 'prod']);
      expect(submitCab).not.toHaveBeenCalled();

      // Confirming without choosing dry-run or prod is rejected without submitting
      await expect(
        confirmCustomToolProposal(
          {
            proposal: recorded[0],
            actorUserId: 'user-1',
          },
          {
            authorizeWrite: () => true,
            applyProposal: submitCab,
          },
        ),
      ).rejects.toMatchObject({
        name: 'CustomToolRegistryError',
        status: 400,
      });
      expect(submitCab).not.toHaveBeenCalled();

      // Confirming with explicit 'dry-run' choice submits with that choice
      const confirmed = await confirmCustomToolProposal(
        {
          proposal: recorded[0],
          actorUserId: 'user-1',
          choice: 'dry-run',
        },
        {
          authorizeWrite: () => true,
          applyProposal: submitCab,
        },
      );

      expect(confirmed.status).toBe('applied');
      expect(confirmed.applied).toBe(true);
      expect(confirmed.choice).toBe('dry-run');
      expect(submitCab).toHaveBeenCalledWith(
        expect.objectContaining({
          choice: 'dry-run',
          actorUserId: 'user-1',
        }),
      );
    });
  });

  describe('VT-30 / PBI-009 AC-3 / TBI-012 DoD-2 — Unauthorized confirm & invalid grants rejected', () => {
    it('refuses confirmation when user lacks write access and makes no data change', async () => {
      const applyProposal = jest.fn();
      const proposal: CustomToolProposalRecord = {
        proposalId: 'prop-99',
        area: 'prd-assistant',
        permission: 'interviews:view',
        toolName: 'update_prd',
        proxyTarget: 'prd-assistant/update-prd',
        threadId: '22222222-2222-4222-8222-222222222222',
        projectId: 'project-1',
        userId: 'user-1',
        status: 'pending',
        args: {
          prdId: 'prd-42',
          threadId: '22222222-2222-4222-8222-222222222222',
          section: 'content',
          content: 'unauthorized edit',
        },
        confirmEndpoint: 'POST /api/interviews/prds/:prdId/apply-proposed',
        createdAt: '2026-11-19T00:00:00.000Z',
      };

      await expect(
        confirmCustomToolProposal(
          {
            proposal,
            actorUserId: 'viewer-user',
          },
          {
            authorizeWrite: () => false,
            applyProposal,
          },
        ),
      ).rejects.toMatchObject({
        name: 'CustomToolRegistryError',
        status: 403,
      });

      expect(applyProposal).not.toHaveBeenCalled();
    });

    it('rejects missing, expired, mismatched, and tampered tool grants with 403', async () => {
      const descriptor: Extract<FrozenInteractiveMcpDescriptor, { kind: 'custom-tool' }> = {
        kind: 'custom-tool',
        serverName: 'ado-skills/propose-work-item-write',
        toolName: 'propose_ado_work_item_write',
        proxyTarget: 'ado-skills/propose-work-item-write',
        writes: true,
        enableRepoBrowse: false,
      };
      const body = {
        toolName: 'propose_ado_work_item_write',
        args: { operation: 'create', summary: 'Create PBI' },
      };

      // Missing grant
      await expect(
        invokeInteractiveToolProxy({
          claims: makeClaims(descriptor.serverName),
          specification: makeCustomToolSpec(descriptor, { toolGrant: null }),
          body,
        }),
      ).rejects.toMatchObject({
        name: 'InteractiveToolProxyError',
        status: 403,
      });

      // Expired grant
      await expect(
        invokeInteractiveToolProxy({
          claims: makeClaims(descriptor.serverName),
          specification: makeCustomToolSpec(descriptor, {
            toolGrant: makeGrant({ expiresAt: PAST_ISO }),
          }),
          body,
        }),
      ).rejects.toMatchObject({
        name: 'InteractiveToolProxyError',
        status: 403,
      });

      // Mismatched userId
      await expect(
        invokeInteractiveToolProxy({
          claims: makeClaims(descriptor.serverName),
          specification: makeCustomToolSpec(descriptor, {
            toolGrant: makeGrant({ userId: 'other-user' }),
          }),
          body,
        }),
      ).rejects.toMatchObject({
        name: 'InteractiveToolProxyError',
        status: 403,
      });

      // Tampered ciphertext
      const validGrant = makeGrant();
      const tamperedGrant: FrozenInteractiveToolGrant = {
        ...validGrant,
        encryptedAdoToken: validGrant.encryptedAdoToken
          ? {
              ...validGrant.encryptedAdoToken,
              ciphertext: Buffer.from('tampered-bytes').toString('base64'),
            }
          : null,
      };
      await expect(
        invokeInteractiveToolProxy({
          claims: makeClaims(descriptor.serverName),
          specification: makeCustomToolSpec(descriptor, { toolGrant: tamperedGrant }),
          body,
        }),
      ).rejects.toMatchObject({
        name: 'InteractiveToolProxyError',
        status: 403,
      });

      // Missing SESSION_SECRET when encrypted token present -> 503
      delete process.env.SESSION_SECRET;
      await expect(
        invokeInteractiveToolProxy({
          claims: makeClaims(descriptor.serverName),
          specification: makeCustomToolSpec(descriptor, { toolGrant: validGrant }),
          body,
        }),
      ).rejects.toMatchObject({
        name: 'InteractiveToolProxyError',
        status: 503,
      });
    });

    it('rejects unknown proxyTarget or unregistered toolName', async () => {
      const unknownDescriptor: Extract<
        FrozenInteractiveMcpDescriptor,
        { kind: 'custom-tool' }
      > = {
        kind: 'custom-tool',
        serverName: 'unknown-area/do-something',
        toolName: 'do_something',
        proxyTarget: 'unknown-area/do-something',
        writes: false,
        enableRepoBrowse: false,
      };

      await expect(
        invokeInteractiveToolProxy({
          claims: makeClaims(unknownDescriptor.serverName),
          specification: makeCustomToolSpec(unknownDescriptor),
          body: { toolName: 'do_something', args: {} },
        }),
      ).rejects.toBeInstanceOf(InteractiveToolProxyError);

      await expect(
        dispatchHarnessCustomTool({
          attempt: { runId: 'r1', attemptId: 'a1', dispatchMessageId: 'f1' },
          userId: 'user-1',
          projectId: 'project-1',
          threadId: 't-1',
          descriptor: {
            kind: 'custom-tool',
            serverName: 'prd-assistant/update-prd',
            toolName: 'wrong_tool_name',
            proxyTarget: 'prd-assistant/update-prd',
            writes: true,
            enableRepoBrowse: false,
          },
          toolGrant: makeGrant(),
          toolName: 'wrong_tool_name',
          args: {},
        }),
      ).rejects.toBeInstanceOf(CustomToolRegistryError);
    });
  });

  describe('VT-31 / TBI-012 DoD-3 / BR-001 — Auto-review never approves any write tool', () => {
    it('enforces ask mode and autoReview: false for every write tool across all 12 AREA_PROFILES', () => {
      expect(AREA_PROFILES.size).toBe(12);
      let totalWriteTools = 0;

      for (const areaId of HARNESS_AREA_IDS) {
        const profile = getAreaProfile(areaId);
        const frozen: FrozenHarnessSpec = toFrozenHarnessSpec({
          profile,
          project: 'project-1',
          settingsId: 'settings-1',
          skill: null,
          model: 'auto',
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
        });

        const permissionMode = resolveHarnessWritePermissionMode(frozen);
        expect(permissionMode.autoReview).toBe(false);

        const writeTools = frozen.customTools.filter((tool) => tool.writes);
        totalWriteTools += writeTools.length;

        expect(permissionMode.writeTools).toHaveLength(writeTools.length);
        for (const tool of writeTools) {
          const confirmation = frozen.writeConfirmation.find(
            (rule) => rule.tool === tool.name,
          );
          expect(confirmation).toEqual({
            tool: tool.name,
            writes: true,
            mode: 'ask',
          });
          expect(permissionMode.writeTools).toContainEqual({
            tool: tool.name,
            mode: 'ask',
          });
        }

        // Verify SDK adapter options never enable autoReview
        const sdkOpts = buildSdkAgentOptions('test-api-key', {
          sessionKey: `session-${areaId}`,
          compatibilityKey: `compat-${areaId}`,
          model: { id: 'auto' },
          workspaceRef: '/tmp/workspace',
          skillContent: null,
          toolAllowlist: profile.toolAllowlist,
          disallowedTools: profile.disallowedTools,
          settingSources: profile.safety.settingSources,
          sandbox: { enabled: false },
          mcpServers: {},
          priorAgentBinding: null,
          requestId: `req-${areaId}`,
        }) as unknown as Record<string, unknown>;
        expect(sdkOpts.autoReview).not.toBe(true);
      }

      // Ensure we actually audited every write custom tool across the profiles
      expect(totalWriteTools).toBeGreaterThanOrEqual(11);
    });

    it('rejects any tampered FrozenHarnessSpec that attempts to auto-allow a write tool', () => {
      const tampered: FrozenHarnessSpec = {
        area: 'prd-assistant',
        version: 1,
        toolAllowlist: ['Read'],
        customTools: [
          {
            name: 'update_prd',
            description: 'Propose PRD change',
            inputSchema: { type: 'object' },
            writes: true,
            proxyTarget: 'prd-assistant/update-prd',
          },
        ],
        writeConfirmation: [
          {
            tool: 'update_prd',
            writes: true,
            mode: 'allow',
          },
        ],
      };

      expect(() => resolveHarnessWritePermissionMode(tampered)).toThrow(
        /mode "ask"/i,
      );
    });
  });

  describe('V2 Actor Host harnessCustomTools — SDKCustomTool wrappers & DB isolation', () => {
    it('builds SDKCustomTool wrappers that route execution through invokeProxy', async () => {
      const profile = getAreaProfile('prd-assistant');
      const frozen: FrozenHarnessSpec = {
        area: profile.area,
        version: profile.version,
        toolAllowlist: profile.toolAllowlist,
        customTools: profile.customTools,
        writeConfirmation: profile.writeConfirmation.map(({ tool, writes, mode }) => ({
          tool,
          writes,
          mode,
        })),
      };

      const invokeProxy = jest.fn().mockResolvedValue({
        status: 'proposal_recorded',
        proposalId: 'prop-1',
        requiresConfirmation: true,
        message: 'Proposal recorded — waiting for explicit user confirmation',
      });

      const sdkTools = buildHarnessSdkCustomTools(frozen, invokeProxy);
      expect(Object.keys(sdkTools)).toEqual(['update_prd', 'add_test_case']);

      const result = await sdkTools.update_prd.execute(
        {
          prdId: 'prd-1',
          threadId: 'thread-1',
          section: 'content',
          content: '# Updated',
        },
        {},
      );

      expect(invokeProxy).toHaveBeenCalledWith({
        serverName: 'prd-assistant/update-prd',
        toolName: 'update_prd',
        args: {
          prdId: 'prd-1',
          threadId: 'thread-1',
          section: 'content',
          content: '# Updated',
        },
      });
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'proposal_recorded',
              proposalId: 'prop-1',
              requiresConfirmation: true,
              message: 'Proposal recorded — waiting for explicit user confirmation',
            }),
          },
        ],
      });
    });

    it('imports zero DB or chatHarness modules in interactiveActorHost/harnessCustomTools.ts', () => {
      const source = readFileSync(
        resolve(
          __dirname,
          '../../services/interactiveActorHost/harnessCustomTools.ts',
        ),
        'utf8',
      );
      expect(source).not.toMatch(/from ['"].*\/db(\/|['"])/);
      expect(source).not.toMatch(/from ['"]pg['"]/);
      expect(source).not.toMatch(/drizzle-orm/);
      expect(source).not.toMatch(/from ['"].*chatHarness/);
    });
  });
});
