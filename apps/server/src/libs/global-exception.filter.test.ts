import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { GlobalExceptionFilter } from './global-exception.filter.js';
import type { HttpAdapterHost } from '@nestjs/core';
import type { ArgumentsHost } from '@nestjs/common';
import type { TelemetryService } from '../modules/telemetry/telemetry.service.js';
import { JobFailedException, JobStillRunningException } from '../modules/job-queue/job-errors.js';
import { GraphSnapshotError } from './pipeline/graph-snapshot.errors.js';

function createMockHost(request: Record<string, unknown> = {}): {
  host: ArgumentsHost;
  response: { status: ReturnType<typeof vi.fn> };
} {
  const response = { status: vi.fn() };
  const httpRequest = { method: 'GET', url: '/api/thing', ...request };
  const host = {
    switchToHttp: () => ({
      getRequest: () => httpRequest,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

function createMockAdapterHost(): {
  adapterHost: HttpAdapterHost;
  reply: ReturnType<typeof vi.fn>;
} {
  const reply = vi.fn();
  const adapterHost = {
    httpAdapter: {
      getRequestUrl: (req: { url?: string }) => req?.url,
      reply,
    },
  } as unknown as HttpAdapterHost;
  return { adapterHost, reply };
}

describe('GlobalExceptionFilter', () => {
  let adapterHost: HttpAdapterHost;
  let reply: ReturnType<typeof vi.fn>;
  let telemetryService: { captureException: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    const mocked = createMockAdapterHost();
    adapterHost = mocked.adapterHost;
    reply = mocked.reply;
    telemetryService = { captureException: vi.fn() };
  });

  it('passes through a string response body from an HttpException', () => {
    const filter = new GlobalExceptionFilter(adapterHost, telemetryService as unknown as TelemetryService);
    const exception = new HttpException('q is required', HttpStatus.BAD_REQUEST);
    const { host } = createMockHost();

    filter.catch(exception, host);

    expect(reply).toHaveBeenCalledTimes(1);
    const [, body, status] = reply.mock.calls[0];
    expect(status).toBe(400);
    expect(body.message).toBe('q is required');
  });

  it('passes through an object response body with a `message` string', () => {
    const filter = new GlobalExceptionFilter(adapterHost, telemetryService as unknown as TelemetryService);
    const exception = new BadRequestException('name is invalid');
    const { host } = createMockHost();

    filter.catch(exception, host);

    const [, body] = reply.mock.calls[0];
    expect(body.message).toBe('name is invalid');
  });

  it('joins a ValidationPipe-style message array with "; "', () => {
    const filter = new GlobalExceptionFilter(adapterHost, telemetryService as unknown as TelemetryService);
    const exception = new BadRequestException({
      message: ['field a is required', 'field b is invalid'],
      error: 'Bad Request',
      statusCode: 400,
    });
    const { host } = createMockHost();

    filter.catch(exception, host);

    const [, body] = reply.mock.calls[0];
    expect(body.message).toBe('field a is required; field b is invalid');
  });

  it('produces a message-less 500 body with exactly the expected keys for a plain Error', () => {
    const filter = new GlobalExceptionFilter(adapterHost, telemetryService as unknown as TelemetryService);
    const exception = new Error('db connection refused: password=hunter2');
    const { host } = createMockHost();

    filter.catch(exception, host);

    const [, body, status] = reply.mock.calls[0];
    expect(status).toBe(500);
    expect(body).not.toHaveProperty('message');
    expect(body).not.toHaveProperty('stack');
    expect(Object.keys(body).sort()).toEqual(['path', 'statusCode', 'timestamp']);
  });

  it('produces the same message-less 500 body for a TypeError (not string-matched against Error)', () => {
    const filter = new GlobalExceptionFilter(adapterHost, telemetryService as unknown as TelemetryService);
    const exception = new TypeError('cannot read properties of undefined');
    const { host } = createMockHost();

    filter.catch(exception, host);

    const [, body, status] = reply.mock.calls[0];
    expect(status).toBe(500);
    expect(body).not.toHaveProperty('message');
    expect(body).not.toHaveProperty('stack');
    expect(Object.keys(body).sort()).toEqual(['path', 'statusCode', 'timestamp']);
  });

  it('reports non-HttpException 500s to telemetry', () => {
    const filter = new GlobalExceptionFilter(adapterHost, telemetryService as unknown as TelemetryService);
    const exception = new Error('boom');
    const { host } = createMockHost();

    filter.catch(exception, host);

    expect(telemetryService.captureException).toHaveBeenCalledTimes(1);
    expect(telemetryService.captureException).toHaveBeenCalledWith(exception, expect.anything());
  });

  it('reports an HttpException at exactly the 500 boundary to telemetry', () => {
    const filter = new GlobalExceptionFilter(adapterHost, telemetryService as unknown as TelemetryService);
    const exception = new HttpException('internal', HttpStatus.INTERNAL_SERVER_ERROR);
    const { host } = createMockHost();

    filter.catch(exception, host);

    expect(telemetryService.captureException).toHaveBeenCalledTimes(1);
  });

  it('does not report a 4xx HttpException to telemetry', () => {
    const filter = new GlobalExceptionFilter(adapterHost, telemetryService as unknown as TelemetryService);
    const exception = new BadRequestException('bad input');
    const { host } = createMockHost();

    filter.catch(exception, host);

    expect(telemetryService.captureException).not.toHaveBeenCalled();
  });

  it('logs 5xx graph errors without telemetry while leaving 4xx graph conflicts quiet', () => {
    const filter = new GlobalExceptionFilter(adapterHost);
    const logger = (filter as unknown as { logger: { error: (...args: unknown[]) => void } }).logger;
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { host } = createMockHost();
    const timeout = new GraphSnapshotError('graph_pointer_timeout', 'Pointer update timed out');

    filter.catch(timeout, host);

    expect(errorLog).toHaveBeenCalledWith(`Unhandled exception: ${timeout}`, timeout.stack);
    errorLog.mockClear();

    filter.catch(new GraphSnapshotError('graph_parent_conflict', 'Parent changed'), host);

    expect(errorLog).not.toHaveBeenCalled();
  });

  it.each([
    'graph_parent_conflict',
    'graph_job_in_progress',
  ] as const)('preserves typed 409 responses for %s', (code) => {
    const filter = new GlobalExceptionFilter(adapterHost, telemetryService as unknown as TelemetryService);
    const exception = new GraphSnapshotError(code, 'Safe graph conflict');
    const { host } = createMockHost({ url: '/api/v1/workspaces/ws-1/graph/search' });

    filter.catch(exception, host);

    const [, body, status] = reply.mock.calls[0];
    expect(status).toBe(HttpStatus.CONFLICT);
    expect(body).toMatchObject({ code, message: 'Safe graph conflict', statusCode: HttpStatus.CONFLICT });
    expect(Object.keys(body).sort()).toEqual(['code', 'message', 'path', 'statusCode', 'timestamp']);
    expect(telemetryService.captureException).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'persisted terminal failure',
      exception: new JobFailedException('job-current', {
        error: {
          code: 'graph_parent_conflict',
          jobId: 'job-stored',
          message: 'The active graph changed before publication',
          statusCode: HttpStatus.CONFLICT,
          secret: 'must-not-leak',
        },
      }),
      expected: {
        code: 'graph_parent_conflict',
        jobId: 'job-current',
        message: 'The active graph changed before publication',
        statusCode: HttpStatus.CONFLICT,
      },
    },
    {
      label: 'bounded synchronous wait',
      exception: new JobStillRunningException('job-running'),
      expected: {
        code: 'job_still_running',
        jobId: 'job-running',
        message: 'Job is still running',
        statusCode: HttpStatus.GATEWAY_TIMEOUT,
      },
    },
  ])('serializes safe typed sync fields for $label', ({ exception, expected }) => {
    const filter = new GlobalExceptionFilter(adapterHost, telemetryService as unknown as TelemetryService);
    const { host } = createMockHost({ url: '/api/v1/workspaces/ws-1/push?sync=true' });

    filter.catch(exception, host);

    const [, body, status] = reply.mock.calls[0];
    expect(status).toBe(expected.statusCode);
    expect(body).toMatchObject(expected);
    expect(body).not.toHaveProperty('secret');
    expect(Object.keys(body).sort()).toEqual(['code', 'jobId', 'message', 'path', 'statusCode', 'timestamp']);
  });
});
