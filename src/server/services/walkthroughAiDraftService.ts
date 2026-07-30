/**
 * FEAT-004 — AI Walkthrough draft generation / redo / unit validation.
 * Cursor-backed; provider details stay server-side. Proposals are never persisted here.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  listWalkthroughAnchors,
  validateRegisteredAnchor,
  type WalkthroughAnchorRegistryEntry,
} from '../../shared/walkthroughAnchors';
import { isWalkthroughRoute, listWalkthroughRoutes } from '../../shared/walkthroughRoutes';
import {
  buildProposalUnits,
  resolveWalkthroughAiPolicyPreset,
  WalkthroughAiError,
  type GenerateWalkthroughAiDraftRequest,
  type RedoWalkthroughAiUnitRequest,
  type ValidateWalkthroughAiUnitRequest,
  type ValidateWalkthroughAiUnitSuccess,
  type WalkthroughAiPolicyPreset,
  type WalkthroughAiPolicyPresetId,
  type WalkthroughAiProposal,
  type WalkthroughAiProposalUnit,
  type WalkthroughAiStepProposal,
  type WalkthroughAiWalkthroughFields,
} from '../../shared/types/walkthroughAiDraft';
import type { WalkthroughAnchor } from '../../shared/types/walkthrough';
import { listAuthoringAnchorEntries } from './walkthroughAnchorRegistryService';

export interface WalkthroughAiProviderCallOptions {
  modelId?: string;
  timeoutMs: number;
}

export interface WalkthroughAiProvider {
  generateStructuredJson(
    prompt: string,
    options: WalkthroughAiProviderCallOptions,
  ): Promise<string>;
}

export interface WalkthroughAiTelemetryEvent {
  event: 'walkthrough_ai_generation' | 'walkthrough_ai_redo' | 'walkthrough_ai_unit_validation';
  durationMs: number;
  outcome: 'success' | 'failure';
  code?: string;
  modelId?: string;
  stepCount?: number;
  registryRejectionCount?: number;
  unitKind?: string;
}

const telemetryBuffer: WalkthroughAiTelemetryEvent[] = [];

export function clearWalkthroughAiTelemetry(): void {
  telemetryBuffer.length = 0;
}

export function getWalkthroughAiTelemetry(): readonly WalkthroughAiTelemetryEvent[] {
  return telemetryBuffer;
}

function emitTelemetry(event: WalkthroughAiTelemetryEvent): void {
  telemetryBuffer.push(event);
}

const IMAGE_EXT = /\.(svg|png|jpe?g|webp|gif)$/i;

let providerOverride: WalkthroughAiProvider | null = null;

/** Test seam — inject a fake provider. */
export function setWalkthroughAiProviderForTests(provider: WalkthroughAiProvider | null): void {
  providerOverride = provider;
}

export function listPublicWalkthroughAssetPaths(publicRoot = path.join(process.cwd(), 'public')): string[] {
  if (!fs.existsSync(publicRoot)) return [];
  const results: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!IMAGE_EXT.test(entry.name)) continue;
      const rel = path.relative(publicRoot, full).split(path.sep).join('/');
      results.push(`/${rel}`);
    }
  };
  walk(publicRoot);
  return results.sort();
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new WalkthroughAiError('AI_OUTPUT_INVALID', 'Model output was not valid JSON');
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new WalkthroughAiError('AI_OUTPUT_INVALID', 'Model output was not valid JSON');
  }
}

async function resolveCursorModel(projectId: string): Promise<string> {
  try {
    const { resolveSkillConfig } = await import('./projectSettingsService');
    const { getDefaultModel } = await import('./appSettingsService');
    const skillConfig = await resolveSkillConfig({ project: projectId });
    return skillConfig?.developmentModel || skillConfig?.defaultModel || (await getDefaultModel());
  } catch {
    const { getDefaultModel } = await import('./appSettingsService');
    return getDefaultModel();
  }
}

async function defaultProvider(): Promise<WalkthroughAiProvider> {
  return {
    async generateStructuredJson(prompt, options) {
      const { Agent } = await import('@cursor/sdk');
      const apiKey = process.env.CURSOR_API_KEY;
      if (!apiKey) {
        throw new Error('CURSOR_API_KEY is required for Walkthrough AI generation');
      }

      const agent = await Agent.create({
        apiKey,
        ...(options.modelId ? { model: { id: options.modelId } } : {}),
      });

      const run = await agent.send(prompt);
      let output = '';
      if (run.supports('stream')) {
        for await (const event of run.stream()) {
          if (event.type === 'assistant') {
            for (const block of event.message.content) {
              if (block.type === 'text') {
                output += block.text;
              }
            }
          }
        }
      }

      if (!output.trim()) {
        throw new Error('Cursor SDK returned empty output');
      }
      return output;
    },
  };
}

