import type { NextFunction, Request, Response } from 'express';

/**
 * Stamps X-Coredoc-Version on every response. Registered as the first Express
 * middleware in bootstrap so responses that never reach a Nest route — the
 * 413 body-size refusal, 404s, GlobalExceptionFilter 5xx — still carry the
 * version. A client debugging an opaque failure gets the server version from
 * the failure itself.
 */
export function versionHeaderMiddleware(version: string) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-Coredoc-Version', version);
    next();
  };
}
