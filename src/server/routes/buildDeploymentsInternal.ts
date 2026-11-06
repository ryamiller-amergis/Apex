/**
 * Internal deployment callback router (FEAT-013, TBI-025 / S4).
 *
 * Mounted outside `ensureAuthenticated` at `/internal/build-deployments`.
 */
import express, { Router } from 'express';
import type {
  BuildDeploymentCallbackRequest,
  BuildDeploymentCallbackResponse,
} from '../../shared/types/build';
import { requireBuildDeploymentCallbackAuth } from '../middleware/buildDeploymentCallbackAuth';
import { defaultBuildDeploymentService } from '../services/buildDeploymentService';
import { ingestPreviewBundle } from '../services/buildPreviewBundleIngestService';
import { redactText } from '../services/buildRedactionService';
import { trackEvent } from '../services/telemetry';

export interface BuildDeploymentCallbackPort {
  settleFromCallback: (
    input: BuildDeploymentCallbackRequest,
  ) => Promise<
    | { kind: 'ok'; response: BuildDeploymentCallbackResponse }
    | { kind: 'not_found' }
    | { kind: 'commit_mismatch' }
  >;
}

let serviceOverride: BuildDeploymentCallbackPort | null = null;

export function setBuildDeploymentCallbackServiceForTests(
  override: BuildDeploymentCallbackPort | null,
): void {
  serviceOverride = override;
}

function isValidPreviewUrl(raw: string): boolean {
  if (!raw || raw.length > 2048) return false;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'https:') return true;
    const appEnv = (process.env.APP_ENV || process.env.NODE_ENV || '').toLowerCase();
    if (parsed.protocol === 'http:' && (appEnv === 'local' || appEnv === 'development' || appEnv === 'test')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function validateAndSanitizeCallbackBody(
  body: unknown,
): { ok: true; value: BuildDeploymentCallbackRequest } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }
  const raw = body as Record<string, unknown>;
  const pipelineRunId = typeof raw.pipelineRunId === 'string' ? raw.pipelineRunId.trim() : '';
  const commit = typeof raw.commit === 'string' ? raw.commit.trim() : '';
  const status = raw.status;

  if (!pipelineRunId) {
    return { ok: false, error: 'pipelineRunId is required.' };
  }
  if (!commit) {
    return { ok: false, error: 'commit is required.' };
  }
  if (status !== 'succeeded' && status !== 'failed') {
    return { ok: false, error: 'status must be succeeded or failed.' };
  }

  let previewUrl: string | undefined;
  if (raw.previewUrl !== undefined && raw.previewUrl !== null) {
    if (typeof raw.previewUrl !== 'string' || !isValidPreviewUrl(raw.previewUrl)) {
      return { ok: false, error: 'previewUrl must be a valid https URL under 2048 characters.' };
    }
    previewUrl = raw.previewUrl;
  }

  let pipelineUrl: string | undefined;
  if (raw.pipelineUrl !== undefined && raw.pipelineUrl !== null) {
    if (typeof raw.pipelineUrl !== 'string' || !isValidPreviewUrl(raw.pipelineUrl)) {
      return { ok: false, error: 'pipelineUrl must be a valid https URL under 2048 characters.' };
    }
    pipelineUrl = raw.pipelineUrl;
  }

  let failedStage: string | undefined;
  if (typeof raw.failedStage === 'string' && raw.failedStage.trim().length > 0) {
    failedStage = redactText(raw.failedStage.trim()).slice(0, 200);
  }

  let errorText: string | undefined;
  if (typeof raw.errorText === 'string' && raw.errorText.trim().length > 0) {
    errorText = redactText(raw.errorText.trim()).slice(0, 4000);
  }

  return {
    ok: true,
    value: {
      pipelineRunId,
      commit,
      status,
      ...(failedStage !== undefined ? { failedStage } : {}),
      ...(errorText !== undefined ? { errorText } : {}),
      ...(previewUrl !== undefined ? { previewUrl } : {}),
      ...(pipelineUrl !== undefined ? { pipelineUrl } : {}),
    },
  };
}

const router = Router();

router.post(
  '/callback',
  requireBuildDeploymentCallbackAuth,
  async (req, res, next) => {
    try {
      const validated = validateAndSanitizeCallbackBody(req.body);
      if (!validated.ok) {
        trackEvent('build.deployment.callback.rejected', { reason: 'invalid_body' });
        res.status(422).json({ error: validated.error, code: 'INVALID_CALLBACK_BODY' });
        return;
      }

      const svc = serviceOverride ?? defaultBuildDeploymentService;
      const result = await svc.settleFromCallback(validated.value);

      switch (result.kind) {
        case 'ok':
          res.status(200).json(result.response);
          return;
        case 'not_found':
          trackEvent('build.deployment.callback.rejected', { reason: 'unknown_run' });
          res.status(404).json({ error: 'Unknown pipelineRunId.', code: 'PIPELINE_RUN_NOT_FOUND' });
          return;
        case 'commit_mismatch':
          trackEvent('build.deployment.callback.rejected', { reason: 'commit_mismatch' });
          res.status(422).json({
            error: 'Callback commit does not match the revision validated commit.',
            code: 'COMMIT_MISMATCH',
          });
          return;
        default: {
          const exhaustive: never = result;
          throw new Error(`Unhandled callback result: ${JSON.stringify(exhaustive)}`);
        }
      }
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/preview-bundle',
  requireBuildDeploymentCallbackAuth,
  express.raw({ type: 'application/gzip', limit: '80mb' }),
  async (req, res, next) => {
    try {
      const pipelineRunId =
        typeof req.header('x-pipeline-run-id') === 'string'
          ? req.header('x-pipeline-run-id')!.trim()
          : '';
      const commit =
        typeof req.header('x-commit-sha') === 'string'
          ? req.header('x-commit-sha')!.trim()
          : '';
      if (!pipelineRunId || !commit) {
        res.status(422).json({
          error: 'x-pipeline-run-id and x-commit-sha headers are required.',
          code: 'INVALID_PREVIEW_UPLOAD',
        });
        return;
      }
      const archive = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (archive.length === 0) {
        res.status(422).json({
          error: 'Preview bundle body is required.',
          code: 'INVALID_PREVIEW_UPLOAD',
        });
        return;
      }
      const result = await ingestPreviewBundle({ pipelineRunId, commit, archive });
      switch (result.kind) {
        case 'ok':
          res.status(200).json({ previewUrl: result.previewUrl });
          return;
        case 'not_found':
          res.status(404).json({ error: 'Unknown pipelineRunId.', code: 'PIPELINE_RUN_NOT_FOUND' });
          return;
        case 'commit_mismatch':
          res.status(422).json({ error: 'Commit mismatch.', code: 'COMMIT_MISMATCH' });
          return;
        case 'error':
          res.status(500).json({ error: result.message, code: 'PREVIEW_UPLOAD_FAILED' });
          return;
        default: {
          const exhaustive: never = result;
          throw new Error(`Unhandled ingest result: ${JSON.stringify(exhaustive)}`);
        }
      }
    } catch (error) {
      next(error);
    }
  },
);

export default router;
