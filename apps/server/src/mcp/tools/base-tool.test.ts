/**
 * Tests for BaseCoredocTool scope/vantage resolution.
 */

import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { Request } from 'express';
import type { ScopeContext } from '@coredoc/mcp';
import { BaseCoredocTool, type ToolContext } from './base-tool.js';
import type { WorkspaceRepo } from '../../database/control-plane.service.js';

function repo(repoName: string, repoKey: string): WorkspaceRepo {
  return { repoName, repoKey } as unknown as WorkspaceRepo;
}

type TestToolContext = Omit<ToolContext, 'repository'>;

class TestTool extends BaseCoredocTool {
  run(args: Record<string, unknown>, request: Request, toolName?: string): Promise<TestToolContext> {
    return this.wsContext.withContext(request, async (context) => {
      const { repository: _repository, ...result } = this.buildToolContext(args, request, context, toolName);
      return result;
    });
  }

  publicResultCountOf(result: unknown): number | null {
    return this.resultCountOf(result);
  }

  publicClassifyListOrMiss(result: unknown): number | null {
    return this.classifyListOrMiss(result);
  }
}

// A list-shaped tool subclass, mirroring the pattern DiscoveryTools/ImpactTools/
// CrossRepoTools use: delegate resultCountOf to the shared classifier.
class ListShapedTestTool extends TestTool {
  protected override resultCountOf(result: unknown): number | null {
    return this.classifyListOrMiss(result);
  }
}

function makeTool(repos: WorkspaceRepo[]) {
  const baseScope: ScopeContext = {
    currentPath: 'workspace://hashcore',
    resolvedRepos: repos.map((r) => r.repoName),
    repoHashes: repos.map((r) => r.repoKey),
    crossRepoEnabled: repos.length > 1,
  };
  const wsContext = {
    withContext: vi
      .fn()
      .mockImplementation(async (_request, callback) =>
        callback({ repository: {}, scope: baseScope, repos, versionId: null }),
      ),
  };
  return new TestTool(wsContext as never, {} as never);
}

const REPOS = [repo('api-server', 'hashcore'), repo('web-app', 'hashshifts')];

const reqWith = (headers: Record<string, string>) => ({ headers }) as unknown as Request;

describe('BaseCoredocTool vantage resolution', () => {
  it('applies the X-Coredoc-Current-Repo header as the vantage when no scope arg is passed', async () => {
    const tool = makeTool(REPOS);

    const ctx = await tool.run({}, reqWith({ 'x-coredoc-current-repo': 'web-app' }));

    expect(ctx.scope.currentRepo).toBe('web-app');
    expect(ctx.scope.currentRepoHash).toBe('hashshifts');
    // Boundary unchanged — vantage is a hint, not a narrowing.
    expect(ctx.scope.resolvedRepos).toEqual(['api-server', 'web-app']);
  });

  it('lets an explicit scope arg override the vantage (header ignored)', async () => {
    const tool = makeTool(REPOS);

    const ctx = await tool.run({ scope: 'api-server' }, reqWith({ 'x-coredoc-current-repo': 'web-app' }));

    // Narrowed to the explicit repo (resolvedRepos = name), no vantage applied.
    expect(ctx.scope.resolvedRepos).toEqual(['api-server']);
    expect(ctx.scope.currentRepo).toBeUndefined();
  });

  it('takes the first value when the header arrives as an array (duplicated header)', async () => {
    const tool = makeTool(REPOS);

    const request = { headers: { 'x-coredoc-current-repo': ['web-app', 'api-server'] } } as unknown as Request;
    const ctx = await tool.run({}, request);

    expect(ctx.scope.currentRepo).toBe('web-app');
  });

  it('leaves the scope untouched when no header is present', async () => {
    const tool = makeTool(REPOS);

    const ctx = await tool.run({}, reqWith({}));

    expect(ctx.scope.currentRepo).toBeUndefined();
  });

  it('ignores a header naming a repo outside the workspace (fail-soft)', async () => {
    const tool = makeTool(REPOS);

    const ctx = await tool.run({}, reqWith({ 'x-coredoc-current-repo': 'not-here' }));

    expect(ctx.scope.currentRepo).toBeUndefined();
  });
});

