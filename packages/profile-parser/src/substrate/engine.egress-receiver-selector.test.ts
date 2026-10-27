/**
 * An http egress whose target-service token lives in the RECEIVER, not in the call's own
 * arguments: `this.clients.for(env, 'widgets').get('/x')`, or the same chain bound to a
 * local const first. The `receiver-call-arg` selector reads the token from that receiver
 * call and maps it through `serviceMap`; an unmapped token leaves `targetService` unset.
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

async function run(source: string): Promise<ParsedRepo> {
  dir = mkdtempSync(join(tmpdir(), 'pp-receiver-selector-'));
  writeFileSync(join(dir, 'app.ts'), source);
  const profile: ExtractionProfile = {
    parserId: 'test-receiver-selector',
    substrate: { language: 'ts', include: ['**/*.ts'], exclude: ['**/node_modules/**'] },
    externalCalls: [
      {
        kind: 'http',
        // Names only the chain: the bound local matches through its const initializer.
        receiverPattern: '\\.for\\(',
        verbs: ['get'],
        url: { arg: 0, as: 'string-literal' },
        serviceSelector: { via: 'receiver-call-arg', callee: 'for', arg: 1, serviceMap: { widgets: 'widgets-api' } },
        serviceName: 'acme-http',
      },
    ],
  };
  const { repo } = await runProfile(profile, dir, 'receiver-selector-test');
  return repo;
}

describe('receiver-call-arg service selector', () => {
  it('reads the token from the receiver chain and from a local const bound to it', async () => {
    const repo = await run(`interface Http { get(path: string): void }
export class Jobs {
  private clients!: { for(env: string, service: string): Http };

  chained(env: string): void {
    this.clients.for(env, 'widgets').get('/chained');
  }

  bound(env: string): void {
    const client = this.clients.for(env, 'widgets');
    client.get('/bound');
  }

  unmapped(env: string): void {
    this.clients.for(env, 'grants').get('/unmapped');
  }
}
`);
    const byPath = Object.fromEntries(
      repo.externalCalls.map((c) => [c.targetDescriptor?.http?.pathTemplate, c.targetDescriptor?.targetService]),
    );
    expect(byPath).toEqual({ '/chained': 'widgets-api', '/bound': 'widgets-api', '/unmapped': undefined });
  });
});
