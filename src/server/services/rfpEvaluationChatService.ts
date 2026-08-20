import { asc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { rfpEvaluationMessages } from '../db/schema';
import {
  RFP_EVALUATION_CHAT_MAX_MESSAGE_CHARS,
  type RfpEvaluation,
  type RfpEvaluationChatMessage,
  type RfpRequest,
} from '../../shared/types/rfpIntake';
import { completePlainTextWithBedrock } from './bedrockService';
import {
  APEX_PROJECT,
  actorCanViewRfp,
  getRequestById,
  RfpIntakeError,
} from './rfpIntakeService';

const HISTORY_LIMIT = 20;

function mapMessage(row: typeof rfpEvaluationMessages.$inferSelect): RfpEvaluationChatMessage {
  return {
    id: row.id,
    rfpRequestId: row.rfpRequestId,
    evaluationId: row.evaluationId,
    authorId: row.authorId,
    role: row.role,
    body: row.body,
    createdAt: row.createdAt,
  };
}

async function requireChatAccess(rfpId: string, actorId: string): Promise<RfpRequest> {
  const request = await getRequestById(rfpId);
  if (!request || !(await actorCanViewRfp(actorId, request))) {
    throw new RfpIntakeError('RFP not found', 404, 'NOT_FOUND');
  }
  return request;
}

export async function listEvaluationChat(
  rfpId: string,
  actorId: string,
): Promise<RfpEvaluationChatMessage[]> {
  await requireChatAccess(rfpId, actorId);
  const rows = await db.query.rfpEvaluationMessages.findMany({
    where: eq(rfpEvaluationMessages.rfpRequestId, rfpId),
    orderBy: [asc(rfpEvaluationMessages.createdAt)],
  });
  return rows.map(mapMessage);
}

function buildPrompt(
  request: RfpRequest,
  evaluation: RfpEvaluation,
  history: RfpEvaluationChatMessage[],
  question: string,
): string {
  const historyBlock = history
    .map((item) => `${item.role === 'user' ? 'User' : 'Evaluator'}: ${item.body}`)
    .join('\n\n');

  return `You are the Apex product-intake evaluator answering follow-up questions about a completed evaluation. Explain your reasoning. Do not change the verdict, rewrite the evaluation JSON, or invent a new recommendation. If the user asks whether a full SDLC build is valid, answer against this rule: Apex builds standalone apps via the interview flow (grill-with-docs → to-prd → backlog) and hosts them outside the Apex UI. Do not treat the request as an Apex module unless the intake explicitly asked to extend Apex itself.

Answer in short Markdown (headings and bullets). Stay grounded in the intake and evaluation below. If something was not evaluated, say so.

## Intake
${JSON.stringify({
    title: request.title,
    stakeholder: request.stakeholder,
    request: request.request,
    problem: request.problem,
    audience: request.audience,
    dataSensitivity: request.dataSensitivity,
    existingSolution: request.existingSolution,
    advantage: request.advantage,
    constraints: request.constraints,
    requestType: request.requestType,
    existingSystemStack: request.existingSystemStack,
  }, null, 2)}

## Evaluation
${JSON.stringify(evaluation.rawOutput ?? {
    verdict: evaluation.verdict,
    confidence: evaluation.confidence,
    techVelocity: evaluation.techVelocity,
    nativeBenefit: evaluation.nativeBenefit,
    deliveryApproach: evaluation.deliveryApproach,
    recommendedLane: evaluation.recommendedLane,
    recommendedTooling: evaluation.recommendedTooling,
    hostingRecommendation: evaluation.hostingRecommendation,
    operationalOwner: evaluation.operationalOwner,
    entersInterviewFlow: evaluation.entersInterviewFlow,
    buildBuyRentSummary: evaluation.buildBuyRentSummary,
    rationale: evaluation.rationale,
    existingOverlap: evaluation.existingOverlap,
  }, null, 2)}

${historyBlock ? `## Prior questions\n${historyBlock}\n\n` : ''}## Question
${question}`;
}

export async function askEvaluationChat(
  rfpId: string,
  actorId: string,
  message: string,
): Promise<RfpEvaluationChatMessage[]> {
  const request = await requireChatAccess(rfpId, actorId);
  const trimmed = message.trim();
  if (!trimmed) {
    throw new RfpIntakeError('message is required', 400, 'VALIDATION');
  }
  if (trimmed.length > RFP_EVALUATION_CHAT_MAX_MESSAGE_CHARS) {
    throw new RfpIntakeError(
      `message must be ${RFP_EVALUATION_CHAT_MAX_MESSAGE_CHARS} characters or fewer`,
      400,
      'VALIDATION',
    );
  }
  if (!request.currentEvaluation) {
    throw new RfpIntakeError('Ask about reasoning after an evaluation exists', 409, 'NOT_READY');
  }

  const existing = await listEvaluationChat(rfpId, actorId);
  const history = existing.slice(-HISTORY_LIMIT);
  const prompt = buildPrompt(request, request.currentEvaluation, history, trimmed);
  const reply = (await completePlainTextWithBedrock(prompt, {
    feature: 'rfp-intake',
    project: request.sourceProject || APEX_PROJECT,
    entityType: 'rfp_request',
    entityId: rfpId,
    userId: actorId,
  })).trim();
  if (!reply) {
    throw new RfpIntakeError('The evaluator did not return an answer. Try again.', 502, 'AI_EMPTY');
  }

  const inserted = await db.transaction(async (tx) => {
    const [userRow] = await tx.insert(rfpEvaluationMessages).values({
      rfpRequestId: rfpId,
      evaluationId: request.currentEvaluationId,
      authorId: actorId,
      role: 'user',
      body: trimmed,
    }).returning();
    const [assistantRow] = await tx.insert(rfpEvaluationMessages).values({
      rfpRequestId: rfpId,
      evaluationId: request.currentEvaluationId,
      authorId: null,
      role: 'assistant',
      body: reply,
    }).returning();
    return [userRow, assistantRow];
  });

  return inserted.filter((row): row is NonNullable<typeof row> => Boolean(row)).map(mapMessage);
}
