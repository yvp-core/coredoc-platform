import {
  BadRequestException,
  ConflictException,
  GatewayTimeoutException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { GRAPH_SNAPSHOT_ERROR_POLICY } from '../../libs/pipeline/graph-snapshot.errors.js';

export interface ClassifiedJobError {
  code: string;
  message: string;
  retryable: boolean;
  statusCode: number;
}

export interface PersistedJobError {
  error: {
    code: string;
    jobId: string;
    message: string;
    statusCode: number;
  };
}

const GRAPH_ERROR_POLICY: Readonly<Record<string, { retryable: boolean; statusCode: number }>> =
  GRAPH_SNAPSHOT_ERROR_POLICY;
// ConflictException also represents push contention; only deterministic delivery conflicts are permanent.
const DELIVERY_JOB_CONFLICT_CODES = new Set([
  'TASK_IDENTITY_CONFLICT',
  'TASK_EXTERNAL_REF_CONFLICT',
  'TASK_AUTHORITY_CONFLICT',
  'TASK_AUTHORITY_MIGRATION_REQUIRED',
  'TASK_STATE_FACT_CONFLICT',
  'SHIP_EVIDENCE_CONFLICT',
  'REWORK_SIGNAL_CONFLICT',
  'GITHUB_CANONICAL_PROJECTION_CONFLICT',
]);
const MAX_PUBLIC_ERROR_MESSAGE_LENGTH = 500;

function safeMessage(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value : fallback;
  return text.slice(0, MAX_PUBLIC_ERROR_MESSAGE_LENGTH);
}

function safeHttpMessage(error: HttpException): string {
  const response = error.getResponse();
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object' && 'message' in response) {
    const message = (response as { message?: unknown }).message;
    if (Array.isArray(message)) return message.map(String).join('; ');
    if (typeof message === 'string') return message;
  }
  return error.message;
}

function structuralCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function deliveryConflictCode(error: ConflictException): string | null {
  const response = error.getResponse();
  if (!response || typeof response !== 'object' || !('code' in response)) return null;
  const code = (response as { code?: unknown }).code;
  return typeof code === 'string' && DELIVERY_JOB_CONFLICT_CODES.has(code) ? code : null;
}

export function classifyJobError(error: unknown): ClassifiedJobError {
  const code = structuralCode(error);
  if (code && GRAPH_ERROR_POLICY[code]) {
    const policy = GRAPH_ERROR_POLICY[code];
    const message = safeMessage(error && typeof error === 'object' && 'message' in error ? error.message : code, code);
    return { code, message, ...policy };
  }

  if (error instanceof ConflictException) {
    const deliveryCode = deliveryConflictCode(error);
    if (deliveryCode) {
      return {
        code: deliveryCode,
        message: safeMessage(safeHttpMessage(error), deliveryCode),
        retryable: false,
        statusCode: HttpStatus.CONFLICT,
      };
    }
  }

  if (error instanceof BadRequestException) {
    return {
      code: 'job_bad_request',
      message: safeHttpMessage(error),
      retryable: false,
      statusCode: HttpStatus.BAD_REQUEST,
    };
  }
  if (error instanceof NotFoundException) {
    return {
      code: 'job_not_found',
      message: safeHttpMessage(error),
      retryable: false,
      statusCode: HttpStatus.NOT_FOUND,
    };
  }
  if (error instanceof ServiceUnavailableException) {
    return {
      code: 'job_service_unavailable',
      message: safeHttpMessage(error),
      retryable: true,
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
    };
  }

  return {
    code: 'job_internal_error',
    message: 'Job execution failed',
    retryable: true,
    statusCode: HttpStatus.SERVICE_UNAVAILABLE,
  };
}

export function serializeTerminalJobError(jobId: string, error: ClassifiedJobError): PersistedJobError {
  return {
    error: {
      code: error.code,
      jobId,
      message: safeMessage(error.message, 'Job failed'),
      statusCode: error.statusCode,
    },
  };
}

function persistedError(value: unknown): PersistedJobError['error'] | null {
  if (!value || typeof value !== 'object' || !('error' in value)) return null;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return null;
  const candidate = error as Partial<PersistedJobError['error']>;
  if (
    typeof candidate.code !== 'string' ||
    typeof candidate.jobId !== 'string' ||
    typeof candidate.message !== 'string' ||
    typeof candidate.statusCode !== 'number'
  ) {
    return null;
  }
  const statusCode =
    Number.isInteger(candidate.statusCode) && candidate.statusCode >= 400 && candidate.statusCode <= 599
      ? candidate.statusCode
      : HttpStatus.INTERNAL_SERVER_ERROR;
  const code =
    /^[a-z0-9_]{1,64}$/.test(candidate.code) || DELIVERY_JOB_CONFLICT_CODES.has(candidate.code)
      ? candidate.code
      : 'job_failed';
  return {
    code,
    jobId: candidate.jobId,
    message: safeMessage(candidate.message, 'Job failed'),
    statusCode,
  };
}

export class JobFailedException extends HttpException {
  readonly code: string;
  readonly jobId: string;

  constructor(jobId: string, result: unknown) {
    const stored = persistedError(result) ?? {
      code: 'job_failed',
      jobId,
      message: 'Job failed',
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    };
    const authoritative = { ...stored, jobId };
    super(authoritative, authoritative.statusCode);
    this.code = authoritative.code;
    this.jobId = jobId;
  }
}

export class JobStillRunningException extends GatewayTimeoutException {
  readonly code = 'job_still_running';

  constructor(readonly jobId: string) {
    super({ code: 'job_still_running', jobId, message: 'Job is still running' });
  }
}
