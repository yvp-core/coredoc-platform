import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GithubReadClient, GitSourceReader, compareDistance } from './source.js';
import { changedLines } from './access.js';
import { isSourcePath, requestSchema } from './contracts.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const sha = 'a'.repeat(40);
function request(overrides: Record<string, unknown> = {}) {
  return requestSchema.parse({
    schemaVersion: 1,
    repository: 'owner/repo',
    pullNumber: 1,
    baseSha: sha,
    mergeBaseSha: sha,
    headSha: 'b'.repeat(40),
    mode: 'historical',
    arm: 'A',
    policy: { version: 'test', text: '' },
    model: { provider: 'openai', id: 'test-model' },
    ...overrides,
  });
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'review-source-'));
  roots.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Review test');
  git('config', 'user.email', 'test@example.invalid');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/a.ts'), 'export const divide = (n: number) => n / 2;\n');
  await writeFile(join(root, '.env'), 'TEST_PRIVATE=must-not-be-readable');
  await symlink('/etc/passwd', join(root, 'secret-link'));
  git('add', '.');
  git('commit', '-qm', 'base');
  const baseSha = git('rev-parse', 'HEAD');
  await writeFile(join(root, 'src/a.ts'), 'export const divide = (n: number) => n / 0;\n');
  git('mv', 'src/a.ts', 'src/b.ts');
  git('add', '.');
  git('commit', '-qm', 'head');
  const headSha = git('rev-parse', 'HEAD');
  await writeFile(join(root, 'src/b.ts'), 'uncommitted must never appear');
  return { root, git, baseSha, headSha };
}
describe('pinned source capability', () => {
  it('reads Git blobs at the requested revision rather than the working tree', async () => {
    const f = await fixture();
    const reader = new GitSourceReader(
      f.root,
      request({ baseSha: f.baseSha, mergeBaseSha: f.baseSha, headSha: f.headSha }),
    );
    expect(await reader.read('head', 'src/b.ts')).toContain('n / 0');
    expect(await reader.read('base', 'src/a.ts')).toContain('n / 2');
    const changed = await reader.changes();
    expect(changed.items.some((x) => x.path === 'src/b.ts')).toBe(true);
    expect(changed.gaps).toEqual([]);
  });
  it('refuses traversal, private files, symlinks and uncaptured revisions', async () => {
    const f = await fixture();
    const reader = new GitSourceReader(
      f.root,
      request({ baseSha: f.baseSha, mergeBaseSha: f.baseSha, headSha: f.headSha }),
    );
    for (const path of ['../outside', '/etc/passwd', '.env', 'secret-link', 'src/../../.env']) {
      await expect(reader.read('head', path)).rejects.toThrow();
    }
    expect(isSourcePath('docs/readme.md')).toBe(true);
    expect(isSourcePath('src\\..\\.env')).toBe(false);
  });
  it('uses compare counters with the graph on the right, independently of pagination', () => {
    expect(compareDistance({ status: 'ahead', ahead_by: 3, behind_by: 0, commits: [{}] })).toEqual({
      relation: 'descendant',
      ahead: 3,
      behind: 0,
      source: 'api',
    });
    expect(compareDistance({ status: 'behind', ahead_by: 0, behind_by: 7 })).toMatchObject({
      relation: 'ancestor',
      behind: 7,
    });
    expect(() => compareDistance({ status: 'ahead' })).toThrow();
    expect(() => compareDistance({ status: 'identical', ahead_by: 2, behind_by: 0 })).toThrow();
  });
  it('treats contributor filenames literally, without expanding into excluded siblings', async () => {
    const f = await fixture();
    await writeFile(join(f.root, '*'), 'ordinary tracked source\n');
    await writeFile(join(f.root, '.env'), 'PRIVATE_FIXTURE=not-for-the-model\n');
    await mkdir(join(f.root, 'excluded'));
    await writeFile(join(f.root, 'excluded/labels.txt'), 'HIDDEN_COHORT_LABEL\n');
    f.git('add', '.');
    f.git('commit', '-qm', 'wildcard path');
    const reader = new GitSourceReader(
      f.root,
      request({
        baseSha: f.baseSha,
        mergeBaseSha: f.baseSha,
        headSha: f.git('rev-parse', 'HEAD'),
        exclude: ['excluded'],
      }),
    );
    const result = await reader.changes();
    const patch = result.items.find((item) => item.path === '*')?.patch;
    expect(patch).toContain('ordinary tracked source');
    expect(patch).not.toContain('PRIVATE_FIXTURE');
    expect(patch).not.toContain('HIDDEN_COHORT_LABEL');
    expect(result.items.find((item) => item.path === '.env')?.patch).toBeUndefined();
  });
  it('batches modifications and a rename into one full diff spawn, with correct per-file patches', async () => {
    const f = await fixture();
    // nested/c.ts and nested/e.ts must exist at the merge base (not just added within the diff) for git
    // to detect the rename below, rather than seeing it as an unrelated add/delete pair.
    const filler = Array.from({ length: 20 }, (_, i) => `export const line${i} = ${i};`).join('\n');
    await mkdir(join(f.root, 'src/nested'));
    await writeFile(join(f.root, 'src/nested/c.ts'), `export const c = 1;\n${filler}\n`);
    await writeFile(join(f.root, 'src/nested/e.ts'), 'export const e = 1;\n');
    f.git('add', '.');
    f.git('commit', '-qm', 'add c and e at merge base');
    const mergeBaseSha = f.git('rev-parse', 'HEAD');
    await writeFile(join(f.root, 'src/b.ts'), 'export const divide = (n: number) => n / 3;\n');
    await writeFile(join(f.root, 'src/nested/e.ts'), 'export const e = 2;\n');
    f.git('mv', 'src/nested/c.ts', 'src/nested/d.ts');
    await writeFile(join(f.root, 'src/nested/d.ts'), `export const d = 2;\n${filler}\n`);
    f.git('add', '.');
    f.git('commit', '-qm', 'modify b and e, rename c to d');
    const headSha = f.git('rev-parse', 'HEAD');
    const reader = new GitSourceReader(f.root, request({ baseSha: mergeBaseSha, mergeBaseSha, headSha }));
    const gitSpy = vi.spyOn(GitSourceReader.prototype as never, 'git' as never);
    const changed = await reader.changes();
    // 1 name-status spawn + 1 batched full-diff spawn, regardless of file count.
    expect(gitSpy).toHaveBeenCalledTimes(2);
    gitSpy.mockRestore();
    expect(changed.gaps).toEqual([]);
    const b = changed.items.find((x) => x.path === 'src/b.ts');
    expect(b?.patch).toContain('diff --git a/src/b.ts b/src/b.ts');
    expect(changedLines(b!.patch!, 'head')).toContain(1);
    const e = changed.items.find((x) => x.path === 'src/nested/e.ts');
    expect(e?.patch).toContain('diff --git a/src/nested/e.ts b/src/nested/e.ts');
    expect(changedLines(e!.patch!, 'head')).toContain(1);
    const d = changed.items.find((x) => x.path === 'src/nested/d.ts');
    expect(d?.previousPath).toBe('src/nested/c.ts');
    expect(d?.patch).toContain('rename from src/nested/c.ts');
    expect(d?.patch).toContain('rename to src/nested/d.ts');
    expect(changedLines(d!.patch!, 'head')).toContain(1);
  });
  it('falls back to a per-file diff for a path with a space and non-ASCII character', async () => {
    const f = await fixture();
    const odd = 'src/weird náme.ts';
    await writeFile(join(f.root, odd), 'export const oddOne = 1;\n');
    f.git('add', '.');
    f.git('commit', '-qm', 'odd path');
    const headSha = f.git('rev-parse', 'HEAD');
    const reader = new GitSourceReader(f.root, request({ baseSha: f.baseSha, mergeBaseSha: f.baseSha, headSha }));
    const changed = await reader.changes();
    expect(changed.gaps).toEqual([]);
    const oddFile = changed.items.find((x) => x.path === odd);
    expect(oddFile?.patch).toContain('oddOne');
    expect(changedLines(oddFile!.patch!, 'head')).toContain(1);
  });
  it('gives files past maxFiles no patch and no gap', async () => {
    const f = await fixture();
    await mkdir(join(f.root, 'many'));
    for (let i = 0; i < 3; i++) await writeFile(join(f.root, `many/f${i}.ts`), `export const v${i} = ${i};\n`);
    f.git('add', '.');
    f.git('commit', '-qm', 'many files');
    const headSha = f.git('rev-parse', 'HEAD');
    const reader = new GitSourceReader(
      f.root,
      request({ baseSha: f.baseSha, mergeBaseSha: f.baseSha, headSha, limits: { maxFiles: 2 } }),
    );
    const changed = await reader.changes();
    expect(changed.gaps).toEqual([]);
    const overflow = changed.items.filter((x) => x.path.startsWith('many/'));
    expect(overflow.length).toBe(3);
    expect(overflow.filter((x) => x.patch !== undefined).length).toBe(2);
  });
  it('falls back to complete local history when the compare API fails', async () => {
    const f = await fixture();
    const api = new GithubReadClient(
      'owner/repo',
      '',
      undefined,
      (async () => new Response('', { status: 503 })) as typeof fetch,
    );
    const reader = new GitSourceReader(
      f.root,
      request({ baseSha: f.baseSha, mergeBaseSha: f.baseSha, headSha: f.headSha }),
      api,
    );
    expect(await reader.distance(f.headSha)).toMatchObject({
      source: 'local',
      relation: 'descendant',
      ahead: 1,
      behind: 0,
    });
  });
  it('uses API counts even with depth-one local history; API failure then stays unknown', async () => {
    const f = await fixture();
    const shallow = await mkdtemp(join(tmpdir(), 'review-shallow-'));
    roots.push(shallow);
    execFileSync('git', ['clone', '-q', '--depth=1', `file://${f.root}`, shallow]);
    const req = request({ baseSha: f.baseSha, mergeBaseSha: f.baseSha, headSha: f.headSha });
    let failed = false;
    const api = new GithubReadClient('owner/repo', '', undefined, (async () =>
      failed
        ? new Response('', { status: 503 })
        : new Response(JSON.stringify({ status: 'ahead', ahead_by: 7, behind_by: 0, commits: [{}] }))) as typeof fetch);
    const reader = new GitSourceReader(shallow, req, api);
    expect(await reader.distance(f.headSha)).toMatchObject({ source: 'api', ahead: 7 });
    failed = true;
    expect(await reader.distance(f.headSha)).toMatchObject({ source: 'unknown', relation: 'unknown', ahead: null });
  });
});
