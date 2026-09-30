/**
 * Renders the §12 public error as the HTTP response body for intent routes.
 *
 * Scoped to {@link IntentPublicException} ON PURPOSE. Everything else — Nest's
 * own `NotFoundException`, a guard's `ForbiddenException`, an unexpected bug —
 * keeps bubbling to `GlobalExceptionFilter` and behaves exactly as it does on
 * every other route today. This filter adds a shape; it removes none.
 *
 * Apply it per controller or per module:
 *   `@UseFilters(IntentExceptionFilter)`.
 */
import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { IntentPublicException, renderIntentPublicError, type IntentPublicError } from './intent-errors.js';

/**
 * The wire body. The `{ code, message, path, details }` subset IS the
 * {@link IntentPublicError} verbatim, so a CLI or MCP client reads the same
 * object regardless of transport. The request URL is `requestPath`, not `path`,
 * precisely because `path` here means the failing FIELD.
 */
export interface IntentErrorResponseBody extends IntentPublicError {
  statusCode: number;
  timestamp: string;
  requestPath?: string;
}

@Catch(IntentPublicException)
export class IntentExceptionFilter implements ExceptionFilter<IntentPublicException> {
  catch(exception: IntentPublicException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<{ originalUrl?: string; url?: string }>();
    const { status, error } = renderIntentPublicError(exception);

    const body: IntentErrorResponseBody = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      ...((request?.originalUrl ?? request?.url) ? { requestPath: request.originalUrl ?? request.url } : {}),
      ...error,
    };

    ctx.getResponse<Response>().status(status).json(body);
  }
}
