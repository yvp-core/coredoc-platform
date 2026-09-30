import { describe, it, expect } from 'vitest';
import type { ParsedRepo, EmbeddingsOutput } from '@coredoc/core/types';
import {
  stripSourceCode,
  containsSourceCode,
  stripEmbeddingInputText,
  embeddingsContainInputText,
} from './strip-source.js';

// Minimal fixture shaped like a ParsedRepo slice. The helpers are schema-agnostic
// (recursive walk over any object tree), so we can use a lightweight fixture
// instead of constructing a full ParsedRepo.
function makeParsed(): Record<string, unknown> {
  return {
    id: 'repo-1',
    name: 'example',
    functions: [
      {
        id: 'fn:foo',
        name: 'foo',
        sourceCode: 'function foo() { return 1; }',
        documentation: 'Returns 1.',
      },
      {
        id: 'fn:bar',
        name: 'bar',
        sourceCode: 'function bar() {}',
      },
    ],
    classes: [
      {
        id: 'cls:Svc',
        name: 'Svc',
        sourceCode: 'class Svc {}',
        methods: [{ id: 'm:handle', name: 'handle', sourceCode: 'handle() {}' }],
      },
    ],
    meta: {
      // Intentionally no sourceCode here; verifies walker doesn't false-positive.
      language: 'typescript',
    },
  };
}

describe('stripSourceCode', () => {
  it('removes sourceCode from every node', () => {
    const input = makeParsed();
    const { parsed } = stripSourceCode(input);

    expect(parsed.functions[0].sourceCode).toBeUndefined();
    expect(parsed.functions[1].sourceCode).toBeUndefined();
    expect(parsed.classes[0].sourceCode).toBeUndefined();
    expect(parsed.classes[0].methods[0].sourceCode).toBeUndefined();
    // 'sourceCode' key should be fully deleted, not set to undefined/null/''
    expect('sourceCode' in parsed.functions[0]).toBe(false);
    expect('sourceCode' in parsed.classes[0].methods[0]).toBe(false);
  });

  it('returns the number of stripped fields', () => {
    const { strippedCount } = stripSourceCode(makeParsed());
    // 2 functions + 1 class + 1 method = 4
    expect(strippedCount).toBe(4);
  });

  it('preserves all non-sourceCode fields', () => {
    const { parsed } = stripSourceCode(makeParsed());
    expect(parsed.functions[0].name).toBe('foo');
    expect(parsed.functions[0].documentation).toBe('Returns 1.');
    expect(parsed.classes[0].methods[0].name).toBe('handle');
    expect(parsed.meta.language).toBe('typescript');
  });

  it('does not mutate the input', () => {
    const input = makeParsed();
    stripSourceCode(input);
    expect(input.functions[0].sourceCode).toBe('function foo() { return 1; }');
    expect(input.classes[0].sourceCode).toBe('class Svc {}');
  });

  it('returns strippedCount 0 for a clean input', () => {
    const clean = { id: 'repo', functions: [{ id: 'fn', name: 'foo' }] };
    const { parsed, strippedCount } = stripSourceCode(clean as unknown as ParsedRepo);
    expect(strippedCount).toBe(0);
    expect(parsed).toEqual(clean);
  });

  it('produces JSON with no sourceCode substring', () => {
    const { parsed } = stripSourceCode(makeParsed());
    const json = JSON.stringify(parsed);
    expect(json).not.toContain('sourceCode');
  });

  it('strips the absolute repo root path but keeps per-file/package paths', () => {
    const input = {
      id: 'repo-1',
      name: 'example',
      path: '/Users/alice/dev/example',
      files: [{ id: 'f1', path: 'src/a.ts' }],
      packages: [{ id: 'p1', path: 'packages/api' }],
      functions: [],
    };
    const { parsed } = stripSourceCode(input as unknown as ParsedRepo);

    expect('path' in parsed).toBe(false);
    expect(parsed.files[0]!.path).toBe('src/a.ts');
    expect(parsed.packages[0]!.path).toBe('packages/api');
  });
});

describe('containsSourceCode', () => {
  it('returns true when sourceCode exists at any depth', () => {
    expect(containsSourceCode(makeParsed())).toBe(true);
    expect(containsSourceCode({ a: { b: { sourceCode: 'x' } } })).toBe(true);
    expect(containsSourceCode([{ sourceCode: 'x' }])).toBe(true);
  });

  it('returns true even when sourceCode is an empty string', () => {
    // We treat "key present" as a violation, not "value non-empty".
    expect(containsSourceCode({ sourceCode: '' })).toBe(true);
  });

  it('returns false for clean structures', () => {
    expect(containsSourceCode({ id: 'x', nested: { y: 1 } })).toBe(false);
    expect(containsSourceCode([])).toBe(false);
    expect(containsSourceCode(null)).toBe(false);
    expect(containsSourceCode(undefined)).toBe(false);
    expect(containsSourceCode(42)).toBe(false);
    expect(containsSourceCode('string value')).toBe(false);
  });
});

