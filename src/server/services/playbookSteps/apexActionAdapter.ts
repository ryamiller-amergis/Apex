/**
 * Deterministic Playbook actions. Each operation calls an existing Apex service.
 * None of them call a model.
 */
import { AzureDevOpsService } from '../azureDevOps';
import { reviewDesignDoc } from '../designDocService';
import { reviewPrd } from '../prdService';
import { markdownToAdoHtml } from './adoDescriptionHtml';
import { apexActionParameterSchema } from './registry';
import { parseStepInput, parseStepOutput } from './descriptorValidation';
import { completeStepRun, type PlaybookStepExecutionContext, type PlaybookStepOutcome } from './stepRuns';

const STEP_TYPE = 'apex-action';

export async function executeApexActionStep(
  context: PlaybookStepExecutionContext,
): Promise<PlaybookStepOutcome> {
  const config = parseStepInput<{ operation: string; parameters: Record<string, unknown> }>(
    STEP_TYPE,
    context.config,
  );
  const parameters = apexActionParameterSchema(config.operation).parse(config.parameters);
  const result = await runApexAction(context, config.operation, parameters);
  const output = parseStepOutput(STEP_TYPE, {
    operation: config.operation,
    summary: result.summary,
    ...(result.workItemId !== undefined ? { workItemId: result.workItemId } : {}),
  });
  await completeStepRun({ stepRunId: context.stepRunId, output });
  return { kind: 'completed', output };
}

async function runApexAction(
  context: PlaybookStepExecutionContext,
  operation: string,
  parameters: unknown,
): Promise<{ summary: string; workItemId?: number }> {
  if (operation === 'create-ado-items') {
    const body = parameters as {
      epic: { id: string; title: string };
      features: Array<{ id: string; title: string }>;
      pbis: Array<{ id: string; parentId: string; title: string }>;
    };
    const created = await new AzureDevOpsService(context.project).createBacklogItemsInADO(
      body.epic,
      body.features,
      body.pbis,
    );
    return { summary: `Created Azure DevOps epic ${created.epicAdoId}.` };
  }
  if (operation === 'create-work-item') {
    const body = parameters as { workItemType: string; title: string; description: string };
    const html = markdownToAdoHtml(body.description);
    // Description is the field a PBI, TBI, or Feature shows. A Bug form shows Repro Steps instead.
    const isBug = body.workItemType.trim().toLowerCase() === 'bug';
    const created = await new AzureDevOpsService(context.project).createWorkItemForPrd({
      type: body.workItemType,
      title: body.title,
      description: html,
      reproStepsHtml: isBug ? html : undefined,
    });
    return {
      summary: `Created Azure DevOps ${body.workItemType} ${created.id}.`,
      workItemId: created.id,
    };
  }
  if (operation === 'post-ado-comment') {
    const body = parameters as { workItemId: number; text: string };
    const comment = await new AzureDevOpsService(context.project).addWorkItemComment(
      body.workItemId,
      body.text,
    );
    return { summary: `Posted Azure DevOps comment ${comment.id}.` };
  }
  const body = parameters as { documentType: 'design_doc' | 'prd'; documentId: string; status: 'approved' };
  if (body.documentType === 'design_doc') {
    await reviewDesignDoc(body.documentId, context.initiatorUserId, { action: 'approve' });
  } else {
    await reviewPrd(body.documentId, context.initiatorUserId, { action: 'approve' });
  }
  return { summary: `Set ${body.documentType} ${body.documentId} to ${body.status}.` };
}