describe('BaseCoredocTool explicit scope resolution', () => {
  it('rejects a scope arg naming no workspace repo with an error listing the valid names', async () => {
    // An explicit scope is a boundary the caller chose — a miss must be a hard
    // error (fail closed), never a silent fall-back to the whole workspace.
    const tool = makeTool(REPOS);

    await expect(tool.run({ scope: 'not-in-workspace' }, reqWith({}))).rejects.toThrow(
      'Unknown scope "not-in-workspace". Available repos (pass one of these as scope): api-server, web-app',
    );
  });

  it('narrows to a matched scope arg unchanged', async () => {
    const tool = makeTool(REPOS);

    const ctx = await tool.run({ scope: 'web-app' }, reqWith({}));

    expect(ctx.scope.resolvedRepos).toEqual(['web-app']);
    expect(ctx.scope.repoHashes).toEqual(['hashshifts']);
  });
});

describe('BaseCoredocTool detail-level resolution', () => {
  it("resolves explain's omitted detailLevel to basic (compact previews by default)", async () => {
    const tool = makeTool(REPOS);

    const ctx = await tool.run({}, reqWith({}), 'explain');

    expect(ctx.detailLevel).toBe('basic');
    expect(ctx.detailConfig.includeFullDetails).toBe(false);
  });

  it("honors an explicit detailLevel:'full' on explain", async () => {
    const tool = makeTool(REPOS);

    const ctx = await tool.run({ detailLevel: 'full' }, reqWith({}), 'explain');

    expect(ctx.detailLevel).toBe('full');
    expect(ctx.detailConfig.includeFullDetails).toBe(true);
  });

  it('resolves a list-shaped tool to basic, tracking the shared getDefaultDetailLevel set', async () => {
    const tool = makeTool(REPOS);

    const ctx = await tool.run({}, reqWith({}), 'search_symbols');

    expect(ctx.detailLevel).toBe('basic');
    expect(ctx.detailConfig.includeFullDetails).toBe(false);
  });

  it('keeps full as the omitted-param default for a tool outside that set', async () => {
    const tool = makeTool(REPOS);

    const ctx = await tool.run({}, reqWith({}), 'describe_repository');

    expect(ctx.detailLevel).toBe('full');
    expect(ctx.detailConfig.includeFullDetails).toBe(true);
  });
});

describe('BaseCoredocTool resultCountOf classification (C3)', () => {
  function testTool() {
    const wsContext = { withContext: vi.fn() };
    return new TestTool(wsContext as never, {} as never);
  }
  function listTool() {
    const wsContext = { withContext: vi.fn() };
    return new ListShapedTestTool(wsContext as never, {} as never);
  }

  it('base default is null regardless of shape — only overriding tools classify', () => {
    const tool = testTool();
    expect(tool.publicResultCountOf({ data: ['a', 'b', 'c'] })).toBeNull();
    expect(tool.publicResultCountOf({ data: 'x not found in scope' })).toBeNull();
  });

  it('classifyListOrMiss: array data counts its length (list-shaped raw format)', () => {
    const tool = testTool();
    expect(tool.publicClassifyListOrMiss({ data: [1, 2, 3] })).toBe(3);
    expect(tool.publicClassifyListOrMiss({ data: [] })).toBe(0);
  });

  it('classifyListOrMiss: a "<kind> \'<name>\' not found in scope" string classifies as 0', () => {
    const tool = testTool();
    expect(tool.publicClassifyListOrMiss({ data: "Function 'foo' not found in scope" })).toBe(0);
    expect(tool.publicClassifyListOrMiss({ data: "Entity 'Bar' not found in scope" })).toBe(0);
  });

  it('classifyListOrMiss: any other string or object payload stays null (a hit, uncounted)', () => {
    const tool = testTool();
    expect(tool.publicClassifyListOrMiss({ data: '## Symbols matching foo\n- a\n- b' })).toBeNull();
    expect(tool.publicClassifyListOrMiss({ data: { some: 'object' } })).toBeNull();
    expect(tool.publicClassifyListOrMiss({ data: undefined })).toBeNull();
  });

  it('a list-shaped subclass overriding resultCountOf reports the array length', () => {
    const tool = listTool();
    expect(tool.publicResultCountOf({ data: ['a', 'b'] })).toBe(2);
    expect(tool.publicResultCountOf({ data: "Entity 'Bar' not found in scope" })).toBe(0);
  });
});

