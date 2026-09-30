import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LanguageModel } from 'ai';
import type { FunctionNode, ParsedRepo } from '@coredoc/core/types';
import { summarizeFunction, summarizeRepository, summarizePackages } from './ci-summarizer.js';

vi.mock('ai', () => ({
  generateObject: vi.fn(),
}));

// Import after mock so we get the mocked version
import { generateObject } from 'ai';
const mockGenerateObject = vi.mocked(generateObject);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFunctionNode(overrides: Partial<FunctionNode> = {}): FunctionNode {
  return {
    id: 'abc:fn:src/utils.ts:doStuff',
    versionedId: 'abc:fn:src/utils.ts:doStuff@deadbeef',
    name: 'doStuff',
    kind: 'function',
    fileId: 'abc:file:src/utils.ts',
    isAsync: false,
    isGenerator: false,
    parameters: [],
    location: { filePath: 'src/utils.ts', startLine: 10, endLine: 20 },
    sourceCode: 'function doStuff() { return 42; }',
    ...overrides,
  } as FunctionNode;
}

function makeParsedRepo(overrides: Partial<ParsedRepo> = {}): ParsedRepo {
  return {
    id: 'abc',
    name: 'test-repo',
    path: '/tmp/test-repo',
    type: 'backend',
    parsedAt: '2025-01-01T00:00:00Z',
    parserVersion: '1.0.0',
    parserId: 'test-parser',
    packages: [
      { id: 'abc:pkg:packages/api', name: 'api', path: 'packages/api', type: 'backend', language: 'typescript' },
      { id: 'abc:pkg:packages/lib', name: 'lib', path: 'packages/lib', type: 'library', language: 'typescript' },
    ],
    files: [],
    functions: [],
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
  } as ParsedRepo;
}

