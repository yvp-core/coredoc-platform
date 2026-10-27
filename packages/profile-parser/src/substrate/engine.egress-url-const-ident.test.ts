/**
 * An http egress URL passed as a bare identifier bound to a module-level string const
 * (`const SCHEMAS_PATH = '/v1/schemas'; this.post(SCHEMAS_PATH, …)`) resolves to the
 * const's value. A const that is itself a template of such consts
 * (`` const ITEM_PATH = `${API}/items` ``) folds the same way. A `let`, or a name with
 * no module const behind it, stays unresolved.
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
  dir = mkdtempSync(join(tmpdir(), 'pp-url-const-ident-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  const profile: ExtractionProfile = {
    parserId: 'test-url-const-ident',
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
  const { repo } = await runProfile(profile, dir, 'url-const-ident-test');
  return repo;
}

function routes(repo: ParsedRepo): string[] {
  return repo.externalCalls.map((c) => `${c.location?.filePath}:${c.targetDescriptor?.http?.pathTemplate}`).sort();
}

describe('http egress URL through a bare module const identifier', () => {
  it('folds a literal const and a template of consts; leaves a let unresolved', async () => {
    const repo = await run({
      'widgets.ts': `const SCHEMAS_PATH = '/v1/x';
const API = '/v2/widgets';
const ITEM_PATH = \`\${API}/items\`;
let mutablePath = '/v1/mutable';

export class WidgetsClient {
  get(_p: string): void {}
  post(_p: string, _b?: unknown): void {}
  create(body: unknown): void { this.post(SCHEMAS_PATH, body); }
  items(): void { this.get(ITEM_PATH); }
  other(): void { this.get(mutablePath); }
}
`,
    });
    expect(routes(repo)).toEqual(['widgets.ts:/v1/x', 'widgets.ts:/v2/widgets/items', 'widgets.ts:undefined']);
  });
});