async function getProvider(): Promise<WalkthroughAiProvider> {
  return providerOverride ?? (await defaultProvider());
}

async function callProviderWithRetries(
  provider: WalkthroughAiProvider,
  prompt: string,
  policy: WalkthroughAiPolicyPreset,
  modelId: string | undefined,
): Promise<string> {
  let lastError: unknown;
  const attempts = 1 + Math.max(0, policy.retries);
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await provider.generateStructuredJson(prompt, {
        modelId,
        timeoutMs: policy.timeoutMs,
      });
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = /timed out/i.test(message);
      if (!isTimeout || i === attempts - 1) break;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('AI provider call failed');
}

function sanitizeIntent(intent: unknown, policy: WalkthroughAiPolicyPreset): string {
  if (typeof intent !== 'string' || !intent.trim()) {
    throw new WalkthroughAiError('INTENT_INVALID', 'Intent statement is required');
  }
  const trimmed = intent.trim();
  if (trimmed.length > policy.maxIntentLength) {
    throw new WalkthroughAiError(
      'INTENT_INVALID',
      `Intent exceeds maximum length of ${policy.maxIntentLength} characters`,
    );
  }
  return trimmed;
}

function sanitizeFeedback(
  feedback: unknown,
  policy: WalkthroughAiPolicyPreset,
): string | undefined {
  if (feedback === undefined || feedback === null || feedback === '') return undefined;
  if (typeof feedback !== 'string') {
    throw new WalkthroughAiError('FEEDBACK_INVALID', 'Redo feedback must be a string');
  }
  const trimmed = feedback.trim();
  if (trimmed.length > policy.maxRedoFeedbackLength) {
    throw new WalkthroughAiError(
      'FEEDBACK_INVALID',
      `Redo feedback exceeds maximum length of ${policy.maxRedoFeedbackLength} characters`,
    );
  }
  return trimmed;
}

function buildGenerationPrompt(input: {
  intent: string;
  projectId: string;
  anchors: readonly WalkthroughAnchorRegistryEntry[];
  routes: ReturnType<typeof listWalkthroughRoutes>;
  assets: string[];
  existingDraft?: GenerateWalkthroughAiDraftRequest['existingDraft'];
}): string {
  return [
    'You are generating a staged Apex Walkthrough draft proposal as JSON only.',
    'Do not wrap commentary outside JSON. Use this schema:',
    JSON.stringify(
      {
        internalName: 'string',
        userTitle: 'string',
        whyItMatters: 'string markdown',
        steps: [
          {
            heading: 'string',
            bodyMarkdown: 'string',
            route: 'optional curated in-app Step destination or null',
            imageUrl: 'optional allow-listed path or null',
            imageAlt: 'required descriptive text when imageUrl is set',
            ctaLabel: 'optional',
            ctaRoute: 'optional curated in-app route',
            anchorKey: 'optional curated registry key or null',
            anchorPlacement: 'optional top|right|bottom|left',
          },
        ],
      },
      null,
      2,
    ),
    `Project: ${input.projectId}`,
    `Intent: ${input.intent}`,
    `Curated anchors (key → route): ${JSON.stringify(
      input.anchors.map((a) => ({
        key: a.key,
        label: a.label,
        targetRoute: a.targetRoute,
        allowedPlacements: a.allowedPlacements,
      })),
    )}`,
    `Curated routes: ${JSON.stringify(input.routes)}`,
    `Allow-listed image paths: ${JSON.stringify(input.assets)}`,
    input.existingDraft
      ? `Existing draft context (optional guidance): ${JSON.stringify(input.existingDraft)}`
      : '',
    'Rules: use only listed routes, anchors, and image paths; omit invalid ones; at most 20 steps.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildRedoPrompt(input: {
  unit: WalkthroughAiProposalUnit;
  feedback?: string;
  anchors: readonly WalkthroughAnchorRegistryEntry[];
  routes: ReturnType<typeof listWalkthroughRoutes>;
  assets: string[];
}): string {
  return [
    'Regenerate ONE Walkthrough proposal unit as JSON only.',
    input.unit.kind === 'walkthrough-fields'
      ? 'Return { "kind":"walkthrough-fields", "internalName":"...", "userTitle":"...", "whyItMatters":"..." }'
      : 'Return { "kind":"step", "heading":"...", "bodyMarkdown":"...", "route":null|"/curated-path", "imageUrl":null|"/path", "imageAlt":null|"description", "ctaLabel":null, "ctaRoute":null, "anchorKey":null, "anchorPlacement":null }',
    `Current unit: ${JSON.stringify(input.unit)}`,
    input.feedback ? `Admin feedback: ${input.feedback}` : 'No additional feedback.',
    `Curated anchors: ${JSON.stringify(input.anchors.map((a) => ({ key: a.key, targetRoute: a.targetRoute, allowedPlacements: a.allowedPlacements })))}`,
    `Curated routes: ${JSON.stringify(input.routes)}`,
    `Allow-listed images: ${JSON.stringify(input.assets)}`,
  ].join('\n\n');
}

