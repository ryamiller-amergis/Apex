import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { designDocs, playbookDefinitions, playbookDefinitionVersions, playbookRuns } from '../db/schema';
import type { PlaybookGraph } from '../../shared/types/playbook';
import { isFeatureEnabled } from './featureFlagService';
import { createThread } from './chatAgentService';
import { getDesignDoc } from './designDocService';
import { stopDocumentValidationWatcher } from './documentValidationService';
import { createDefinition, publishDraft } from './playbookDefinitionService';
import { startRun } from './playbookRunService';
import { getDefaultModel } from './appSettingsService';
import { getPrd } from './prdService';
import { getSkillConfig, resolveSkillConfig } from './projectSettingsService';
import { CURSOR_AGENT_DEADLINE_MS } from './playbookSteps/registry';

export const DESIGN_DOC_VALIDATION_PLAYBOOK_KEY = 'design-doc-validation';
export const DESIGN_DOC_VALIDATION_PLAYBOOK_NAME = 'Design-Doc Validation';
export const DESIGN_DOC_VALIDATION_PLAYBOOK_DESCRIPTION =
  'Manually started design-doc scoring, shared ingestion, ready review, and revision notice.';

export interface DesignDocValidationPlaybookOptions {
  skillPath: string;
  model?: string | null;
}

export class DesignDocValidationPlaybookConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesignDocValidationPlaybookConfigurationError';
  }
}

export class DesignDocValidationPlaybookForbiddenError extends Error {
  constructor() {
    super('Only the design doc owner can start this Playbook.');
    this.name = 'DesignDocValidationPlaybookForbiddenError';
  }
}

export class DesignDocValidationPlaybookNotFoundError extends Error {
  constructor(designDocId: string) {
    super(`No design doc "${designDocId}" exists.`);
    this.name = 'DesignDocValidationPlaybookNotFoundError';
  }
}

/**
 * Canonical immutable definition template. The `${...}` values are run bindings resolved by the
 * manual-start path; they are data, not executable expressions.
 */
export function buildDesignDocValidationPlaybookGraph(
  options: DesignDocValidationPlaybookOptions,
): PlaybookGraph {
  return {
    nodes: [
      {
        id: 'score',
        stepType: 'cursor-agent',
        config: {
          skillPath: options.skillPath,
          prompt:
            'Score the bound design doc with the design-doc validation skill. Write ' +
            'review-scorecard.json and review-scorecard.md to .ai-pilot/output/.',
          ...(options.model ? { model: options.model } : {}),
          mcpProfile: 'repository-read-only',
          deadlineMs: CURSOR_AGENT_DEADLINE_MS,
          threadId: '${input.validationThreadId}',
        },
      },
      {
        id: 'ingest',
        stepType: 'ingest-artifact',
        config: {
          documentType: 'design_doc',
          documentId: '${input.documentId}',
          validationThreadId: '${steps.score.threadId}',
          scorecard: '${steps.score.scorecard}',
          reportMd: '${steps.score.reportMd}',
        },
      },
      {
        id: 'route',
        stepType: 'branch',
        config: {
          condition: {
            sourceStepId: 'ingest',
            field: 'isReady',
            operator: 'eq',
            value: true,
          },
          whenTrue: 'ready',
          whenFalse: 'revision',
        },
      },
      {
        id: 'approve-ready',
        stepType: 'approval-gate',
        config: {
          subject: 'Review ready design-doc validation result',
          approverPool: 'design_doc',
          gatedStepId: 'ingest',
        },
      },
      {
        id: 'notify-revision',
        stepType: 'notify',
        config: {
          title: 'Design doc needs revision',
          body: 'Validation did not reach the ready threshold. Review the scorecard and revise.',
          link: '/backlog/design-doc/${input.documentId}',
          recipientUserId: '${input.ownerUserId}',
        },
      },
    ],
    edges: [
      { from: 'score', to: 'ingest' },
      { from: 'ingest', to: 'route' },
      { from: 'route', to: 'approve-ready', condition: 'ready' },
      { from: 'route', to: 'notify-revision', condition: 'revision' },
    ],
  };
}

/**
 * Release/operator entry point. It uses lifecycle services rather than a SQL seed because the
 * publisher FK and project-specific validation Skill must both be resolved at publish time.
 */
export async function publishDesignDocValidationPlaybook(input: {
  project: string;
  publishedByUserId: string;
}): Promise<{ definitionId: string; publishedVersionId: string }> {
  const enabled = await isFeatureEnabled('playbooks-production-adapters', {
    userId: input.publishedByUserId,
    project: input.project,
  });
  if (!enabled) {
    throw new DesignDocValidationPlaybookConfigurationError(
      'playbooks-production-adapters is disabled for this project.',
    );
  }

  const settings = await getSkillConfig(input.project);
  const skillPath = settings?.designDocValidationSkillPath?.trim();
  if (!skillPath) {
    throw new DesignDocValidationPlaybookConfigurationError(
      `Project "${input.project}" has no design-doc validation Skill configured.`,
    );
  }

  const created = await createDefinition({
    project: input.project,
    name: DESIGN_DOC_VALIDATION_PLAYBOOK_NAME,
    description: DESIGN_DOC_VALIDATION_PLAYBOOK_DESCRIPTION,
    graph: buildDesignDocValidationPlaybookGraph({
      skillPath,
      model: settings?.designDocValidationModel,
    }),
    createdByUserId: input.publishedByUserId,
  });
  const published = await publishDraft({
    project: input.project,
    definitionId: created.definition.id,
    publishedByUserId: input.publishedByUserId,
    expectedDraftUpdatedAt: created.draft.updatedAt,
  });

  return {
    definitionId: created.definition.id,
    publishedVersionId: published.currentPublishedVersionId,
  };
}