const fakeModel = {} as LanguageModel;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ci-summarizer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // summarizeFunction
  // -------------------------------------------------------------------------

  describe('summarizeFunction', () => {
    it('returns FunctionSummary from valid structured response', async () => {
      mockGenerateObject.mockResolvedValueOnce({
        object: {
          detailed_summary: 'Computes the answer to everything',
          purpose: 'Returns 42',
          business_logic: ['Always returns 42'],
          side_effects: [],
          data_handling: 'No data transformation',
          confidence_level: 'high',
          unknowns: [],
        },
      } as any);

      const fn = makeFunctionNode();
      const result = await summarizeFunction(fn, [], fakeModel);

      expect(result.functionId).toBe(fn.id);
      expect(result.versionedId).toBe(fn.versionedId);
      expect(result.detailed_summary).toBe('Computes the answer to everything');
      expect(result.purpose).toBe('Returns 42');
      expect(result.business_logic).toEqual(['Always returns 42']);
      expect(result.side_effects).toEqual([]);
      expect(result.confidence_level).toBe('high');
      expect(result.generatedAt).toBeDefined();
    });

    it('returns fallback summary on LLM failure with confidence_level low and error in unknowns', async () => {
      mockGenerateObject.mockRejectedValueOnce(new Error('LLM service unavailable'));

      const fn = makeFunctionNode({ name: 'failingFn' });
      const result = await summarizeFunction(fn, [], fakeModel);

      expect(result.functionId).toBe(fn.id);
      expect(result.confidence_level).toBe('low');
      expect(result.unknowns).toEqual(expect.arrayContaining([expect.stringContaining('LLM service unavailable')]));
      expect(result.detailed_summary).toContain('failingFn');
    });

    it('parses side effects and filters to direct only', async () => {
      mockGenerateObject.mockResolvedValueOnce({
        object: {
          detailed_summary: 'Logs and saves',
          purpose: 'Persist data',
          business_logic: [],
          side_effects: [
            { type: 'logging', description: 'Logs info', isDirect: true },
            { type: 'database', description: 'Saves record', isDirect: true },
            { type: 'event', description: 'Indirect emission', isDirect: false },
          ],
          data_handling: '',
          confidence_level: 'high',
          unknowns: [],
        },
      } as any);

      const fn = makeFunctionNode();
      const result = await summarizeFunction(fn, [], fakeModel);

      expect(result.side_effects).toHaveLength(2);
      expect(result.side_effects[0].type).toBe('logging');
      expect(result.side_effects[1].type).toBe('database');
    });
  });

  // -------------------------------------------------------------------------
  // summarizeRepository
  // -------------------------------------------------------------------------

  describe('summarizeRepository', () => {
    it('returns RepositorySummary from valid structured response', async () => {
      mockGenerateObject.mockResolvedValueOnce({
        object: {
          overview: 'A backend API service for user management',
          dataModel: 'User is the central entity with Profile and Settings',
          externalIntegrations: ['Redis', 'SendGrid'],
        },
      } as any);

      const repo = makeParsedRepo();
      const result = await summarizeRepository(repo, [], fakeModel);

      expect(result.overview).toBe('A backend API service for user management');
      expect(result.dataModel).toBe('User is the central entity with Profile and Settings');
      expect(result.externalIntegrations).toEqual(['Redis', 'SendGrid']);
      expect(result.generatedAt).toBeDefined();
    });

    it('throws on LLM failure', async () => {
      mockGenerateObject.mockRejectedValueOnce(new Error('API error'));

      const repo = makeParsedRepo();
      await expect(summarizeRepository(repo, [], fakeModel)).rejects.toThrow('API error');
    });
  });

  // -------------------------------------------------------------------------
  // summarizePackages
  // -------------------------------------------------------------------------

  describe('summarizePackages', () => {
    it('returns PackageSummary array from valid structured response', async () => {
      mockGenerateObject.mockResolvedValueOnce({
        object: [
          { packageId: 'abc:pkg:packages/api', purpose: 'REST API for user management' },
          { packageId: 'abc:pkg:packages/lib', purpose: 'Shared utility functions' },
        ],
      } as any);

      const repo = makeParsedRepo();
      const result = await summarizePackages(repo, [], fakeModel);

      expect(result).toHaveLength(2);
      expect(result[0].packageId).toBe('abc:pkg:packages/api');
      expect(result[0].purpose).toBe('REST API for user management');
      expect(result[1].packageId).toBe('abc:pkg:packages/lib');
      expect(result[1].purpose).toBe('Shared utility functions');
      expect(result[0].generatedAt).toBeDefined();
    });

    it('filters out invalid package IDs', async () => {
      mockGenerateObject.mockResolvedValueOnce({
        object: [
          { packageId: 'abc:pkg:packages/api', purpose: 'REST API' },
          { packageId: 'abc:pkg:packages/INVALID', purpose: 'Does not exist' },
        ],
      } as any);

      const repo = makeParsedRepo();
      const result = await summarizePackages(repo, [], fakeModel);

      expect(result).toHaveLength(1);
      expect(result[0].packageId).toBe('abc:pkg:packages/api');
    });

    it('throws on LLM failure', async () => {
      mockGenerateObject.mockRejectedValueOnce(new Error('Rate limited'));

      const repo = makeParsedRepo();
      await expect(summarizePackages(repo, [], fakeModel)).rejects.toThrow('Rate limited');
    });
  });

  // -------------------------------------------------------------------------
  // providerOptions (strictJsonSchema)
  // -------------------------------------------------------------------------

  describe('providerOptions (strictJsonSchema)', () => {
    const validObject = {
      object: {
        detailed_summary: 'x',
        purpose: 'x',
        business_logic: [],
        side_effects: [],
        data_handling: '',
        confidence_level: 'high',
        unknowns: [],
      },
    };

    it('omits providerOptions by default', async () => {
      mockGenerateObject.mockResolvedValueOnce(validObject as any);
      await summarizeFunction(makeFunctionNode(), [], fakeModel);
      const call = mockGenerateObject.mock.calls[0][0] as Record<string, unknown>;
      expect(call.providerOptions).toBeUndefined();
    });

    it('relaxes strict json schema when strictJsonSchema=false (Ollama path)', async () => {
      mockGenerateObject.mockResolvedValueOnce(validObject as any);
      await summarizeFunction(makeFunctionNode(), [], fakeModel, false);
      expect(mockGenerateObject).toHaveBeenCalledWith(
        expect.objectContaining({ providerOptions: { openai: { strictJsonSchema: false } } }),
      );
    });
  });
});