function normalizeAnchor(
  rawKey: unknown,
  rawPlacement: unknown,
  registryRejection: { count: number },
  catalog: readonly WalkthroughAnchorRegistryEntry[],
): WalkthroughAnchor {
  if (rawKey === undefined || rawKey === null || rawKey === '') return null;
  if (typeof rawKey !== 'string') {
    registryRejection.count += 1;
    return null;
  }
  const entry = catalog.find((a) => a.key === rawKey.trim());
  if (!entry || !entry.targetRoute) {
    registryRejection.count += 1;
    return null;
  }
  const placement =
    typeof rawPlacement === 'string' && entry.allowedPlacements.includes(rawPlacement as never)
      ? rawPlacement
      : entry.allowedPlacements[0];
  const validated = validateRegisteredAnchor(
    {
      key: entry.key,
      targetRoute: entry.targetRoute,
      placement: placement as NonNullable<WalkthroughAnchor>['placement'],
    },
    catalog,
  );
  if (validated.ok === false) {
    registryRejection.count += 1;
    return null;
  }
  return validated.anchor;
}

function normalizeImage(
  raw: unknown,
  assets: Set<string>,
  registryRejection: { count: number },
): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') {
    registryRejection.count += 1;
    return null;
  }
  const value = raw.trim();
  if (!assets.has(value)) {
    registryRejection.count += 1;
    return null;
  }
  return value;
}

function normalizeRoute(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  return isWalkthroughRoute(raw) ? raw : null;
}

export function parseGeneratedWalkthroughProposal(
  rawText: string,
  policyPreset: WalkthroughAiPolicyPresetId,
  assets: string[],
  catalog: readonly WalkthroughAnchorRegistryEntry[] = listWalkthroughAnchors(),
): { proposal: WalkthroughAiProposal; registryRejectionCount: number } {
  const parsed = extractJsonObject(rawText) as Record<string, unknown>;
  const registryRejection = { count: 0 };
  const assetSet = new Set(assets);

  const fields: WalkthroughAiWalkthroughFields = {
    internalName:
      typeof parsed.internalName === 'string' && parsed.internalName.trim()
        ? parsed.internalName.trim()
        : 'ai-draft',
    userTitle:
      typeof parsed.userTitle === 'string' && parsed.userTitle.trim()
        ? parsed.userTitle.trim()
        : 'New Walkthrough',
    whyItMatters: typeof parsed.whyItMatters === 'string' ? parsed.whyItMatters : '',
  };

  const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
  if (rawSteps.length > 20) {
    throw new WalkthroughAiError('AI_OUTPUT_INVALID', 'Proposal exceeded maximum Step count');
  }

  const steps: WalkthroughAiStepProposal[] = rawSteps.map((raw, index) => {
    const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const nestedAnchor =
      s.anchor && typeof s.anchor === 'object' ? (s.anchor as Record<string, unknown>) : null;
    const heading =
      typeof s.heading === 'string' && s.heading.trim() ? s.heading.trim() : `Step ${index + 1}`;
    const bodyMarkdown = typeof s.bodyMarkdown === 'string' ? s.bodyMarkdown : '';
    const imagePath = normalizeImage(s.imageUrl, assetSet, registryRejection);
    const anchor = normalizeAnchor(
      s.anchorKey ?? nestedAnchor?.key,
      s.anchorPlacement ?? nestedAnchor?.placement,
      registryRejection,
      catalog,
    );
    const id = typeof s.id === 'string' && s.id.trim() ? s.id.trim() : randomUUID();
    const route = anchor?.targetRoute ?? normalizeRoute(s.route);
    return {
      id,
      ordinal: index,
      heading,
      bodyMarkdown,
      route,
      imageUrl: imagePath,
      imageAlt:
        imagePath && typeof s.imageAlt === 'string' && s.imageAlt.trim()
          ? s.imageAlt.trim()
          : null,
      imageCandidatePath: imagePath,
      ctaLabel: typeof s.ctaLabel === 'string' ? s.ctaLabel : null,
      ctaRoute: normalizeRoute(s.ctaRoute),
      anchor,
    };
  });

  const proposalId = randomUUID();
  const generationContextVersion = randomUUID();
  const units = buildProposalUnits(fields, steps);
  return {
    proposal: {
      proposalId,
      walkthroughFields: fields,
      steps,
      units,
      generatedAt: new Date().toISOString(),
      generationContextVersion,
      policyPreset,
    },
    registryRejectionCount: registryRejection.count,
  };
}

