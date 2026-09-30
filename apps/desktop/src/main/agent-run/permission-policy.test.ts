import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { evaluateToolUse, type PolicyContext } from './permission-policy';

const REPO = '/work/target-repo';
const PARSER_DIR = '/work/parsers/proj/target-repo';
const KIT = '/app/authoring-kit';
const SCORE_CMD = `"/usr/bin/node" "/app/cli.js" profile score "${PARSER_DIR}/profile.ts" "${REPO}"`;

const ctx: PolicyContext = {
  repoDir: REPO,
  writeDirs: [PARSER_DIR],
  readDirs: [REPO, KIT, PARSER_DIR],
  safeCommandPrefixes: [SCORE_CMD],
};

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

describe('evaluateToolUse — always-allowed tools', () => {
  it('allows TodoWrite / Task / ExitPlanMode regardless of input', () => {
    expect(evaluateToolUse('TodoWrite', { todos: [] }, ctx).action).toBe('allow');
    expect(evaluateToolUse('Task', { prompt: 'scout' }, ctx).action).toBe('allow');
    expect(evaluateToolUse('ExitPlanMode', {}, ctx).action).toBe('allow');
  });
});

describe('evaluateToolUse — reads', () => {
  it('protects a workspace credential file when it overlaps a readable root', () => {
    const protectedCtx = { ...ctx, deniedPaths: [`${REPO}/.env`] };

    expect(evaluateToolUse('Read', { file_path: `${REPO}/.env` }, protectedCtx).action).toBe('deny');
    expect(evaluateToolUse('Grep', { pattern: 'token', path: REPO }, protectedCtx).action).toBe('deny');
    expect(evaluateToolUse('Bash', { command: 'grep -R token .' }, protectedCtx).action).toBe('deny');
    expect(evaluateToolUse('Read', { file_path: `${REPO}/src/app.ts` }, protectedCtx).action).toBe('allow');
  });

  it('allows a read inside the repo', () => {
    expect(evaluateToolUse('Read', { file_path: `${REPO}/src/app.ts` }, ctx).action).toBe('allow');
  });

  it('allows a read inside the authoring kit and parser dir', () => {
    expect(evaluateToolUse('Read', { file_path: `${KIT}/SKILL.md` }, ctx).action).toBe('allow');
    expect(evaluateToolUse('Read', { file_path: `${PARSER_DIR}/profile.ts` }, ctx).action).toBe('allow');
  });

  it('allows a relative read (resolved against the repo cwd)', () => {
    expect(evaluateToolUse('Grep', { pattern: 'foo', path: 'src' }, ctx).action).toBe('allow');
  });

  it('allows a read with no path (cwd-scoped Glob)', () => {
    expect(evaluateToolUse('Glob', { pattern: '**/*.ts' }, ctx).action).toBe('allow');
  });

  it('denies a read outside every readable root with an instructive message', () => {
    const d = evaluateToolUse('Read', { file_path: '/etc/hosts' }, ctx);
    expect(d.action).toBe('deny');
    if (d.action === 'deny') {
      expect(d.message).toContain(REPO);
      expect(d.message).toContain('AskUserQuestion');
    }
  });

  it('denies a traversal escape (../../etc/passwd)', () => {
    const d = evaluateToolUse('Read', { file_path: `${REPO}/../../etc/passwd` }, ctx);
    expect(d.action).toBe('deny');
  });

  it('does not treat a prefix-collision sibling as inside (/work/target-repo-evil)', () => {
    const d = evaluateToolUse('Read', { file_path: '/work/target-repo-evil/secret' }, ctx);
    expect(d.action).toBe('deny');
  });

  it('denies a read through an in-repo symlink to a file outside the readable roots', () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'coredoc-profile-policy-'));
    fixtures.push(fixture);
    const repo = path.join(fixture, 'repo');
    const outside = path.join(fixture, 'workspace.env');
    mkdirSync(repo);
    writeFileSync(outside, 'ANTHROPIC_API_KEY=secret');
    symlinkSync(outside, path.join(repo, 'safe-looking.txt'));
    const symlinkCtx: PolicyContext = {
      repoDir: repo,
      readDirs: [repo],
      writeDirs: [path.join(fixture, 'profiles')],
      safeCommandPrefixes: [],
    };

    expect(evaluateToolUse('Read', { file_path: path.join(repo, 'safe-looking.txt') }, symlinkCtx).action).toBe('deny');
  });
});

describe('evaluateToolUse — writes', () => {
  it('allows a write inside the parser dir', () => {
    expect(evaluateToolUse('Write', { file_path: `${PARSER_DIR}/profile.ts`, content: 'x' }, ctx).action).toBe('allow');
    expect(evaluateToolUse('Write', { file_path: `${PARSER_DIR}/notes/plan.md`, content: 'x' }, ctx).action).toBe(
      'allow',
    );
  });

  it('denies a write into the target repo itself', () => {
    const d = evaluateToolUse('Write', { file_path: `${REPO}/scratch.ts`, content: 'x' }, ctx);
    expect(d.action).toBe('deny');
    if (d.action === 'deny') expect(d.message).toContain(PARSER_DIR);
  });

  it('denies an Edit outside the write scope', () => {
    expect(
      evaluateToolUse('Edit', { file_path: `${KIT}/SKILL.md`, old_string: 'a', new_string: 'b' }, ctx).action,
    ).toBe('deny');
  });
});

describe('evaluateToolUse — bash', () => {
  it('allows only the exact app-owned score command', () => {
    expect(evaluateToolUse('Bash', { command: SCORE_CMD }, ctx).action).toBe('allow');
    expect(evaluateToolUse('Bash', { command: `${SCORE_CMD}; printenv ANTHROPIC_API_KEY` }, ctx).action).toBe('deny');
    expect(
      evaluateToolUse('Bash', { command: 'node -e "console.log(process.env.ANTHROPIC_API_KEY)"' }, ctx).action,
    ).toBe('deny');
    expect(evaluateToolUse('Bash', { command: '' }, ctx).action).toBe('deny');
  });
});

describe('evaluateToolUse — everything else', () => {
  it('denies WebFetch / WebSearch / mcp / unknown tools', () => {
    expect(evaluateToolUse('WebFetch', { url: 'https://x' }, ctx).action).toBe('deny');
    expect(evaluateToolUse('WebSearch', { query: 'x' }, ctx).action).toBe('deny');
    expect(evaluateToolUse('mcp__github__get_pr', {}, ctx).action).toBe('deny');
    expect(evaluateToolUse('SomeFutureTool', {}, ctx).action).toBe('deny');
  });
});
