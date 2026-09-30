import { describe, expect, it } from 'vitest';
import { authModeFor, evidenceSchema, MAX_EVIDENCE_LINES, requestSchema, runtimeFor } from './contracts.js';

const base = 'a'.repeat(40);
const parse = (provider: string) =>
  requestSchema.parse({
    schemaVersion: 1,
    repository: 'owner/repo',
    pullNumber: 1,
    baseSha: base,
    mergeBaseSha: base,
    headSha: 'b'.repeat(40),
    mode: 'historical',
    arm: 'A',
    policy: { version: 'test', text: '' },
    model: { provider, id: 'test-model' },
  });

describe('model provider contract', () => {
  it('refuses credentials embedded in a provider URL', () => {
    const provider = new URL('https://example.test/v1');
    provider.username = 'fixture-user';
    provider.password = 'fixture-password';
    expect(() => parse(provider.href)).toThrow(
      'Provider must be a known provider name or an https URL (http only on loopback)',
    );
  });
  it.each([
    'openrouter',
    'anthropic',
    'https://example.test/v1',
    'http://127.0.0.1:1234/v1',
    'http://localhost:1234/v1',
  ])('accepts %s', (provider) => {
    expect(parse(provider).model.provider).toBe(provider);
  });
  it.each([
    'http://attacker.tld/v1',
    'https://example.test/v1?x=1',
    'https://example.test/v1#f',
    'ftp://example.test/v1',
    'not a url',
  ])('refuses %s so the key and pinned source cannot be redirected', (provider) => {
    expect(() => parse(provider)).toThrow(
      'Provider must be a known provider name or an https URL (http only on loopback)',
    );
  });
});

describe('evidence quote contract', () => {
  const evidence = (lines: number, width = 1) => ({
    revision: 'head',
    path: 'src/a.ts',
    startLine: 1,
    endLine: lines,
    excerpt: Array.from({ length: lines }, () => 'x'.repeat(width)).join('\n'),
  });
  it('accepts a quote up to MAX_EVIDENCE_LINES lines and refuses a longer one', () => {
    expect(MAX_EVIDENCE_LINES).toBe(40);
    expect(evidenceSchema.safeParse(evidence(MAX_EVIDENCE_LINES)).success).toBe(true);
    expect(evidenceSchema.safeParse(evidence(MAX_EVIDENCE_LINES + 1)).success).toBe(false);
  });
  it('accepts 4,000 excerpt characters so 40 real source lines fit', () => {
    expect(evidenceSchema.safeParse(evidence(40, 99)).success).toBe(true);
    expect(evidenceSchema.safeParse(evidence(40, 100)).success).toBe(false);
  });
});

describe('claude-code provider settings', () => {
  it('accepts provider claude-code with only an id', () => {
    expect(parse('claude-code').model.provider).toBe('claude-code');
  });

  it.each([
    ['inputUsdPerMillion', 1],
    ['outputUsdPerMillion', 1],
    ['maxUsd', 1],
    ['temperature', 0.5],
    ['seed', 1],
  ] as const)('refuses %s for provider claude-code', (field, value) => {
    expect(() =>
      requestSchema.parse({
        schemaVersion: 1,
        repository: 'owner/repo',
        pullNumber: 1,
        baseSha: base,
        mergeBaseSha: base,
        headSha: 'b'.repeat(40),
        mode: 'historical',
        arm: 'A',
        policy: { version: 'test', text: '' },
        model: { provider: 'claude-code', id: 'test-model', [field]: value },
      }),
    ).toThrow('claude-code runs on a subscription: prices, maxUsd, temperature and seed are not accepted');
  });
});

describe('authModeFor / runtimeFor', () => {
  it('maps claude-code to subscription / claude-agent-sdk', () => {
    expect(authModeFor('claude-code')).toBe('subscription');
    expect(runtimeFor('claude-code')).toBe('claude-agent-sdk');
  });
  it('maps any other provider to api-key / ai-sdk-7', () => {
    expect(authModeFor('openai')).toBe('api-key');
    expect(runtimeFor('openai')).toBe('ai-sdk-7');
  });
});