function parseRedoUnit(
  rawText: string,
  previous: WalkthroughAiProposalUnit,
  assets: string[],
  catalog: readonly WalkthroughAnchorRegistryEntry[] = listWalkthroughAnchors(),
): { unit: WalkthroughAiProposalUnit; registryRejectionCount: number } {
  const parsed = extractJsonObject(rawText) as Record<string, unknown>;
  const registryRejection = { count: 0 };
  const assetSet = new Set(assets);

  if (previous.kind === 'walkthrough-fields') {
    const value: WalkthroughAiWalkthroughFields = {
      internalName:
        typeof parsed.internalName === 'string' && parsed.internalName.trim()
          ? parsed.internalName.trim()
          : previous.value.internalName,
      userTitle:
        typeof parsed.userTitle === 'string' && parsed.userTitle.trim()
          ? parsed.userTitle.trim()
          : previous.value.userTitle,
      whyItMatters:
        typeof parsed.whyItMatters === 'string' ? parsed.whyItMatters : previous.value.whyItMatters,
    };
    return {
      unit: { unitId: previous.unitId, kind: 'walkthrough-fields', value },
      registryRejectionCount: registryRejection.count,
    };
  }

  const imagePath = normalizeImage(parsed.imageUrl, assetSet, registryRejection);
  const anchor = normalizeAnchor(
    parsed.anchorKey ?? (parsed.anchor as { key?: unknown } | undefined)?.key,
    parsed.anchorPlacement ?? (parsed.anchor as { placement?: unknown } | undefined)?.placement,
    registryRejection,
    catalog,
  );
  const value: WalkthroughAiStepProposal = {
    id: previous.value.id,
    ordinal: previous.value.ordinal,
    heading:
      typeof parsed.heading === 'string' && parsed.heading.trim()
        ? parsed.heading.trim()
        : previous.value.heading,
    bodyMarkdown:
      typeof parsed.bodyMarkdown === 'string' ? parsed.bodyMarkdown : previous.value.bodyMarkdown,
    route: anchor?.targetRoute ?? normalizeRoute(parsed.route),
    imageUrl: imagePath,
    imageAlt:
      imagePath && typeof parsed.imageAlt === 'string' && parsed.imageAlt.trim()
        ? parsed.imageAlt.trim()
        : null,
    imageCandidatePath: imagePath,
    ctaLabel: typeof parsed.ctaLabel === 'string' ? parsed.ctaLabel : null,
    ctaRoute: normalizeRoute(parsed.ctaRoute),
    anchor,
  };
  return {
    unit: {
      unitId: previous.unitId,
      kind: 'step',
      value,
      imageCandidatePath: imagePath,
    },
    registryRejectionCount: registryRejection.count,
  };
}

