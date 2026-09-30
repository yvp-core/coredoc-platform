import type { ArgumentsHost } from '@nestjs/common';
import { HttpStatus, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { IntentExceptionFilter, type IntentErrorResponseBody } from './intent-error.filter.js';
import {
  INTENT_PUBLIC_ERROR_LIMITS,
  IntentErrorCode,
  IntentPublicException,
  boundIntentPublicError,
  renderIntentPublicError,
} from './intent-errors.js';

function createHost(url = '/api/v1/workspaces/w1/intent/items'): {
  host: ArgumentsHost;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ originalUrl: url, method: 'POST' }),
      getResponse: () => ({ status }),
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('IntentExceptionFilter', () => {
  it('renders the public triple as the response body', () => {
    const { host, status, json } = createHost();
    new IntentExceptionFilter().catch(
      new IntentPublicException({
        code: IntentErrorCode.ContentEmailShaped,
        message: 'Intent content must not contain an email address',
        path: ['items', '0', 'payload', 'beneficiary'],
      }),
      host,
    );

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    const body = json.mock.calls[0][0] as IntentErrorResponseBody;
    expect(body).toMatchObject({
      statusCode: 400,
      requestPath: '/api/v1/workspaces/w1/intent/items',
      code: IntentErrorCode.ContentEmailShaped,
      path: ['items', '0', 'payload', 'beneficiary'],
    });
    expect(typeof body.timestamp).toBe('string');
  });

  it('never leaks internals: the body has no stack, sql, or provider fields', () => {
    const { host, json } = createHost();
    new IntentExceptionFilter().catch(
      new IntentPublicException({ code: IntentErrorCode.SchemaViolation, message: 'bad shape', path: ['id'] }),
      host,
    );

    const body = json.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['code', 'message', 'path', 'requestPath', 'statusCode', 'timestamp']);
  });

  it('catches only intent public exceptions, leaving every other error to the global filter', () => {
    // `@Catch(IntentPublicException)` is the contract: Nest never routes another
    // exception type here, so a NotFoundException from a guard keeps behaving
    // exactly as it does on every other route.
    expect(Reflect.getMetadata('__filterCatchExceptions__', IntentExceptionFilter)).toEqual([IntentPublicException]);
    expect(new NotFoundException('missing') instanceof IntentPublicException).toBe(false);
  });
});

describe('renderIntentPublicError', () => {
  it('passes a public refusal through with its status', () => {
    const exception = new IntentPublicException(
      { code: IntentErrorCode.ContentUrlCredentials, message: 'no credentials in urls', path: ['sources', '0', 'url'] },
      HttpStatus.BAD_REQUEST,
    );
    expect(renderIntentPublicError(exception)).toEqual({
      status: 400,
      error: {
        code: IntentErrorCode.ContentUrlCredentials,
        message: 'no credentials in urls',
        path: ['sources', '0', 'url'],
      },
    });
  });

  it('collapses an unexpected error into the generic bounded shape, discarding its message', () => {
    const secretish = new Error("select * from intent_items where token = 'ghp-AAAAAAAAAAAAAAAA'");
    const rendered = renderIntentPublicError(secretish);

    expect(rendered.status).toBe(500);
    expect(rendered.error).toEqual({
      code: IntentErrorCode.InternalError,
      message: 'The intent service could not complete this request.',
      path: [],
    });
    expect(JSON.stringify(rendered)).not.toContain('intent_items');
  });

  it('collapses a non-Error throw the same way', () => {
    expect(renderIntentPublicError('boom').error.code).toBe(IntentErrorCode.InternalError);
  });
});

describe('boundIntentPublicError', () => {
  it('truncates a long message', () => {
    const bounded = boundIntentPublicError({
      code: IntentErrorCode.SchemaViolation,
      message: 'x'.repeat(1_000),
      path: [],
    });
    expect(bounded.message).toHaveLength(INTENT_PUBLIC_ERROR_LIMITS.messageChars);
    expect(bounded.message.endsWith('…')).toBe(true);
  });

  it('caps the detail list and says how many were dropped', () => {
    const details = Array.from({ length: INTENT_PUBLIC_ERROR_LIMITS.details + 5 }, (_, index) => ({
      code: IntentErrorCode.SchemaViolation,
      message: `issue ${index}`,
      path: ['items', String(index)],
    }));
    const bounded = boundIntentPublicError({
      code: IntentErrorCode.SchemaViolation,
      message: 'many issues',
      path: [],
      details,
    });

    expect(bounded.details).toHaveLength(INTENT_PUBLIC_ERROR_LIMITS.details + 1);
    expect(bounded.details?.at(-1)?.message).toContain('5 further field error(s)');
  });

  it('is applied by the exception constructor, not left to the caller', () => {
    const exception = new IntentPublicException({
      code: IntentErrorCode.SchemaViolation,
      message: 'y'.repeat(500),
      path: ['id'],
    });
    expect(exception.publicError.message).toHaveLength(INTENT_PUBLIC_ERROR_LIMITS.messageChars);
    expect((exception.getResponse() as { message: string }).message).toHaveLength(
      INTENT_PUBLIC_ERROR_LIMITS.messageChars,
    );
  });
});
