import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { classifyJobError, JobFailedException, serializeTerminalJobError } from './job-errors.js';

describe('job error classification and persistence', () => {
  it('retries parent conflicts but keeps stale lease ownership permanent', () => {
    expect(classifyJobError({ code: 'graph_parent_conflict', message: 'parent moved' })).toMatchObject({
      code: 'graph_parent_conflict',
      retryable: true,
      statusCode: 409,
    });
    expect(classifyJobError({ code: 'graph_job_in_progress', message: 'lease moved' })).toMatchObject({
      code: 'graph_job_in_progress',
      retryable: false,
      statusCode: 409,
    });
  });

  it('keeps existing permanent Nest validation failures permanent', () => {
    expect(classifyJobError(new BadRequestException('bad payload'))).toMatchObject({
      code: 'job_bad_request',
      retryable: false,
      statusCode: 400,
    });
  });

  it.each([
    'TASK_IDENTITY_CONFLICT',
    'TASK_EXTERNAL_REF_CONFLICT',
    'TASK_AUTHORITY_CONFLICT',
    'TASK_AUTHORITY_MIGRATION_REQUIRED',
    'TASK_STATE_FACT_CONFLICT',
    'SHIP_EVIDENCE_CONFLICT',
    'REWORK_SIGNAL_CONFLICT',
    'GITHUB_CANONICAL_PROJECTION_CONFLICT',
  ])('keeps allow-listed canonical delivery conflict %s permanent and preserves it through job reads', (code) => {
    const message = `Canonical delivery conflict: ${'x'.repeat(600)}`;
    const classified = classifyJobError(new ConflictException({ statusCode: 409, error: 'Conflict', code, message }));

    expect(classified).toEqual({
      code,
      message: message.slice(0, 500),
      retryable: false,
      statusCode: 409,
    });

    const exception = new JobFailedException('job-authoritative', serializeTerminalJobError('job-stored', classified));
    expect(exception.getStatus()).toBe(409);
    expect(exception.getResponse()).toEqual({
      code,
      jobId: 'job-authoritative',
      message: message.slice(0, 500),
      statusCode: 409,
    });
  });

  it('keeps unrelated Nest conflicts on the generic retryable path', () => {
    expect(
      classifyJobError(
        new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: 'UNRELATED_CONFLICT',
          message: 'must not become a new public job policy',
        }),
      ),
    ).toEqual({
      code: 'job_internal_error',
      message: 'Job execution failed',
      retryable: true,
      statusCode: 503,
    });
  });

  it('does not admit unrelated uppercase codes from persisted job rows', () => {
    const exception = new JobFailedException('job-authoritative', {
      error: {
        code: 'UNRELATED_CONFLICT',
        jobId: 'job-stored',
        message: 'bounded but not allow-listed',
        statusCode: 409,
      },
    });

    expect(exception.getResponse()).toEqual({
      code: 'job_failed',
      jobId: 'job-authoritative',
      message: 'bounded but not allow-listed',
      statusCode: 409,
    });
  });

  it('keeps unknown infrastructure failures retryable and redacts their message', () => {
    expect(classifyJobError(new Error('postgres password=secret-value'))).toEqual({
      code: 'job_internal_error',
      message: 'Job execution failed',
      retryable: true,
      statusCode: 503,
    });
    expect(classifyJobError(new ServiceUnavailableException('R2 unavailable'))).toMatchObject({
      code: 'job_service_unavailable',
      retryable: true,
      statusCode: 503,
    });
  });

  it('serializes the safe terminal shape with the authoritative job id', () => {
    expect(
      serializeTerminalJobError('job_1', {
        code: 'graph_parent_conflict',
        message: 'parent changed',
        retryable: true,
        statusCode: 409,
      }),
    ).toEqual({
      error: {
        code: 'graph_parent_conflict',
        jobId: 'job_1',
        message: 'parent changed',
        statusCode: 409,
      },
    });
  });

  it.each([200, 399, 600, Number.NaN])('never turns a malformed failed-row status %s into success', (statusCode) => {
    const exception = new JobFailedException('job-authoritative', {
      error: {
        code: 'graph_parent_conflict',
        jobId: 'job-untrusted',
        message: 'safe',
        statusCode,
      },
    });

    expect(exception.getStatus()).toBe(500);
    expect(exception.getResponse()).toMatchObject({
      code: 'graph_parent_conflict',
      jobId: 'job-authoritative',
      message: 'safe',
      statusCode: 500,
    });
  });

  it('bounds persisted terminal messages again at the read boundary', () => {
    const exception = new JobFailedException('job-1', {
      error: { code: 'job_failed', jobId: 'job-1', message: 'x'.repeat(5_000), statusCode: 500 },
    });

    expect((exception.getResponse() as { message: string }).message).toHaveLength(500);
  });
});
