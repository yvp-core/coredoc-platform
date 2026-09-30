import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { redactSensitiveQueryParams } from './redact-url.js';

@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction) {
    const start = Date.now();
    const { method, originalUrl } = req;
    // Redact secret query params (e.g. the OAuth `code` on /auth/callback) so
    // replayable auth artifacts never land in logs.
    const safeUrl = redactSensitiveQueryParams(originalUrl);

    res.on('finish', () => {
      const duration = Date.now() - start;
      const { statusCode } = res;
      const message = `${method} ${safeUrl} ${statusCode} ${duration}ms`;

      if (statusCode >= 500) {
        this.logger.error(message);
      } else if (statusCode >= 400) {
        this.logger.warn(message);
      } else {
        this.logger.log(message);
      }
    });

    next();
  }
}
