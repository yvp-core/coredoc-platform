/**
 * Tests for shared summarizer prompts
 */

import { describe, it, expect } from 'vitest';
import {
  FUNCTION_SUMMARIZER_SYSTEM_PROMPT,
  REPO_SUMMARIZER_SYSTEM_PROMPT,
  PACKAGE_SUMMARIZER_SYSTEM_PROMPT,
  buildFunctionPrompt,
  buildRepoPrompt,
  buildPackagePrompt,
} from './prompts';
import type { FunctionNode, ParsedRepo, SourceLocation } from '@coredoc/core/types';
import type { CalleeSummaryContext } from './types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createFn(overrides: Partial<FunctionNode> = {}): FunctionNode {
  const location: SourceLocation = {
    filePath: 'src/service.ts',
    startLine: 10,
    endLine: 20,
  };

  return {
    id: 'repo1:fn:src/service.ts:doWork',
    versionedId: 'repo1:fn:src/service.ts:doWork@abc123',
    name: 'doWork',
    kind: 'function',
    fileId: 'repo1:file:src/service.ts',
    isAsync: false,
    isGenerator: false,
    parameters: [],
    location,
    sourceCode: 'function doWork() { return 42; }',
    ...overrides,
  };
}

function createMinimalParsedRepo(overrides: Partial<ParsedRepo> = {}): ParsedRepo {
  return {
    id: 'repo1',
    name: 'my-service',
    path: '/path/to/repo',
    type: 'backend',
    parsedAt: '2025-01-01T00:00:00Z',
    parserVersion: '1.0.0',
    parserId: 'parser1',
    packages: [],
    files: [
      {
        id: 'repo1:file:src/index.ts',
        versionedId: 'repo1:file:src/index.ts@abc',
        name: 'index.ts',
        path: 'src/index.ts',
        language: 'typescript',
        packageId: 'repo1:pkg:root',
        location: { filePath: 'src/index.ts', startLine: 1, endLine: 100 },
        linesOfCode: 100,
        imports: [],
        exports: [],
      },
    ],
    functions: [createFn()],
    classes: [],
    interfaces: [],
    typeAliases: [],
    enums: [],
    variables: [],
    entrypoints: [],
    entities: [],
    dbOperations: [],
    calls: [],
    imports: [],
    externalCalls: [],
    ...overrides,
  };
}

