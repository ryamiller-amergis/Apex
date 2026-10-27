import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type Router } from 'express';

/**
 * Serves the built web client: files from `dir`, and index.html for any other
 * GET or HEAD so client-side routes load. index.html is sent with no-cache so
 * a deploy takes effect at once. Returns undefined when `dir` has no
 * index.html, so an API-only run serves no static files.
 */
export function createClientStatic(
  dir: string | undefined
): Router | undefined {
  if (dir === undefined) {
    return undefined;
  }
  const root = path.resolve(dir);
  const indexFile = path.join(root, 'index.html');
  if (!existsSync(indexFile)) {
    return undefined;
  }
  const router = express.Router();
  router.use(express.static(root, { index: false }));
  router.get('/{*splat}', (_req, res, next) => {
    res.sendFile(
      indexFile,
      { headers: { 'Cache-Control': 'no-cache' } },
      (error) => {
        if (error) {
          next(error);
        }
      }
    );
  });
  return router;
}
