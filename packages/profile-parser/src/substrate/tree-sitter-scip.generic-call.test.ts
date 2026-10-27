/**
 * A call with type arguments must reach `callShapes()` exactly like its non-generic form.
 * tree-sitter-typescript parses `await this.post<T>(…)` with the `await` INSIDE the callee
 * (`(await this.post)<T>(…)`), so the site used to read `calleeText: 'await this.post'` with
 * no receiver and no `*.post` / `this.post` pattern matched it.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildBaseline } from '../facts/pipeline.js';
import { TreeSitterScipSubstrate } from './tree-sitter-scip.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function buildSubstrate(source: string): Promise<TreeSitterScipSubstrate> {
  dir = mkdtempSync(join(tmpdir(), 'pp-generic-call-'));
  writeFileSync(join(dir, 'client.ts'), source);
  const baseline = await buildBaseline({ repoRoot: dir, repoName: 'generic-call' }, { runScip: false });
  return TreeSitterScipSubstrate.create(baseline, {
    repoRoot: dir,
    scope: { include: ['**/*.ts'], exclude: ['**/node_modules/**'] },
  });
}

const shape = (s: { calleeText: string; receiver?: string; method?: string; args: { text: string }[] }) => ({
  calleeText: s.calleeText,
  receiver: s.receiver,
  method: s.method,
  args: s.args.map((a) => a.text),
});

describe('callShapes — generic call sites', () => {
  it('an awaited generic member call keeps its receiver and method', async () => {
    const sub = await buildSubstrate(
      [
        "const WIDGETS_PATH = '/v1/widgets';",
        'export class AcmeClient {',
        '  async post<T>(path: string, body: unknown): Promise<T> { return body as T; }',
        '  async createWidget(body: unknown) {',
        '    await this.post<{ id: string }>(WIDGETS_PATH, body);',
        '    await this.post(WIDGETS_PATH, body);',
        '    return this.post<Map<string, number>>(WIDGETS_PATH, body);',
        '  }',
        '}',
      ].join('\n'),
    );

    const posts = sub.callShapes('*.post').map(shape);
    const expected = { calleeText: 'this.post', receiver: 'this', method: 'post', args: ['WIDGETS_PATH', 'body'] };
    expect(posts).toEqual([expected, expected, expected]);
    expect(sub.callShapes('this.post')).toHaveLength(3);
  });

  it('a bare generic call matches its plain name, awaited or not', async () => {
    const sub = await buildSubstrate(
      [
        'declare function fetchJob<T>(id?: string): Promise<T>;',
        'export async function run() {',
        '  fetchJob<number>();',
        "  await fetchJob<string>('j1');",
        '  fetchJob();',
        '}',
      ].join('\n'),
    );

    const calls = sub.callShapes('fetchJob').map(shape);
    expect(calls).toEqual([
      { calleeText: 'fetchJob', receiver: undefined, method: 'fetchJob', args: [] },
      { calleeText: 'fetchJob', receiver: undefined, method: 'fetchJob', args: ["'j1'"] },
      { calleeText: 'fetchJob', receiver: undefined, method: 'fetchJob', args: [] },
    ]);
  });
});
