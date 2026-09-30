import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { INTENT_CONTENT_LIMITS, assertSafeCloudContent, parseContract } from './intent-content.js';
import {
  IntentErrorCode,
  IntentPublicException,
  type IntentPublicError,
  formatIntentErrorPath,
} from './intent-errors.js';
import { ProposeIntentItemsSchema } from './intent-operations.js';

/** Run `fn`, expecting a public contract violation, and hand back its triple. */
function violation(fn: () => unknown): IntentPublicError {
  try {
    fn();
  } catch (error) {
    if (error instanceof IntentPublicException) return error.publicError;
    throw error;
  }
  throw new Error('expected a contract violation, got none');
}

describe('assertSafeCloudContent — pattern matrix, each asserting the reported path', () => {
  it('rejects a private key header and names the exact field', () => {
    const error = violation(() =>
      assertSafeCloudContent({ items: [{ payload: { note: '-----BEGIN RSA PRIVATE KEY-----' } }] }),
    );
    expect(error.code).toBe(IntentErrorCode.ContentSecretShaped);
    expect(error.path).toEqual(['items', '0', 'payload', 'note']);
  });

  it.each([
    ['api_key: abcd', 'apiKeyAssignment'],
    ['password=hunter2', 'passwordAssignment'],
    ['access-token : xyz', 'accessTokenAssignment'],
    ['ghp-AAAAAAAAAAAAAAAA', 'githubToken'],
    ['sk-AAAAAAAAAAAAAAAA', 'providerToken'],
  ])('rejects secret-shaped %s', (value, key) => {
    const error = violation(() => assertSafeCloudContent({ [key]: value }));
    expect(error.code).toBe(IntentErrorCode.ContentSecretShaped);
    expect(error.path).toEqual([key]);
  });

  it.each([
    ['\u0000', 'nul'],
    ['\r', 'carriageReturn'],
    ['\u001b[31m', 'ansiEscape'],
    ['\b', 'backspace'],
    ['\u007f', 'del'],
    // C1: a second escape introducer that an `\x1b`-only filter walks straight past.
    ['\u009b', 'c1ControlSequenceIntroducer'],
  ])('rejects the control character in %j and names the field', (value, key) => {
    const error = violation(() => assertSafeCloudContent({ [key]: `statement ${value} tail` }));
    expect(error.code).toBe(IntentErrorCode.ContentControlChars);
    expect(error.path).toEqual([key]);
  });

  it('rejects a control character nested in a payload, reporting the whole path', () => {
    const error = violation(() => assertSafeCloudContent({ items: [{ payload: { note: 'a\u0007b' } }] }));
    expect(error.code).toBe(IntentErrorCode.ContentControlChars);
    expect(error.path).toEqual(['items', '0', 'payload', 'note']);
  });

  it('keeps newline and tab, which carry meaning in a bounded statement', () => {
    expect(() => assertSafeCloudContent({ statement: 'A rule\nwith a\tcolumn' })).not.toThrow();
  });

  it('rejects an email nested deep inside a payload and reports the whole path', () => {
    const error = violation(() =>
      assertSafeCloudContent({
        decisions: [{ item: { payload: { owners: ['ok', 'jane.doe@example.com'] } } }],
      }),
    );
    expect(error.code).toBe(IntentErrorCode.ContentEmailShaped);
    expect(error.path).toEqual(['decisions', '0', 'item', 'payload', 'owners', '1']);
    expect(formatIntentErrorPath(error.path)).toBe('decisions[0].item.payload.owners[1]');
  });

  it('rejects a token-shaped query parameter on a url field', () => {
    const error = violation(() =>
      assertSafeCloudContent({ sources: [{ url: 'https://tracker.example.com/i/7?token=abcdef' }] }),
    );
    expect(error.code).toBe(IntentErrorCode.ContentUrlCredentials);
    expect(error.path).toEqual(['sources', '0', 'url']);
  });

  it.each([
    'token',
    'secretRef',
    'refreshToken',
    'signing_key',
  ])('rejects the credential query parameter %s', (param) => {
    const error = violation(() => assertSafeCloudContent({ url: `https://example.com/i?${param}=v` }));
    expect(error.code).toBe(IntentErrorCode.ContentUrlCredentials);
    expect(error.path).toEqual(['url']);
  });

  it.each([
    'api_key',
    'apiKey',
    'PASSWORD',
    'access_token',
  ])('rejects the query parameter %s earlier, as secret-shaped text', (param) => {
    // `<credential-name>=` matches the secret pattern before the url rule is
    // reached. Same refusal for the caller, different code — pinned so the
    // remediation text a CLI shows for each code stays truthful.
    const error = violation(() => assertSafeCloudContent({ url: `https://example.com/i?${param}=v` }));
    expect(error.code).toBe(IntentErrorCode.ContentSecretShaped);
    expect(error.path).toEqual(['url']);
  });

  it('rejects userinfo credentials — as email-shaped content, which is checked before the url rule', () => {
    // Pinning the archive's check ORDER: `user:pass@host.tld` matches the email
    // pattern first. Both refusals are correct; the test states which one a
    // caller actually receives so the CLI's remediation text can match it.
    const error = violation(() => assertSafeCloudContent({ url: 'https://user:pass@example.com/i' }));
    expect(error.code).toBe(IntentErrorCode.ContentEmailShaped);
    expect(error.path).toEqual(['url']);
  });

  it('rejects an unparseable url field instead of throwing a raw TypeError', () => {
    const error = violation(() => assertSafeCloudContent({ overlay: { url: 'not a url' } }));
    expect(error.code).toBe(IntentErrorCode.ContentUrlUnparseable);
    expect(error.path).toEqual(['overlay', 'url']);
  });

  it('accepts a clean https url', () => {
    expect(() => assertSafeCloudContent({ url: 'https://example.com/specs/ordering#CAP-1' })).not.toThrow();
  });

  it('rejects a long multi-line body but accepts a long single-line statement', () => {
    const body = `${'x'.repeat(INTENT_CONTENT_LIMITS.maxMultilineChars)}\ny`;
    const error = violation(() => assertSafeCloudContent({ items: [{ statement: body }] }));
    expect(error.code).toBe(IntentErrorCode.ContentSourceBodyShaped);
    expect(error.path).toEqual(['items', '0', 'statement']);

    expect(() => assertSafeCloudContent({ items: [{ statement: 'x'.repeat(4000) }] })).not.toThrow();
    expect(() => assertSafeCloudContent({ items: [{ statement: 'two\nlines' }] })).not.toThrow();
  });

  it('rejects structure nested past the depth limit and names the path where it tripped', () => {
    let value: unknown = 'leaf';
    for (let i = 0; i < INTENT_CONTENT_LIMITS.maxDepth + 1; i += 1) value = { nested: value };

    const error = violation(() => assertSafeCloudContent(value));
    expect(error.code).toBe(IntentErrorCode.ContentStructureExceeded);
    expect(error.message).toContain(String(INTENT_CONTENT_LIMITS.maxDepth));
    expect(error.path).toHaveLength(INTENT_CONTENT_LIMITS.maxDepth + 1);
    expect(new Set(error.path)).toEqual(new Set(['nested']));
  });

  it('accepts structure exactly at the depth limit', () => {
    let value: unknown = 'leaf';
    for (let i = 0; i < INTENT_CONTENT_LIMITS.maxDepth; i += 1) value = { nested: value };
    expect(() => assertSafeCloudContent(value)).not.toThrow();
  });

  it('rejects a request over the node budget and names the path where the budget ran out', () => {
    const error = violation(() => assertSafeCloudContent({ items: ['a', 'b', 'c', 'd'] }, { maxStructureNodes: 4 }));
    expect(error.code).toBe(IntentErrorCode.ContentStructureExceeded);
    expect(error.message).toContain('4');
    expect(error.path).toEqual(['items', '2']);
  });

  it('walks the import overlay under the larger import budget', () => {
    const overlay = { items: Array.from({ length: 3_000 }, (_, index) => ({ statement: `s${index}` })) };
    expect(() => assertSafeCloudContent(overlay)).toThrow(IntentPublicException);
    expect(() =>
      assertSafeCloudContent(overlay, { maxStructureNodes: INTENT_CONTENT_LIMITS.maxImportStructureNodes }),
    ).not.toThrow();
  });
});