export async function generateProposal(
  request: GenerateWalkthroughAiDraftRequest,
): Promise<WalkthroughAiProposal> {
  const started = Date.now();
  const policy = resolveWalkthroughAiPolicyPreset(request.policyPreset);
  let modelId: string | undefined;
  try {
    if (typeof request.projectId !== 'string' || !request.projectId.trim()) {
      throw new WalkthroughAiError('INTENT_INVALID', 'projectId is required');
    }
    // Ignore any client-supplied allow-lists if present on the raw body.
    const intent = sanitizeIntent(request.intent, policy);
    const anchors = await listAuthoringAnchorEntries();
    const routes = listWalkthroughRoutes();
    const assets = listPublicWalkthroughAssetPaths();
    modelId = request.model?.trim() || (await resolveCursorModel(request.projectId.trim()));
    const prompt = buildGenerationPrompt({
      intent,
      projectId: request.projectId.trim(),
      anchors,
      routes,
      assets,
      existingDraft: request.existingDraft,
    });
    const provider = await getProvider();
    const raw = await callProviderWithRetries(provider, prompt, policy, modelId);
    const { proposal, registryRejectionCount } = parseGeneratedWalkthroughProposal(
      raw,
      policy.id,
      assets,
      anchors,
    );
    emitTelemetry({
      event: 'walkthrough_ai_generation',
      durationMs: Date.now() - started,
      outcome: 'success',
      modelId,
      stepCount: proposal.steps.length,
      registryRejectionCount,
    });
    return proposal;
  } catch (err) {
    const code =
      err instanceof WalkthroughAiError ? err.code : 'AI_GENERATION_FAILED';
    emitTelemetry({
      event: 'walkthrough_ai_generation',
      durationMs: Date.now() - started,
      outcome: 'failure',
      code,
      modelId,
    });
    if (err instanceof WalkthroughAiError) throw err;
    throw new WalkthroughAiError(
      'AI_GENERATION_FAILED',
      'Walkthrough draft generation failed. Try again or author manually.',
    );
  }
}

export async function redoProposalUnit(
  request: RedoWalkthroughAiUnitRequest,
): Promise<WalkthroughAiProposalUnit> {
  const started = Date.now();
  const policy = resolveWalkthroughAiPolicyPreset(request.policyPreset);
  let modelId: string | undefined;
  try {
    if (typeof request.projectId !== 'string' || !request.projectId.trim()) {
      throw new WalkthroughAiError('AI_REDO_FAILED', 'projectId is required');
    }
    if (typeof request.proposalId !== 'string' || !request.proposalId.trim()) {
      throw new WalkthroughAiError('AI_REDO_FAILED', 'proposalId is required');
    }
    if (typeof request.generationContextVersion !== 'string' || !request.generationContextVersion.trim()) {
      throw new WalkthroughAiError('AI_REDO_FAILED', 'generationContextVersion is required');
    }
    if (!request.unit || (request.unit.kind !== 'walkthrough-fields' && request.unit.kind !== 'step')) {
      throw new WalkthroughAiError('AI_REDO_FAILED', 'A valid proposal unit is required');
    }
    const feedback = sanitizeFeedback(request.feedback, policy);
    const anchors = await listAuthoringAnchorEntries();
    const routes = listWalkthroughRoutes();
    const assets = listPublicWalkthroughAssetPaths();
    modelId = await resolveCursorModel(request.projectId.trim());
    const prompt = buildRedoPrompt({ unit: request.unit, feedback, anchors, routes, assets });
    const provider = await getProvider();
    const raw = await callProviderWithRetries(provider, prompt, policy, modelId);
    const { unit, registryRejectionCount } = parseRedoUnit(raw, request.unit, assets, anchors);
    emitTelemetry({
      event: 'walkthrough_ai_redo',
      durationMs: Date.now() - started,
      outcome: 'success',
      modelId,
      registryRejectionCount,
      unitKind: unit.kind,
    });
    return unit;
  } catch (err) {
    const code = err instanceof WalkthroughAiError ? err.code : 'AI_REDO_FAILED';
    emitTelemetry({
      event: 'walkthrough_ai_redo',
      durationMs: Date.now() - started,
      outcome: 'failure',
      code,
      modelId,
      unitKind: request.unit?.kind,
    });
    if (err instanceof WalkthroughAiError) throw err;
    throw new WalkthroughAiError(
      'AI_REDO_FAILED',
      'Step redo failed. The previous proposal remains available.',
    );
  }
}

