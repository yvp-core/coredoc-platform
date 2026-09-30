import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/**
 * `urlPattern` host discriminator for bareCallee (`fetch`) HTTP matchers. Several
 * `fetch` matchers with distinct hosts must NOT collapse to whichever one is listed
 * first — each claims only the calls whose (host-inlined) URL matches its pattern,
 * and a pattern-less matcher is the fallback. Regression for the Turso→github-api
 * mislabel: `fetch(`${this.apiBase}/…`)` where `apiBase = 'https://api.turso.tech/v1'`.
 */
const PROFILE: ExtractionProfile = {
  parserId: 'test-url-pattern',
  substrate: { language: 'ts', include: ['**/*.ts'], exclude: ['**/node_modules/**'] },
  externalCalls: [
    {
      kind: 'http',
      bareCallee: 'fetch',
      urlPattern: '^https://api\\.github\\.com/',
      verbs: ['get', 'post'],
      url: { arg: 0, as: 'string-literal' },
      serviceName: 'github-api',
    },
    {
      kind: 'http',
      bareCallee: 'fetch',
      urlPattern: 'api\\.turso\\.tech',
      verbs: ['get', 'post', 'delete'],
      url: { arg: 0, as: 'string-literal' },
      serviceName: 'turso-api',
    },
    {
      kind: 'http',
      bareCallee: 'fetch',
      verbs: ['get', 'post', 'put', 'delete', 'patch'],
      url: { arg: 0, as: 'string-literal' },
      serviceName: 'http-client',
    },
  ],
};

describe('runProfile — bareCallee urlPattern host discriminator', () => {
  it('attributes an interpolated-host fetch to the matching host, not the first matcher', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-urlpat-'));
    writeFileSync(
      join(dir, 'turso.ts'),
      [
        'export class TursoService {',
        "  private readonly apiBase = 'https://api.turso.tech/v1';",
        '  async createToken(org: string, dbName: string): Promise<unknown> {',
        '    const response = await fetch(`${this.apiBase}/organizations/${org}/databases/${dbName}/auth/tokens`, {',
        "      method: 'POST',",
        '    });',
        '    return response.json();',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    const { repo } = await runProfile(PROFILE, dir, 'svc', 'svc');
    const call = repo.externalCalls.find((e) => e.location.filePath === 'turso.ts');
    expect(call).toBeDefined();
    expect(call?.serviceName).toBe('turso-api');
    expect(call?.targetDescriptor?.http?.pathTemplate).toBe('/organizations/{org}/databases/{dbName}/auth/tokens');
  });

  it('falls through to the pattern-less matcher for a host no pattern claims', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-urlpat-'));
    writeFileSync(
      join(dir, 'other.ts'),
      [
        'export async function ping(): Promise<unknown> {',
        "  const response = await fetch('/internal/health', { method: 'GET' });",
        '  return response.json();',
        '}',
        '',
      ].join('\n'),
    );

    const { repo } = await runProfile(PROFILE, dir, 'svc', 'svc');
    const call = repo.externalCalls.find((e) => e.location.filePath === 'other.ts');
    expect(call?.serviceName).toBe('http-client');
  });

  it('honours an anchored `^https://` pattern against the inlined host (quotes stripped)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-urlpat-'));
    // An anchored pattern only matches the URL VALUE, not the surrounding backticks —
    // so the literal's quotes must be stripped before the pattern is applied.
    const profile: ExtractionProfile = {
      ...PROFILE,
      externalCalls: [
        {
          kind: 'http',
          bareCallee: 'fetch',
          urlPattern: '^https://api\\.turso\\.tech',
          verbs: ['get', 'post'],
          url: { arg: 0, as: 'string-literal' },
          serviceName: 'turso-api',
        },
        {
          kind: 'http',
          bareCallee: 'fetch',
          verbs: ['get', 'post'],
          url: { arg: 0, as: 'string-literal' },
          serviceName: 'http-client',
        },
      ],
    };
    writeFileSync(
      join(dir, 'anchored.ts'),
      [
        'export class TursoService {',
        "  private readonly apiBase = 'https://api.turso.tech/v1';",
        '  async listDbs(org: string): Promise<unknown> {',
        '    const response = await fetch(`${this.apiBase}/organizations/${org}/databases`, {',
        "      method: 'GET',",
        '    });',
        '    return response.json();',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    const { repo } = await runProfile(profile, dir, 'svc', 'svc');
    const call = repo.externalCalls.find((e) => e.location.filePath === 'anchored.ts');
    expect(call?.serviceName).toBe('turso-api');
  });
});