function createCalleeSummary(overrides: Partial<CalleeSummaryContext> = {}): CalleeSummaryContext {
  return {
    functionId: 'repo1:fn:src/helper.ts:helperFn',
    functionName: 'helperFn',
    purpose: 'Performs a helper operation',
    side_effects: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// System prompt tests
// ---------------------------------------------------------------------------

describe('System prompts', () => {
  it('FUNCTION_SUMMARIZER_SYSTEM_PROMPT is non-empty and contains key markers', () => {
    expect(FUNCTION_SUMMARIZER_SYSTEM_PROMPT.length).toBeGreaterThan(100);
    expect(FUNCTION_SUMMARIZER_SYSTEM_PROMPT).toContain('CRITICAL RULES');
    expect(FUNCTION_SUMMARIZER_SYSTEM_PROMPT).toContain('OUTPUT FORMAT');
    expect(FUNCTION_SUMMARIZER_SYSTEM_PROMPT).toContain('CONFIDENCE LEVELS');
    expect(FUNCTION_SUMMARIZER_SYSTEM_PROMPT).toContain('SIDE EFFECT TYPES');
  });

  it('REPO_SUMMARIZER_SYSTEM_PROMPT is non-empty and contains key markers', () => {
    expect(REPO_SUMMARIZER_SYSTEM_PROMPT.length).toBeGreaterThan(100);
    expect(REPO_SUMMARIZER_SYSTEM_PROMPT).toContain('OUTPUT FORMAT');
    expect(REPO_SUMMARIZER_SYSTEM_PROMPT).toContain('RULES');
    expect(REPO_SUMMARIZER_SYSTEM_PROMPT).toContain('externalIntegrations');
  });

  it('PACKAGE_SUMMARIZER_SYSTEM_PROMPT is non-empty and contains key markers', () => {
    expect(PACKAGE_SUMMARIZER_SYSTEM_PROMPT.length).toBeGreaterThan(100);
    expect(PACKAGE_SUMMARIZER_SYSTEM_PROMPT).toContain('OUTPUT FORMAT');
    expect(PACKAGE_SUMMARIZER_SYSTEM_PROMPT).toContain('ONE sentence');
    expect(PACKAGE_SUMMARIZER_SYSTEM_PROMPT).toContain('RULES');
  });
});

// ---------------------------------------------------------------------------
// buildFunctionPrompt tests
// ---------------------------------------------------------------------------

describe('buildFunctionPrompt', () => {
  it('includes function name, source code, and file:line', () => {
    const fn = createFn();
    const prompt = buildFunctionPrompt(fn, []);

    expect(prompt).toContain('NAME: doWork');
    expect(prompt).toContain('FILE: src/service.ts:10');
    expect(prompt).toContain('function doWork() { return 42; }');
  });

  it('includes CALLED ITEMS section when callees are provided', () => {
    const fn = createFn();
    const callee = createCalleeSummary({
      functionName: 'saveToDb',
      purpose: 'Saves data to database',
      side_effects: [{ type: 'database', description: 'writes to users table', isDirect: true }],
    });
    const prompt = buildFunctionPrompt(fn, [callee]);

    expect(prompt).toContain('CALLED ITEMS');
    expect(prompt).toContain('saveToDb');
    expect(prompt).toContain('Saves data to database');
    expect(prompt).toContain('writes to users table');
  });

  it('omits CALLED ITEMS section when no callees are provided', () => {
    const fn = createFn();
    const prompt = buildFunctionPrompt(fn, []);

    expect(prompt).not.toContain('CALLED ITEMS');
  });

  it('includes documentation when present', () => {
    const fn = createFn({ documentation: 'This is the JSDoc for doWork' });
    const prompt = buildFunctionPrompt(fn, []);

    expect(prompt).toContain('DOCUMENTATION: This is the JSDoc for doWork');
  });

  it('omits documentation line when not present', () => {
    const fn = createFn({ documentation: undefined });
    const prompt = buildFunctionPrompt(fn, []);

    expect(prompt).not.toContain('DOCUMENTATION:');
  });

  it('handles methods with classId', () => {
    const fn = createFn({
      kind: 'method',
      name: 'execute',
      classId: 'repo1:cls:src/service.ts:MyService',
    });
    const prompt = buildFunctionPrompt(fn, []);

    expect(prompt).toContain('Analyze this method');
    expect(prompt).toContain('(in class MyService)');
  });

  it('labels as function when kind is function', () => {
    const fn = createFn({ kind: 'function' });
    const prompt = buildFunctionPrompt(fn, []);

    expect(prompt).toContain('Analyze this function');
  });

  // Both summarize paths drop source-less functions before this point; a caller that reaches here
  // has a filter bug, and a signature-only prompt would buy a fabricated summary.
  it('throws instead of prompting from a signature when sourceCode is missing or blank', () => {
    expect(() => buildFunctionPrompt(createFn({ sourceCode: undefined }), [])).toThrow('no source code');
    expect(() => buildFunctionPrompt(createFn({ sourceCode: '   ' }), [])).toThrow('no source code');
  });

  it('shows "none identified" when callee has no side effects', () => {
    const fn = createFn();
    const callee = createCalleeSummary({ side_effects: [] });
    const prompt = buildFunctionPrompt(fn, [callee]);

    expect(prompt).toContain('none identified');
  });
});

// ---------------------------------------------------------------------------
// buildRepoPrompt tests
// ---------------------------------------------------------------------------

describe('buildRepoPrompt', () => {
  it('includes repo name and statistics', () => {
    const repo = createMinimalParsedRepo();
    const prompt = buildRepoPrompt(repo, []);

    expect(prompt).toContain('REPOSITORY: my-service');
    expect(prompt).toContain('TYPE: backend');
    expect(prompt).toContain('Files: 1');
    expect(prompt).toContain('Functions/Methods: 1');
  });

  it('includes languages derived from files', () => {
    const repo = createMinimalParsedRepo();
    const prompt = buildRepoPrompt(repo, []);

    expect(prompt).toContain('LANGUAGES: typescript');
  });

  it('shows Unknown when no languages found', () => {
    const repo = createMinimalParsedRepo({
      files: [
        {
          id: 'f1',
          versionedId: 'f1@abc',
          name: 'file',
          path: 'file',
          language: '',
          packageId: 'pkg1',
          location: { filePath: 'file', startLine: 1, endLine: 1 },
          linesOfCode: 1,
          imports: [],
          exports: [],
        },
      ],
    });
    const prompt = buildRepoPrompt(repo, []);

    expect(prompt).toContain('LANGUAGES: Unknown');
  });
});

// ---------------------------------------------------------------------------
// buildPackagePrompt tests
// ---------------------------------------------------------------------------

describe('buildPackagePrompt', () => {
  it('includes repository and package info', () => {
    const repo = createMinimalParsedRepo({
      packages: [
        {
          id: 'repo1:pkg:packages/api',
          name: '@myorg/api',
          path: 'packages/api',
          type: 'backend',
          language: 'typescript',
        },
      ],
    });
    const prompt = buildPackagePrompt(repo, []);

    expect(prompt).toContain('REPOSITORY: my-service');
    expect(prompt).toContain('TOTAL PACKAGES: 1');
    expect(prompt).toContain('--- PACKAGE: @myorg/api ---');
    expect(prompt).toContain('ID: repo1:pkg:packages/api');
    expect(prompt).toContain('Path: packages/api');
    expect(prompt).toContain('Type: backend');
    expect(prompt).toContain('Language: typescript');
  });

  it('shows function count per package', () => {
    const repo = createMinimalParsedRepo({
      packages: [{ id: 'repo1:pkg:root', name: 'root', path: '.', type: 'backend', language: 'typescript' }],
      files: [
        {
          id: 'repo1:file:src/index.ts',
          versionedId: 'repo1:file:src/index.ts@abc',
          name: 'index.ts',
          path: 'src/index.ts',
          language: 'typescript',
          packageId: 'repo1:pkg:root',
          location: { filePath: 'src/index.ts', startLine: 1, endLine: 100 },
          linesOfCode: 100,
          imports: [],
          exports: [],
        },
      ],
      functions: [
        createFn({ id: 'fn1', fileId: 'repo1:file:src/index.ts' }),
        createFn({ id: 'fn2', name: 'doMore', fileId: 'repo1:file:src/index.ts' }),
      ],
    });
    const prompt = buildPackagePrompt(repo, []);

    expect(prompt).toContain('Functions: 2');
  });
});
