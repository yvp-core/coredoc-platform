/**
 * An http egress URL written through a member of a FILE-LOCAL const object
 * (`const PATH = { DEPARTMENTS: '/departments' }; this.post(PATH.DEPARTMENTS, …)`)
 * resolves to the member's string value — bare, or as a leading `${PATH.X}`
 * interpolation. Resolution is per file: two files declaring the same `PATH.X` with
 * different values each keep their own route. A member interpolation whose value is
 * not a route (a config host) is left alone, so templateTailRoute still drops it.
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

async function run(files: Record<string, string>): Promise<ParsedRepo> {
  dir = mkdtempSync(join(tmpdir(), 'pp-url-const-member-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  const profile: ExtractionProfile = {
    parserId: 'test-url-const-member',
    substrate: { language: 'ts', include: ['**/*.ts'], exclude: ['**/node_modules/**'] },
    externalCalls: [
      {
        kind: 'http',
        receiver: 'this',
        verbs: ['get', 'post'],
        url: { arg: 0, as: 'string-literal' },
        serviceName: 'api',
      },
    ],
  };
  const { repo } = await runProfile(profile, dir, 'url-const-member-test');
  return repo;
}

function routes(repo: ParsedRepo): string[] {
  return repo.externalCalls.map((c) => `${c.location?.filePath}:${c.targetDescriptor?.http?.pathTemplate}`).sort();
}

const repoFile = (path: string) => `const PATH = { ITEMS: '${path}' };
const CONFIG = { host: 'https://api.example.com' };

export class Repo {
  get(_p: string): void {}
  post(_p: string): void {}
  list(): void { this.get(PATH.ITEMS); }
  one(id: string): void { this.get(\`\${PATH.ITEMS}/\${id}\`); }
  remote(): void { this.post(\`\${CONFIG.host}/v1/things\`); }
}
`;

describe('http egress URL through a file-local const object member', () => {
  it('resolves bare and interpolated members per file; leaves a host member droppable', async () => {
    const repo = await run({ 'a.ts': repoFile('/departments'), 'b.ts': repoFile('/positions') });
    expect(routes(repo)).toEqual([
      'a.ts:/departments',
      'a.ts:/departments/{id}',
      'a.ts:/v1/things',
      'b.ts:/positions',
      'b.ts:/positions/{id}',
      'b.ts:/v1/things',
    ]);
  });
});
