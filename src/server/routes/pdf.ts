import express from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { ensureAuthenticated } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import {
  createSession,
  getSession,
  getActiveSessions,
  validateAndIngest,
  resolveFilePath,
  getPdfTempDir,
  updateManifest,
  removeFile,
  assembleAndExport,
} from '../services/pdfAssemblyService';
import { PDF_ERROR_CODES } from '../../shared/types/pdf';

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
    cb(null, `upload-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
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

async function loadAndValidateSession(
  sessionId: string,
  userId: string,
  res: express.Response,
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
    const { projectId } = req.body as { projectId?: string };

    const result = await createSession(userId, projectId);

    res.status(201).json({
      sessionId: result.sessionId,
      status: 'active',
      createdAt: result.createdAt,
      expiresAt: result.expiresAt,
    });
  } catch (err: unknown) {
    const code = (err as any)?.code;
    if (code === PDF_ERROR_CODES.SESSION_LIMIT_REACHED) {
      res.status(429).json({ error: { code, message: 'Maximum 3 concurrent sessions reached.' } });
      return;
    }
    console.error('[pdf] POST /sessions error:', err);
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
    // Run Multer first so files are on disk before we do ownership check
    upload.array('files')(req, res, (err) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: { code: 'FILE_TOO_LARGE', message: 'File exceeds 100 MB limit.' } });
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
      if (!session) return;

      const files = (req.files as Express.Multer.File[]) ?? [];

      if (files.length === 0) {
        res.status(400).json({ error: 'No files uploaded' });
        return;
      }

      const results = await Promise.all(
        files.map((f) =>
          validateAndIngest(sessionId, f.path, f.originalname, f.mimetype),
        ),
      );

      res.status(200).json({ files: results });
    } catch (err) {
      console.error('[pdf] POST upload error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
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
      res.status(400).json({ error: { code, message: (err as Error).message } });
      return;
    }
    if (code === PDF_ERROR_CODES.MANIFEST_INVALID_ROTATION) {
      res.status(400).json({ error: { code, message: (err as Error).message } });
      return;
    }
    console.error('[pdf] PUT manifest error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/pdf/sessions/:sessionId/files/:fileId ────────────────────────

router.delete('/sessions/:sessionId/files/:fileId', async (req, res): Promise<void> => {
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
});

// ── POST /api/pdf/sessions/:sessionId/export ──────────────────────────────────

router.post('/sessions/:sessionId/export', async (req, res): Promise<void> => {
  try {
    const userId = getUserId(req);
    const { sessionId } = req.params;
    const { filename, pages } = req.body as { filename?: string; pages?: number[] };

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

    const result = await assembleAndExport(sessionId, userId, filename, pages);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('Content-Length', result.pdfBytes.length);
    res.end(Buffer.from(result.pdfBytes));
  } catch (err: unknown) {
    const code = (err as any)?.code;
    const message = (err as Error)?.message ?? 'Internal server error';

    if (code === PDF_ERROR_CODES.SESSION_NOT_FOUND) {
      res.status(404).json({ error: code, message });
      return;
    }
    if (code === PDF_ERROR_CODES.SESSION_FORBIDDEN) {
      res.status(403).json({ error: code, message: 'You do not have access to this session' });
      return;
    }
    if (code === PDF_ERROR_CODES.SESSION_EXPIRED) {
      res.status(410).json({ error: code, message: 'This session has expired' });
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
      res.status(422).json({ error: code, message: 'Session has no pages to export' });
      return;
    }
    if (code === PDF_ERROR_CODES.EXPORT_FAILED) {
      res.status(500).json({ error: code, message: 'PDF assembly failed. Please retry.' });
      return;
    }

    console.error('[pdf] POST export error:', err);
    res.status(500).json({ error: 'EXPORT_FAILED', message: 'PDF assembly failed. Please retry.' });
  }
});

// ── GET /api/pdf/sessions/:sessionId/files/:fileId ────────────────────────────

router.get('/sessions/:sessionId/files/:fileId', async (req, res): Promise<void> => {
  try {
    const userId = getUserId(req);
    const { sessionId, fileId } = req.params;

    const session = await loadAndValidateSession(sessionId, userId, res);
    if (!session) return;

    // Verify this fileId belongs to the session
    const fileMeta = (session.fileMetadata ?? []).find((f: any) => f.fileId === fileId);
    if (!fileMeta) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const filePath = resolveFilePath(sessionId, fileId);
    if (!filePath) {
      res.status(404).json({ error: 'File not found on disk' });
      return;
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.sendFile(filePath);
  } catch (err) {
    console.error('[pdf] GET file error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