describe('BaseCoredocTool.executeWithMetrics writer behavior (C3)', () => {
  function makeExecTool(metricsService: { recordMcpQuery: ReturnType<typeof vi.fn> }, events: string[] = []) {
    const baseScope: ScopeContext = {
      currentPath: 'workspace://hashcore',
      resolvedRepos: ['api-server'],
      repoHashes: ['hashcore'],
      crossRepoEnabled: false,
    };
    const wsContext = {
      withContext: vi.fn().mockImplementation(async (_request, callback) => {
        events.push('acquire');
        try {
          return await callback({
            repository: {},
            scope: baseScope,
            repos: [repo('api-server', 'hashcore')],
            versionId: 'v1',
          });
        } finally {
          events.push('release');
        }
      }),
    };
    class ExecTool extends ListShapedTestTool {
      call(args: Record<string, unknown>, request: Request, handler: (ctx: ToolContext) => Promise<{ data: unknown }>) {
        return this.executeWithMetrics('search_symbols', args, request, handler);
      }
    }
    return new ExecTool(wsContext as never, metricsService as never);
  }

  function requestWithWorkspace() {
    return { headers: {}, workspaceId: 'ws-1', user: { id: 'user-1' } } as unknown as Request;
  }

  it('passes the classified resultCount and resolved scope into recordMcpQuery', async () => {
    const recordMcpQuery = vi.fn().mockResolvedValue(undefined);
    const tool = makeExecTool({ recordMcpQuery });

    await tool.call({ scope: 'api-server' }, requestWithWorkspace(), async () => ({ data: ['a', 'b', 'c'] }));

    expect(recordMcpQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        toolName: 'search_symbols',
        resultCount: 3,
        scope: 'api-server',
      }),
    );
  });

  it('preserves raw data and evidence metadata in the cloud transport', async () => {
    const tool = makeExecTool({ recordMcpQuery: vi.fn().mockResolvedValue(undefined) });
    const metadata = {
      staleness: { warning: 'Indexed snapshots', parsedAt: 'unknown' },
      warnings: ['A graph miss does not prove code absence.'],
    };
    const result = await tool.call({ format: 'raw' }, requestWithWorkspace(), async () => ({ data: [], metadata }));
    expect(JSON.parse(result.content[0]!.text)).toEqual([]);
    expect(result.content[1]!.text).toBe(`Evidence metadata: ${JSON.stringify(metadata)}`);
  });

  it('keeps the context lease until the handler settles, then releases it', async () => {
    const events: string[] = [];
    const tool = makeExecTool({ recordMcpQuery: vi.fn().mockResolvedValue(undefined) }, events);

    await tool.call({}, requestWithWorkspace(), async () => {
      events.push('handler');
      expect(events).toEqual(['acquire', 'handler']);
      return { data: 'ok' };
    });

    expect(events).toEqual(['acquire', 'handler', 'release']);
  });

  it('a throwing resultCountOf override never fails the tool call — records null instead', async () => {
    const recordMcpQuery = vi.fn().mockResolvedValue(undefined);
    const tool = makeExecTool({ recordMcpQuery });
    (tool as unknown as { resultCountOf: () => number | null }).resultCountOf = () => {
      throw new Error('classifier exploded on unexpected shape');
    };
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const result = await tool.call({}, requestWithWorkspace(), async () => ({ data: ['a'] }));

    expect(result.content[0].text).toContain('a'); // the call itself succeeded
    expect(recordMcpQuery).toHaveBeenCalledWith(expect.objectContaining({ success: true, resultCount: null }));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('classifier exploded'));
    warnSpy.mockRestore();
  });

  it('logs a warning instead of silently swallowing a metric-write failure', async () => {
    const recordMcpQuery = vi.fn().mockRejectedValue(new Error('write outage'));
    const tool = makeExecTool({ recordMcpQuery });
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await tool.call({}, requestWithWorkspace(), async () => ({ data: [] }));
    // Metric write is fire-and-forget — wait a tick for the rejection to settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('write outage'));
    warnSpy.mockRestore();
  });
});