// Embeddings carry their input text in `inputText`, which holds raw source when
// the run used `-i source|both`. The server never reads `inputText` (the graph
// keeps the vector + checksum + strategy), so it is stripped before any remote
// push — the embeddings equivalent of stripSourceCode for ParsedRepo.
function makeEmbeddings(): EmbeddingsOutput {
  return {
    repoId: 'repo-1',
    repoName: 'example',
    generatedAt: '2026-06-28T00:00:00.000Z',
    provider: 'ollama',
    model: 'nomic-embed-text',
    dimensions: 3,
    inputStrategy: 'source',
    functions: [
      {
        functionId: 'fn:foo',
        versionedId: 'fn:foo@1',
        name: 'foo',
        filePath: 'src/foo.ts',
        inputChecksum: 'abc',
        inputText: 'function foo() { return SECRET_TOKEN; }',
        embedding: [0.1, 0.2, 0.3],
        generatedAt: '2026-06-28T00:00:00.000Z',
      },
    ],
    endpoints: [
      {
        endpointId: 'ep:GET /x',
        versionedId: 'ep:GET /x@1',
        type: 'http',
        path: 'GET /x',
        handlerId: 'fn:foo',
        inputChecksum: 'def',
        inputText: 'GET /x -> function foo() { return SECRET_TOKEN; }',
        embedding: [0.4, 0.5, 0.6],
        generatedAt: '2026-06-28T00:00:00.000Z',
      },
    ],
    stats: {
      totalFunctions: 1,
      totalEndpoints: 1,
      functionsEmbedded: 1,
      endpointsEmbedded: 1,
      functionsSkipped: 0,
      endpointsSkipped: 0,
      failed: 0,
      processingTimeMs: 10,
    },
  };
}

describe('stripEmbeddingInputText', () => {
  it('removes inputText from every function and endpoint embedding', () => {
    const { embeddings } = stripEmbeddingInputText(makeEmbeddings());
    expect('inputText' in embeddings.functions[0]!).toBe(false);
    expect('inputText' in embeddings.endpoints[0]!).toBe(false);
  });

  it('returns the number of stripped inputText fields', () => {
    const { strippedCount } = stripEmbeddingInputText(makeEmbeddings());
    // 1 function + 1 endpoint
    expect(strippedCount).toBe(2);
  });

  it('preserves the embedding vector, checksum, strategy, and other fields', () => {
    const { embeddings } = stripEmbeddingInputText(makeEmbeddings());
    expect(embeddings.functions[0]!.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(embeddings.functions[0]!.inputChecksum).toBe('abc');
    expect(embeddings.functions[0]!.name).toBe('foo');
    expect(embeddings.endpoints[0]!.embedding).toEqual([0.4, 0.5, 0.6]);
    expect(embeddings.inputStrategy).toBe('source');
  });

  it('does not mutate the input', () => {
    const input = makeEmbeddings();
    stripEmbeddingInputText(input);
    expect(input.functions[0]!.inputText).toBe('function foo() { return SECRET_TOKEN; }');
    expect(input.endpoints[0]!.inputText).toContain('SECRET_TOKEN');
  });

  it('produces JSON with no source substring after stripping', () => {
    const { embeddings } = stripEmbeddingInputText(makeEmbeddings());
    expect(JSON.stringify(embeddings)).not.toContain('SECRET_TOKEN');
  });

  it('returns strippedCount 0 when there is nothing left to strip', () => {
    const { embeddings: once } = stripEmbeddingInputText(makeEmbeddings());
    const { strippedCount } = stripEmbeddingInputText(once);
    expect(strippedCount).toBe(0);
  });
});

describe('embeddingsContainInputText', () => {
  it('returns true when any embedding carries a non-empty inputText', () => {
    expect(embeddingsContainInputText(makeEmbeddings())).toBe(true);
  });

  it('returns false once inputText has been stripped', () => {
    const { embeddings } = stripEmbeddingInputText(makeEmbeddings());
    expect(embeddingsContainInputText(embeddings)).toBe(false);
  });

  it('returns false for empty function and endpoint arrays', () => {
    const empty: EmbeddingsOutput = { ...makeEmbeddings(), functions: [], endpoints: [] };
    expect(embeddingsContainInputText(empty)).toBe(false);
  });
});
