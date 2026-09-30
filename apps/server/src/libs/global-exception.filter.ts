import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { TelemetryService } from '../modules/telemetry/telemetry.service.js';
import { isGraphSnapshotError } from './pipeline/graph-snapshot.errors.js';
import { redactSensitiveQueryParams } from './redact-url.js';

/**
 * Nest's HttpException.getResponse() is either a plain string (rare, only
 * when the exception was constructed with a bare string and no options) or
 * the standard `{ message, error, statusCode }` object every built-in
 * exception (BadRequestException, NotFoundException, …) produces. Normalize
 * both shapes and retain only the explicit public sync-error fields.
 */
function extractSafeHttpResponse(exception: HttpException): { message: string; code?: string; jobId?: string } {
  const body = exception.getResponse();
  if (typeof body === 'string') return { message: body };
  if (body && typeof body === 'object' && 'message' in body) {
    const { message, code, jobId } = body as { message: unknown; code?: unknown; jobId?: unknown };
    return {
      message: Array.isArray(message) ? message.join('; ') : String(message),
      ...(typeof code === 'string' ? { code } : {}),
      ...(typeof jobId === 'string' ? { jobId } : {}),
    };
  }
  return { message: exception.message };
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly telemetryService?: TelemetryService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    // In certain situations `httpAdapter` might not be available in the
    // constructor method, thus we should resolve it here.
    const { httpAdapter } = this.httpAdapterHost;

    const ctx = host.switchToHttp();
    const graphError = isGraphSnapshotError(exception) ? exception : null;

    const httpStatus =
      exception instanceof HttpException
        ? exception.getStatus()
        : (graphError?.statusCode ?? HttpStatus.INTERNAL_SERVER_ERROR);

    // Log unhandled errors and server-side graph failures locally regardless
    // of whether optional telemetry is configured. Expected 4xx graph errors
    // stay quiet.
    if (!(exception instanceof HttpException) && (!graphError || httpStatus >= 500)) {
      this.logger.error(`Unhandled exception: ${exception}`, (exception as Error)?.stack);
    }

    // Forward server-side errors (5xx) to PostHog. We skip 4xx because those
    // are expected client errors (validation, auth, not-found) — they would
    // create noise without signaling a real problem.
    if (this.telemetryService && httpStatus >= 500) {
      const request = ctx.getRequest<{
        method?: string;
        url?: string;
        user?: { id?: string };
        params?: { workspaceId?: string };
      }>();
      this.telemetryService.captureException(exception, {
        userId: request?.user?.id,
        workspaceId: request?.params?.workspaceId,
        properties: {
          method: request?.method,
          // Redact secret query params (e.g. the OAuth `code`) before they reach telemetry.
          path: request?.url ? redactSensitiveQueryParams(request.url) : undefined,
          statusCode: httpStatus,
        },
      });
    }

    const responseBody = {
      statusCode: httpStatus,
      timestamp: new Date().toISOString(),
      path: httpAdapter.getRequestUrl(ctx.getRequest()),
      // Surface the HttpException's own message (e.g. BadRequestException's
      // "q is required", or a scope-resolution hint like "Available repos:
      // …") to the client. Nest's built-in HttpExceptions carry it in
      // getResponse() as either a plain string or `{ message, error,
      // statusCode }`; non-HttpException errors (bugs/infra failures) never
      // leak their message here — only the generic 500 status goes out.
      ...(exception instanceof HttpException
        ? extractSafeHttpResponse(exception)
        : graphError
          ? { code: graphError.code, message: graphError.message }
          : {}),
    };

    httpAdapter.reply(ctx.getResponse(), responseBody, httpStatus);
  }
}
