import type { RequestHandler } from 'express';

/** Personal data and probe answers must never sit in a shared cache. */
export function noStore(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  };
}
