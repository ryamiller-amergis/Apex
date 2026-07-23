import express from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { performance } from 'perf_hooks';
import { ensureAuthenticated } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import {
  createSession,
  getSession,
  getActiveSessions,
  validateAndIngest,
  getPdfFileStream,
  getPdfTempDir,
  updateManifest,
  updateOverlays,
  removeFile,
  queuePdfExport,
  closeSession,
  replaceFormValues,
  addSignatureAsset,
  replaceSignatureOverlays,
} from '../services/pdfAssemblyService';
import { streamSignatureAsset } from '../services/pdfSignatureService';
import {
  getPdfJob,
  PdfQueueSaturatedError,
} from '../services/pdfConversionJobService';
import { getPdfArtifactStore } from '../services/pdfArtifactStore';
import {
  PDF_ERROR_CODES,
  PDF_MVP_PERFORMANCE_TARGETS,
  type OverlayFieldError,
  type ReplaceOverlaysRequest,
  type ReplaceFormValuesRequest,
  type ReplaceSignatureOverlaysRequest,
  type PdfTextFormValue,
} from '../../shared/types/pdf';

const router = express.Router();

// ── Multer configuration ───────────────────────────────────────────────────────

const pdfTempDir = getPdfTempDir();
fs.mkdirSync(pdfTempDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, pdfTempDir);
  },
  filename: (_req, file, cb) => {
    // Temporary name — replaced by UUID during ingestion
    const ext = path.extname(file.originalname) || '.tmp';
    cb(
      null,
      `upload-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
    );
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100 MB
    files: 20,
  },
});

// ── Auth + permission guard for all /api/pdf routes ───────────────────────────

router.use(ensureAuthenticated);
router.use(requirePermission('pdf-assembly:use'));

// ── Helpers ───────────────────────────────────────────────────────────────────

function getUserId(req: express.Request): string {
  return (req.user as any)?.profile?.oid as string;
}

async function cleanupMulterFiles(req: express.Request): Promise<void> {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  await Promise.all(
    files.map((file) => fs.promises.rm(file.path, { force: true }))
  );
}

async function loadAndValidateSession(
  sessionId: string,
  userId: string,
  res: express.Response
): Promise<ReturnType<typeof getSession> extends Promise<infer T> ? T : never> {
  const session = await getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return undefined as any;
  }
  if (session.userId !== userId) {
    res.status(403).json({ error: 'Forbidden' });
    return undefined as any;
  }
  if (session.status === 'expired') {
    res.status(410).json({ error: 'Session has expired' });
    return undefined as any;
  }
  return session as any;
}

// ── GET /api/pdf/sessions ─────────────────────────────────────────────────────

router.get('/sessions', async (req, res): Promise<void> => {
  try {
    const userId = getUserId(req);
    const sessions = await getActiveSessions(userId);
    res.json(sessions);
  } catch (err) {
    console.error('[pdf] GET /sessions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/pdf/sessions ─────────────────────────────────────────────────────

router.post('/sessions', async (req, res): Promise<void> => {
  try {
    const userId = getUserId(req);
    const { projectId, replaceSessionId } = req.body as {
      projectId?: string;
      replaceSessionId?: string;
    };

    const result = await createSession(userId, projectId, { replaceSessionId });

    res.status(201).json({
      sessionId: result.sessionId,
      status: 'active',
      createdAt: result.createdAt,
      expiresAt: result.expiresAt,
    });
  } catch (err: unknown) {
    const code = (err as any)?.code;
    if (code === PDF_ERROR_CODES.SESSION_LIMIT_REACHED) {
      res.status(429).json({
        error: { code, message: 'Maximum 3 concurrent sessions reached.' },
      });
      return;
    }
    console.error('[pdf] POST /sessions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/pdf/sessions/:sessionId ───────────────────────────────────────

router.delete('/sessions/:sessionId', async (req, res): Promise<void> => {
  try {
    const userId = getUserId(req);
    const { sessionId } = req.params;

    const closed = await closeSession(sessionId, userId);
    if (!closed) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    res.status(204).end();
  } catch (err) {
    console.error('[pdf] DELETE session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/pdf/sessions/:sessionId ────────────────────────────────────────

router.get('/sessions/:sessionId', async (req, res): Promise<void> => {
  try {
    const userId = getUserId(req);
    const { sessionId } = req.params;

    const session = await loadAndValidateSession(sessionId, userId, res);
    if (!session) return;

    res.json(session);
  } catch (err) {
    console.error('[pdf] GET session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/pdf/sessions/:sessionId/upload ──────────────────────────────────

router.post(
  '/sessions/:sessionId/upload',
  (req, res, next) => {
    res.locals.pdfUploadStartedAt = performance.now();
    // Run Multer first so files are on disk before we do ownership check
    upload.array('files')(req, res, (err) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({
          error: {
            code: 'FILE_TOO_LARGE',
            message: 'File exceeds 100 MB limit.',
          },
        });
        return;
      }
      if (err) {
        next(err);
        return;
      }
      next();
    });
  },
  async (req, res): Promise<void> => {
    try {
      const userId = getUserId(req);
      const { sessionId } = req.params;

      const session = await loadAndValidateSession(sessionId, userId, res);
      if (!session) {
        await cleanupMulterFiles(req);
        return;
      }

      const files = (req.files as Express.Multer.File[]) ?? [];

      if (files.length === 0) {
        res.status(400).json({ error: 'No files uploaded' });
        return;
      }

      const results = await Promise.all(
        files.map((f) =>
          validateAndIngest(sessionId, f.path, f.originalname, f.mimetype)
        )
      );

      const durationMs = Math.round(
        performance.now() - (res.locals.pdfUploadStartedAt as number)
      );
      res.setHeader(
        'Server-Timing',
        `pdf-upload-parse;dur=${durationMs};desc="PDF upload and parse"`
      );

      const uploadedPageCount = results[0]?.pageCount ?? 0;
      if (
        files.length === 1 &&
        uploadedPageCount >= PDF_MVP_PERFORMANCE_TARGETS.uploadPageCount &&
        durationMs > PDF_MVP_PERFORMANCE_TARGETS.uploadAndParseMs
      ) {
        console.warn('[pdf-performance] Upload and parse exceeded MVP target', {
          durationMs,
          targetMs: PDF_MVP_PERFORMANCE_TARGETS.uploadAndParseMs,
          pageCount: uploadedPageCount,
          sizeBytes: results[0]?.sizeBytes,
        });
      }

      res.status(200).json({ files: results });
    } catch (err) {
      await cleanupMulterFiles(req);
      if (err instanceof PdfQueueSaturatedError) {
        res.setHeader('Retry-After', String(err.retryAfterSeconds));
        res.status(429).json({
          error: { code: err.code, message: err.message },
          retryAfterSeconds: err.retryAfterSeconds,
        });
        return;
      }
      console.error('[pdf] POST upload error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ── PUT /api/pdf/sessions/:sessionId/manifest ─────────────────────────────────

router.put('/sessions/:sessionId/manifest', async (req, res): Promise<void> => {
  try {
    const userId = getUserId(req);
    const { sessionId } = req.params;

    const session = await loadAndValidateSession(sessionId, userId, res);
    if (!session) return;

    const result = await updateManifest(sessionId, userId, req.body.manifest);
    res.json(result);
  } catch (err: unknown) {
    const code = (err as any)?.code;
    if (code === PDF_ERROR_CODES.MANIFEST_INVALID_FILE_ID) {
      res
        .status(400)
        .json({ error: { code, message: (err as Error).message } });
      return;
    }
    if (code === PDF_ERROR_CODES.MANIFEST_INVALID_ROTATION) {
      res
        .status(400)
        .json({ error: { code, message: (err as Error).message } });
      return;
    }
    if (code === PDF_ERROR_CODES.SESSION_NOT_FOUND) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (code === PDF_ERROR_CODES.SESSION_FORBIDDEN) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    if (code === PDF_ERROR_CODES.SESSION_EXPIRED) {
      res.status(410).json({ error: 'Session has expired' });
      return;
    }
    console.error('[pdf] PUT manifest error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PUT /api/pdf/sessions/:sessionId/overlays ─────────────────────────────────

router.put('/sessions/:sessionId/overlays', async (req, res): Promise<void> => {
  try {
    const userId = getUserId(req);
    const { sessionId } = req.params;

    const session = await loadAndValidateSession(sessionId, userId, res);
    if (!session) return;

    const { overlays } = (req.body ?? {}) as Partial<ReplaceOverlaysRequest>;
    const result = await updateOverlays(sessionId, userId, overlays);
    res.json(result);
  } catch (err: unknown) {
    const serviceError = err as Error & {
      code?: string;
      errors?: OverlayFieldError[];
    };
    const code = serviceError.code;
    if (code === PDF_ERROR_CODES.OVERLAY_VALIDATION_FAILED) {
      res.status(400).json({
        error: {
          code,
          message: serviceError.message,
          errors: serviceError.errors ?? [],
        },
      });
      return;
    }
    if (code === PDF_ERROR_CODES.SESSION_NOT_FOUND) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (code === PDF_ERROR_CODES.SESSION_FORBIDDEN) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    if (code === PDF_ERROR_CODES.SESSION_EXPIRED) {
      res.status(410).json({ error: 'Session has expired' });
      return;
    }
    console.error('[pdf] PUT overlays error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/pdf/sessions/:sessionId/files/:fileId ────────────────────────

router.delete(
  '/sessions/:sessionId/files/:fileId',
  async (req, res): Promise<void> => {
    try {
      const userId = getUserId(req);
      const { sessionId, fileId } = req.params;

      const session = await loadAndValidateSession(sessionId, userId, res);
      if (!session) return;

      await removeFile(sessionId, userId, fileId);
      res.status(204).end();
    } catch (err: unknown) {
      const code = (err as any)?.code;
      if (code === 'FILE_NOT_FOUND') {
        res.status(404).json({ error: { code, message: 'File not found' } });
        return;
      }
      console.error('[pdf] DELETE file error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ── POST /api/pdf/sessions/:sessionId/export ──────────────────────────────────

router.post('/sessions/:sessionId/export', async (req, res): Promise<void> => {
  try {
    const userId = getUserId(req);
    const { sessionId } = req.params;
    const { filename, pages } = req.body as {
      filename?: string;
      pages?: number[];
    };

    // Validate pages array if provided
    if (pages !== undefined) {
      if (!Array.isArray(pages) || pages.some((p) => typeof p !== 'number')) {
        res.status(400).json({
          error: PDF_ERROR_CODES.INVALID_PAGE_INDICES,
          message: 'pages must be an array of numbers',
        });
        return;
      }
    }

    const result = await queuePdfExport(sessionId, userId, filename, pages);
    res.status(202).json(result);
  } catch (err: unknown) {
    if (err instanceof PdfQueueSaturatedError) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds));
      res.status(429).json({
        error: { code: err.code, message: err.message },
        retryAfterSeconds: err.retryAfterSeconds,
      });
      return;
    }
    const code = (err as any)?.code;
    const message = (err as Error)?.message ?? 'Internal server error';

    if (code === PDF_ERROR_CODES.SESSION_NOT_FOUND) {
      res.status(404).json({ error: code, message });
      return;
    }
    if (code === PDF_ERROR_CODES.SESSION_FORBIDDEN) {
      res.status(403).json({
        error: code,
        message: 'You do not have access to this session',
      });
      return;
    }
    if (code === PDF_ERROR_CODES.SESSION_EXPIRED) {
      res
        .status(410)
        .json({ error: code, message: 'This session has expired' });
      return;
    }
    if (code === PDF_ERROR_CODES.INVALID_FILENAME) {
      res.status(400).json({ error: code, message });
      return;
    }
    if (code === PDF_ERROR_CODES.INVALID_PAGE_INDICES) {
      res.status(400).json({ error: code, message });
      return;
    }
    if (code === PDF_ERROR_CODES.NO_PAGES) {
      res
        .status(422)
        .json({ error: code, message: 'Session has no pages to export' });
      return;
    }
    if (code === PDF_ERROR_CODES.EXPORT_FAILED) {
      res
        .status(500)
        .json({ error: code, message: 'PDF assembly failed. Please retry.' });
      return;
    }

    console.error('[pdf] POST export error:', err);
    res.status(500).json({
      error: 'EXPORT_FAILED',
      message: 'PDF assembly failed. Please retry.',
    });
  }
});

// ── GET /api/pdf/jobs/:jobId ─────────────────────────────────────────────────

router.get('/jobs/:jobId', async (req, res): Promise<void> => {
  try {
    const job = await getPdfJob(req.params.jobId, getUserId(req));
    if (!job) {
      res.status(404).json({ error: 'PDF job not found' });
      return;
    }
    res.json(job);
  } catch (err) {
    console.error('[pdf] GET job error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/pdf/jobs/:jobId/result ──────────────────────────────────────────

router.get('/jobs/:jobId/result', async (req, res): Promise<void> => {
  try {
    const userId = getUserId(req);
    const job = await getPdfJob(req.params.jobId, userId);
    if (!job || job.jobType !== 'export') {
      res.status(404).json({ error: 'PDF export not found' });
      return;
    }
    if (job.status !== 'completed') {
      res.status(409).json({ error: 'PDF export is not complete' });
      return;
    }

    const ref = { userId, sessionId: job.sessionId, fileName: `${job.id}.pdf` };
    if (!(await getPdfArtifactStore().exists(ref))) {
      res.status(404).json({ error: 'PDF export artifact not found' });
      return;
    }
    const stream = await getPdfArtifactStore().getStream(ref);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${job.resultFilename ?? job.originalName}"`
    );
    stream.on('error', (error) => {
      console.error('[pdf] Export result stream failed:', error);
      if (!res.headersSent) res.status(500).end();
      else res.destroy(error as Error);
    });
    stream.pipe(res);
  } catch (err) {
    console.error('[pdf] GET job result error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/pdf/sessions/:sessionId/files/:fileId ────────────────────────────

router.get(
  '/sessions/:sessionId/files/:fileId',
  async (req, res): Promise<void> => {
    try {
      const userId = getUserId(req);
      const { sessionId, fileId } = req.params;

      const session = await loadAndValidateSession(sessionId, userId, res);
      if (!session) return;

      // Verify this fileId belongs to the session
      const fileMeta = (session.fileMetadata ?? []).find(
        (f: any) => f.fileId === fileId
      );
      if (!fileMeta) {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      const stream = await getPdfFileStream(sessionId, userId, fileId);
      if (!stream) {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline');
      stream.on('error', (error) => {
        console.error('[pdf] Preview stream failed:', error);
        if (!res.headersSent) res.status(500).end();
        else res.destroy(error as Error);
      });
      stream.pipe(res);
    } catch (err) {
      console.error('[pdf] GET file error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ── PUT /api/pdf/sessions/:sessionId/form-values ──────────────────────────────
//
// Replaces the session's form-field values with the supplied array.
// The route validates ownership, session status, and field-level constraints.
// Returns the authoritative saved values and updatedAt.

router.put(
  '/sessions/:sessionId/form-values',
  async (req, res): Promise<void> => {
    try {
      const userId = getUserId(req);
      const { sessionId } = req.params;
      const body = req.body as ReplaceFormValuesRequest;

      if (!Array.isArray(body?.values)) {
        res.status(400).json({
          error: 'Request body must include a "values" array.',
          code: PDF_ERROR_CODES.FORM_VALUES_INVALID,
        });
        return;
      }

      // Enforce reasonable per-request item count
      if (body.values.length > 500) {
        res.status(400).json({
          error: 'Too many form values in one request (max 500).',
          code: PDF_ERROR_CODES.FORM_VALUES_INVALID,
        });
        return;
      }

      const result = await replaceFormValues(sessionId, userId, body.values as PdfTextFormValue[]);
      res.json(result);
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === PDF_ERROR_CODES.SESSION_NOT_FOUND) {
        res.status(404).json({ error: 'Session not found', code });
        return;
      }
      if (code === PDF_ERROR_CODES.SESSION_FORBIDDEN) {
        res.status(403).json({ error: 'Forbidden', code });
        return;
      }
      if (code === PDF_ERROR_CODES.SESSION_EXPIRED) {
        res.status(410).json({ error: 'Session has expired', code });
        return;
      }
      if (code === PDF_ERROR_CODES.FORM_VALUES_INVALID) {
        res.status(422).json({
          error: (err as Error).message,
          code,
          errors: (err as { errors?: unknown }).errors,
        });
        return;
      }
      console.error('[pdf] PUT form-values error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ── Signature upload multer (in-memory, 2 MB) ─────────────────────────────────

const signatureUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
});

// ── POST /api/pdf/sessions/:sessionId/signature-assets ────────────────────────
//
// Accepts a single PNG file (field name "image") and stores it as a session-
// scoped artifact. Returns asset metadata (never raw bytes or base64 data).

router.post(
  '/sessions/:sessionId/signature-assets',
  signatureUpload.single('image'),
  async (req, res): Promise<void> => {
    try {
      const userId = getUserId(req);
      const { sessionId } = req.params;
      const file = req.file;

      if (!file) {
        res.status(400).json({
          error: 'Request must include a "image" file field.',
          code: PDF_ERROR_CODES.SIGNATURE_ASSET_INVALID,
        });
        return;
      }

      const result = await addSignatureAsset(sessionId, userId, file.buffer);
      res.status(201).json(result);
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === PDF_ERROR_CODES.SESSION_NOT_FOUND) {
        res.status(404).json({ error: 'Session not found', code });
        return;
      }
      if (code === PDF_ERROR_CODES.SESSION_FORBIDDEN) {
        res.status(403).json({ error: 'Forbidden', code });
        return;
      }
      if (code === PDF_ERROR_CODES.SESSION_EXPIRED) {
        res.status(410).json({ error: 'Session has expired', code });
        return;
      }
      if (
        code === PDF_ERROR_CODES.SIGNATURE_ASSET_INVALID ||
        code === PDF_ERROR_CODES.SIGNATURE_ASSET_TOO_LARGE ||
        code === PDF_ERROR_CODES.SIGNATURE_ASSET_LIMIT_EXCEEDED
      ) {
        res.status(422).json({ error: (err as Error).message, code });
        return;
      }
      console.error('[pdf] POST signature-assets error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ── GET /api/pdf/sessions/:sessionId/signature-assets/:assetId ────────────────
//
// Streams the stored PNG for inline preview. The caller must own the session.

router.get(
  '/sessions/:sessionId/signature-assets/:assetId',
  async (req, res): Promise<void> => {
    try {
      const userId = getUserId(req);
      const { sessionId, assetId } = req.params;

      // Ownership check: load the session
      const session = await getSession(sessionId);
      if (!session) {
        res.status(404).json({ error: 'Session not found', code: PDF_ERROR_CODES.SESSION_NOT_FOUND });
        return;
      }
      if ((session as any).userId !== userId) {
        res.status(403).json({ error: 'Forbidden', code: PDF_ERROR_CODES.SESSION_FORBIDDEN });
        return;
      }
      const sigState = (session as any).signatureState as { assets: Array<{ assetId: string }> } | undefined;
      const knownIds = new Set((sigState?.assets ?? []).map((a) => a.assetId));
      if (!knownIds.has(assetId)) {
        res.status(404).json({
          error: 'Signature asset not found',
          code: PDF_ERROR_CODES.SIGNATURE_ASSET_NOT_FOUND,
        });
        return;
      }

      const stream = await streamSignatureAsset(userId, sessionId, assetId);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'private, max-age=300');
      (stream as NodeJS.ReadableStream).pipe(res);
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === PDF_ERROR_CODES.SESSION_NOT_FOUND || code === PDF_ERROR_CODES.SIGNATURE_ASSET_NOT_FOUND) {
        res.status(404).json({ error: 'Not found', code });
        return;
      }
      if (code === PDF_ERROR_CODES.SESSION_FORBIDDEN) {
        res.status(403).json({ error: 'Forbidden', code });
        return;
      }
      console.error('[pdf] GET signature-asset error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ── PUT /api/pdf/sessions/:sessionId/signature-overlays ───────────────────────
//
// Replaces the session's signature overlay array. Every overlay must reference
// a known session asset and a non-deleted page in the manifest.

router.put(
  '/sessions/:sessionId/signature-overlays',
  async (req, res): Promise<void> => {
    try {
      const userId = getUserId(req);
      const { sessionId } = req.params;
      const body = req.body as ReplaceSignatureOverlaysRequest;

      if (!Array.isArray(body?.overlays)) {
        res.status(400).json({
          error: 'Request body must include an "overlays" array.',
          code: PDF_ERROR_CODES.SIGNATURE_OVERLAY_INVALID,
        });
        return;
      }

      const result = await replaceSignatureOverlays(sessionId, userId, body.overlays);
      res.json(result);
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === PDF_ERROR_CODES.SESSION_NOT_FOUND) {
        res.status(404).json({ error: 'Session not found', code });
        return;
      }
      if (code === PDF_ERROR_CODES.SESSION_FORBIDDEN) {
        res.status(403).json({ error: 'Forbidden', code });
        return;
      }
      if (code === PDF_ERROR_CODES.SESSION_EXPIRED) {
        res.status(410).json({ error: 'Session has expired', code });
        return;
      }
      if (
        code === PDF_ERROR_CODES.SIGNATURE_OVERLAY_INVALID ||
        code === PDF_ERROR_CODES.SIGNATURE_OVERLAY_LIMIT_EXCEEDED
      ) {
        res.status(422).json({
          error: (err as Error).message,
          code,
          errors: (err as { errors?: unknown }).errors,
        });
        return;
      }
      console.error('[pdf] PUT signature-overlays error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