export async function startDesignDocValidationPlaybook(input: {
  designDocId: string;
  project: string;
  callerUserId: string;
}): Promise<{ runId: string; definitionVersionId: string; outcome: 'started' | 'already-running' }> {
  const enabled = await isFeatureEnabled('playbooks-production-adapters', {
    userId: input.callerUserId,
    project: input.project,
  });
  if (!enabled) {
    throw new DesignDocValidationPlaybookNotFoundError(input.designDocId);
  }

  const document = await getDesignDoc(input.designDocId);
  if (!document || document.project !== input.project) {
    throw new DesignDocValidationPlaybookNotFoundError(input.designDocId);
  }
  if (document.ownerId !== input.callerUserId) {
    throw new DesignDocValidationPlaybookForbiddenError();
  }

  const definition = await db.query.playbookDefinitions.findFirst({
    where: and(
      eq(playbookDefinitions.project, input.project),
      eq(playbookDefinitions.name, DESIGN_DOC_VALIDATION_PLAYBOOK_NAME),
    ),
  });
  if (!definition) {
    throw new DesignDocValidationPlaybookConfigurationError(
      `Project "${input.project}" has no published Design-Doc Validation Playbook.`,
    );
  }

  const validationThreadId = await ensureValidationThread(document.id, document.ownerId);
  const existing = await findActiveCanonicalRun(input.project, definition.id, validationThreadId);
  if (existing) {
    return {
      runId: existing.id,
      definitionVersionId: existing.definitionVersionId,
      outcome: 'already-running',
    };
  }

  const started = await startRun({
    project: input.project,
    definitionId: definition.id,
    initiatorUserId: document.ownerId,
    runInput: {
      documentType: 'design_doc',
      documentId: document.id,
      validationThreadId,
      ownerUserId: document.ownerId,
    },
  });

  return {
    runId: started.runId,
    definitionVersionId: started.definitionVersionId,
    outcome: 'started',
  };
}

async function findActiveCanonicalRun(
  project: string,
  definitionId: string,
  validationThreadId: string,
): Promise<{ id: string; definitionVersionId: string } | undefined> {
  const [row] = await db
    .select({
      id: playbookRuns.id,
      definitionVersionId: playbookRuns.definitionVersionId,
    })
    .from(playbookRuns)
    .innerJoin(
      playbookDefinitionVersions,
      eq(playbookRuns.definitionVersionId, playbookDefinitionVersions.id),
    )
    .where(and(
      eq(playbookRuns.project, project),
      eq(playbookDefinitionVersions.definitionId, definitionId),
      inArray(playbookRuns.status, ['running', 'suspended']),
      sql`${playbookRuns.runInput}->>'validationThreadId' = ${validationThreadId}`,
    ))
    .limit(1);

  return row;
}

async function ensureValidationThread(designDocId: string, ownerUserId: string): Promise<string> {
  const document = await getDesignDoc(designDocId);
  if (!document) throw new DesignDocValidationPlaybookNotFoundError(designDocId);
  if (document.validationThreadId) {
    stopDocumentValidationWatcher(designDocId);
    return document.validationThreadId;
  }

  const skillConfig = await resolveSkillConfig({
    project: document.project,
    settingsId: document.skillSettingsId ?? undefined,
  });
  if (!skillConfig?.designDocValidationSkillPath) {
    throw new DesignDocValidationPlaybookConfigurationError(
      `Project "${document.project}" has no design-doc validation Skill configured.`,
    );
  }

  const globalModel = await getDefaultModel();
  const model = skillConfig.designDocValidationModel ?? globalModel;
  const prd = document.prdId ? await getPrd(document.prdId) : null;
  const context = [
    '# Design Doc Validation Context',
    `doc_id: ${designDocId}`,
    '',
    ...(prd ? ['## Source PRD', prd.content || '(empty)', ''] : []),
    '## Design',
    document.designContent || '(empty)',
    '',
    '## Tech Spec',
    document.techSpecContent || '(empty)',
    '',
    '## Assumptions',
    document.assumptionsContent || '(empty)',
  ].join('\n');

  const thread = await createThread(ownerUserId, {
    project: document.project,
    repo: skillConfig.skillRepo,
    branch: skillConfig.skillBranch ?? 'main',
    skillProvider: skillConfig.skillProvider ?? undefined,
    skillPath: skillConfig.designDocValidationSkillPath,
    freeformContext: context,
    model,
    skillSettingsId: document.skillSettingsId ?? skillConfig.id ?? null,
  }, { skipAutoKickoff: true });

  stopDocumentValidationWatcher(designDocId);

  const statusAllowsValidation = ['generating', 'pending_review', 'draft', 'revision_requested', 'validating'];
  const newStatus = statusAllowsValidation.includes(document.status) ? 'validating' : undefined;

  await db.update(designDocs)
    .set({
      validationThreadId: thread.id,
      ...(newStatus ? { status: newStatus } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(designDocs.id, designDocId));

  return thread.id;
}