export async function validateProposalUnit(
  request: ValidateWalkthroughAiUnitRequest,
): Promise<ValidateWalkthroughAiUnitSuccess> {
  const started = Date.now();
  try {
    if (!request.unit || (request.unit.kind !== 'walkthrough-fields' && request.unit.kind !== 'step')) {
      throw new WalkthroughAiError('PROPOSAL_UNIT_INVALID', 'Proposal unit is required');
    }
    const assets = new Set(listPublicWalkthroughAssetPaths());
    const catalog = await listAuthoringAnchorEntries();

    if (request.unit.kind === 'walkthrough-fields') {
      const { internalName, userTitle, whyItMatters } = request.unit.value;
      if (!internalName?.trim() || !userTitle?.trim()) {
        throw new WalkthroughAiError('PROPOSAL_UNIT_INVALID', 'Walkthrough fields are incomplete');
      }
      const normalizedUnit: WalkthroughAiProposalUnit = {
        unitId: request.unit.unitId,
        kind: 'walkthrough-fields',
        value: {
          internalName: internalName.trim(),
          userTitle: userTitle.trim(),
          whyItMatters: whyItMatters ?? '',
        },
      };
      emitTelemetry({
        event: 'walkthrough_ai_unit_validation',
        durationMs: Date.now() - started,
        outcome: 'success',
        unitKind: 'walkthrough-fields',
      });
      return { valid: true, normalizedUnit };
    }

    const step = request.unit.value;
    if (!step.heading?.trim() || typeof step.bodyMarkdown !== 'string') {
      throw new WalkthroughAiError('PROPOSAL_UNIT_INVALID', 'Step heading and body are required');
    }

    let anchor: WalkthroughAnchor = null;
    if (step.anchor) {
      const validated = validateRegisteredAnchor(step.anchor, catalog);
      if (validated.ok === false) {
        throw new WalkthroughAiError(
          'REGISTRY_VALUE_STALE',
          validated.errors[0]?.message ?? 'Anchor is no longer valid in the registry',
        );
      }
      anchor = validated.anchor;
    }

    const candidate =
      request.unit.imageCandidatePath ?? step.imageCandidatePath ?? step.imageUrl ?? null;
    let imageUrl: string | null = null;
    if (request.imageConfirmed) {
      if (!candidate || !assets.has(candidate)) {
        throw new WalkthroughAiError(
          'REGISTRY_VALUE_STALE',
          'Confirmed image path is not in the allow-listed asset catalog',
        );
      }
      imageUrl = candidate;
    }

    const route = step.route ?? anchor?.targetRoute ?? null;
    if (route && !isWalkthroughRoute(route)) {
      throw new WalkthroughAiError(
        'PROPOSAL_UNIT_INVALID',
        'Step route must be in the curated Walkthrough route catalog',
      );
    }
    if (anchor && route !== anchor.targetRoute) {
      throw new WalkthroughAiError(
        'REGISTRY_VALUE_STALE',
        'Step route must match the registered anchor route',
      );
    }
    if (step.ctaRoute && !isWalkthroughRoute(step.ctaRoute)) {
      throw new WalkthroughAiError(
        'PROPOSAL_UNIT_INVALID',
        'Step ctaRoute must be in the curated Walkthrough route catalog',
      );
    }

    const normalizedUnit: WalkthroughAiProposalUnit = {
      unitId: request.unit.unitId,
      kind: 'step',
      value: {
        ...step,
        heading: step.heading.trim(),
        bodyMarkdown: step.bodyMarkdown,
        route,
        anchor,
        imageUrl,
        imageAlt: imageUrl ? step.imageAlt ?? null : null,
        imageCandidatePath: candidate && assets.has(candidate) ? candidate : null,
      },
      imageCandidatePath: candidate && assets.has(candidate) ? candidate : null,
    };

    emitTelemetry({
      event: 'walkthrough_ai_unit_validation',
      durationMs: Date.now() - started,
      outcome: 'success',
      unitKind: 'step',
    });
    return { valid: true, normalizedUnit };
  } catch (err) {
    const code = err instanceof WalkthroughAiError ? err.code : 'PROPOSAL_UNIT_INVALID';
    emitTelemetry({
      event: 'walkthrough_ai_unit_validation',
      durationMs: Date.now() - started,
      outcome: 'failure',
      code,
      unitKind: request.unit?.kind,
    });
    throw err;
  }
}

/** Expose presets for Platform Admin UI (no secrets). */
export function listWalkthroughAiPolicyPresets(): WalkthroughAiPolicyPreset[] {
  return [
    resolveWalkthroughAiPolicyPreset('A'),
    resolveWalkthroughAiPolicyPreset('B'),
    resolveWalkthroughAiPolicyPreset('C'),
  ];
}
