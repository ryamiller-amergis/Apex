/**
 * Serves token-gated static preview assets for a build revision.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  createPreviewReadStream,
  previewAssetContentType,
  resolvePreviewAssetPath,
} from '../services/buildPreviewArtifactService';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const router = Router({ mergeParams: true });

async function servePreviewAsset(
  req: Request,
  res: Response,
  next: NextFunction,
  assetPath: string,
): Promise<void> {
  try {
    const { buildId, token } = req.params;
    if (!UUID_RE.test(buildId)) {
      res.status(404).end();
      return;
    }
    const resolved = await resolvePreviewAssetPath(buildId, token, assetPath);
    if (!resolved) {
      res.status(404).end();
      return;
    }
    const contentType = previewAssetContentType(resolved.absolutePath);
    const isHtml = contentType.startsWith('text/html');
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (isHtml) {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'",
      );
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
    const stream = await createPreviewReadStream(resolved.absolutePath);
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end();
    });
    stream.pipe(res);
  } catch (error) {
    next(error);
  }
}

router.get('/:buildId/preview/:token/*', (req, res, next) => {
  const wildcard = (req.params as Record<string, string | string[]>)['0'] ?? '';
  const assetPath = Array.isArray(wildcard) ? wildcard.join('/') : wildcard;
  void servePreviewAsset(req, res, next, assetPath);
});

router.get('/:buildId/preview/:token', (req, res, next) => {
  void servePreviewAsset(req, res, next, 'index.html');
});

export default router;
