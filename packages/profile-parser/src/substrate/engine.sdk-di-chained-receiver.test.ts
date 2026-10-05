/**
 * A `kind: 'sdk'` matcher keyed on `diTypeSuffix` must classify calls made through a
 * MEMBER CHAIN on the injected param (`this.apiClient.schedules.list(…)`), not only
 * direct calls (`this.apiClient.list(…)`). The DI map is keyed by the constructor
 * param name, so the lookup has to use the receiver's root prop.
 *
 * The shape comes from services that wrap a published SDK in a local injectable
 * (`class DayioApiClientService extends DayioApiClient`): the import provenance is a
 * relative path, so `imported-sdk` cannot match and `diTypeSuffix` is the only signal.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParsedRepo } from '@coredoc/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function run(body: string): Promise<ParsedRepo> {
  dir = mkdtempSync(join(tmpdir(), 'pp-sdk-di-chain-'));
  writeFileSync(
    join(dir, 'api-client.service.ts'),
    `export class DemoApiClientService {
  schedules = { listUserProfileShifts(a: string): Promise<unknown> { return Promise.resolve(a); } };
  ping(): Promise<unknown> { return Promise.resolve(); }
}
`,
  );
  writeFileSync(
    join(dir, 'app.ts'),
    `import { DemoApiClientService } from './api-client.service';

export class ValidRangeService {
  constructor(private readonly apiClient: DemoApiClientService) {}

${body}
}
`,
  );
  const profile: ExtractionProfile = {
    parserId: 'test-sdk-di-chain',
    substrate: { language: 'ts', include: ['**/*.ts'], exclude: ['**/node_modules/**'] },
    di: { style: 'constructor-type' },
    externalCalls: [
      { kind: 'sdk', diTypeSuffix: ['ApiClientService'], serviceName: 'internal-api', sdkName: '@demo/api-client' },
    ],
  };
  const { repo } = await runProfile(profile, dir, 'sdk-di-chain-test');
  return repo;
}

describe('sdk matcher — diTypeSuffix on a chained DI receiver', () => {
  it('classifies a call through a member chain on the injected param', async () => {
    const repo = await run(`  async load(): Promise<void> {
    await Promise.all([this.apiClient.schedules.listUserProfileShifts('u')]);
  }`);
    const calls = repo.externalCalls.map((c) => ({ sdkName: c.sdkName, method: c.method }));
    expect(calls).toEqual([{ sdkName: '@demo/api-client', method: 'listUserProfileShifts' }]);
  });

  it('still classifies a direct call on the injected param', async () => {
    const repo = await run(`  async load(): Promise<void> {
    await this.apiClient.ping();
  }`);
    expect(repo.externalCalls.map((c) => c.method)).toEqual(['ping']);
  });
});