describe('parseContract', () => {
  const schema = z
    .object({ title: z.string().max(10), count: z.number().int().optional(), note: z.string().optional() })
    .strict();

  it('reports a schema failure as one public error carrying every failing field path', () => {
    const error = violation(() => parseContract(schema, { title: 'way too long a title', count: 1.5 }));
    expect(error.code).toBe(IntentErrorCode.SchemaViolation);
    expect(error.path).toEqual(['title']);
    expect(error.details?.map((detail) => detail.path)).toEqual([['title'], ['count']]);
  });

  it('rejects an unknown key', () => {
    const error = violation(() => parseContract(schema, { title: 'ok', extra: 1 }));
    expect(error.code).toBe(IntentErrorCode.SchemaViolation);
    expect(error.message).toContain('extra');
  });

  it('runs the schema BEFORE the content walk', () => {
    // `extra` carries an email; the shape error must still win, because the walk
    // is only sound on a value whose shape is already known.
    const error = violation(() => parseContract(schema, { title: 'ok', extra: 'jane@example.com' }));
    expect(error.code).toBe(IntentErrorCode.SchemaViolation);
  });

  it('applies the content contract to a value the schema accepted', () => {
    const error = violation(() => parseContract(schema, { title: 'ok', note: 'ping jane@example.com' }));
    expect(error.code).toBe(IntentErrorCode.ContentEmailShaped);
    expect(error.path).toEqual(['note']);
  });

  it('returns the parsed value when both layers pass', () => {
    expect(parseContract(schema, { title: 'ok' })).toEqual({ title: 'ok' });
  });

  it('rejects an email nested deep in a real propose payload with the full request path', () => {
    const request = {
      idempotencyKey: 'k-1',
      items: [
        {
          kind: 'capability',
          title: 'Widget ordering',
          statement: 'The product lets an operator order widgets.',
          sources: [{ kind: 'spec', ref: 'spec/ordering', localId: 'CAP-1' }],
          payload: {
            outcome: 'An operator can place an order',
            beneficiary: 'Store operator jane.doe@example.com',
            boundary: 'One warehouse',
          },
        },
      ],
    };

    const error = violation(() => parseContract(ProposeIntentItemsSchema, request));
    expect(error.code).toBe(IntentErrorCode.ContentEmailShaped);
    expect(error.path).toEqual(['items', '0', 'payload', 'beneficiary']);
  });
});
