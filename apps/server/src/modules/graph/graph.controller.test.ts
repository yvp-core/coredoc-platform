/**
 * Tests for GraphController — thin route handlers delegating to GraphService.
 * Guard wiring mirrors ReposController/MetricsController (see class-level
 * @UseGuards + method-level @WorkspaceRole/@RequirePermission decorators).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GraphController } from './graph.controller.js';
import { GraphModule } from './graph.module.js';
import type { GraphService } from './graph.service.js';

function makeService() {
  return {
    searchSymbols: vi.fn(),
    overview: vi.fn(),
    serviceDependencies: vi.fn(),
    entrypoints: vi.fn(),
    nodeDetail: vi.fn(),
    neighbors: vi.fn(),
    subgraph: vi.fn(),
    deadCode: vi.fn(),
    crossRepo: vi.fn(),
    capabilities: vi.fn(),
  } as unknown as GraphService;
}

describe('GraphController', () => {
  let service: ReturnType<typeof makeService>;
  let controller: GraphController;

  beforeEach(() => {
    service = makeService();
    controller = new GraphController(service);
  });

  // No user/userId anywhere below: the id rode along purely for the removed
  // `rest:*` metric attribution. REST graph traffic is intentionally
  // unrecorded now (see GraphService), so the controller never passes a user.

  it('search delegates to GraphService.searchSymbols with the raw query params', async () => {
    const expected = [{ id: 'x:function:foo' }];
    (service.searchSymbols as any).mockResolvedValue(expected);

    const result = await controller.search('ws-1', 'foo', 'function', 'api-server', '10');

    expect(service.searchSymbols).toHaveBeenCalledWith('ws-1', {
      q: 'foo',
      types: 'function',
      scopeRepo: 'api-server',
      limit: '10',
    });
    expect(result).toBe(expected);
  });

  it('overview delegates to GraphService.overview', async () => {
    const expected = { repos: [], coverage: [] };
    (service.overview as any).mockResolvedValue(expected);

    const result = await controller.overview('ws-1', 'api-server');

    expect(service.overview).toHaveBeenCalledWith('ws-1', { scopeRepo: 'api-server' });
    expect(result).toBe(expected);
  });

  it('serviceDependencies delegates to GraphService.serviceDependencies', async () => {
    const expected = [{ service: 'order-service' }];
    (service.serviceDependencies as any).mockResolvedValue(expected);

    const result = await controller.serviceDependencies('ws-1', undefined);

    expect(service.serviceDependencies).toHaveBeenCalledWith('ws-1', { scopeRepo: undefined });
    expect(result).toBe(expected);
  });

  it('entrypoints delegates to GraphService.entrypoints with `scopeRepo` (renamed from `repo`)', async () => {
    const expected = [{ id: 'x:entrypoint:1' }];
    (service.entrypoints as any).mockResolvedValue(expected);

    const result = await controller.entrypoints('ws-1', 'api-server', 'http', '50');

    expect(service.entrypoints).toHaveBeenCalledWith('ws-1', {
      scopeRepo: 'api-server',
      protocol: 'http',
      limit: '50',
    });
    expect(result).toBe(expected);
  });

  it('node delegates to GraphService.nodeDetail with the id query param', async () => {
    const expected = { node: { id: 'x:function:f' }, neighborCounts: [] };
    (service.nodeDetail as any).mockResolvedValue(expected);

    const result = await controller.node('ws-1', 'x:function:f');

    expect(service.nodeDetail).toHaveBeenCalledWith('ws-1', 'x:function:f');
    expect(result).toBe(expected);
  });

  it('node passes an empty string when id is absent (service 400s on it)', async () => {
    (service.nodeDetail as any).mockResolvedValue({});
    await controller.node('ws-1', undefined);
    expect(service.nodeDetail).toHaveBeenCalledWith('ws-1', '');
  });

  it('neighbors delegates to GraphService.neighbors with all query params', async () => {
    const expected = { nodes: [], edges: [], truncated: false };
    (service.neighbors as any).mockResolvedValue(expected);

    const result = await controller.neighbors('ws-1', 'x:function:f', 'out', 'CALLS', '50', 'cur1');

    expect(service.neighbors).toHaveBeenCalledWith('ws-1', 'x:function:f', {
      direction: 'out',
      edgeTypes: 'CALLS',
      limit: '50',
      cursor: 'cur1',
    });
    expect(result).toBe(expected);
  });

  it('subgraph delegates to GraphService.subgraph with the id + traverse params', async () => {
    const expected = { nodes: [], edges: [], truncated: false };
    (service.subgraph as any).mockResolvedValue(expected);

    const result = await controller.subgraph('ws-1', 'x:function:f', 'out', 'CALLS', '4', '100');

    expect(service.subgraph).toHaveBeenCalledWith('ws-1', 'x:function:f', {
      direction: 'out',
      edgeTypes: 'CALLS',
      depth: '4',
      limit: '100',
    });
    expect(result).toBe(expected);
  });

  it('deadCode delegates to GraphService.deadCode with the query params', async () => {
    const expected = { nodes: [], truncated: false, lowCoverageRepos: [] };
    (service.deadCode as any).mockResolvedValue(expected);

    const result = await controller.deadCode('ws-1', 'function,class', 'api-server', '50', 'cur1');

    expect(service.deadCode).toHaveBeenCalledWith('ws-1', {
      types: 'function,class',
      scopeRepo: 'api-server',
      limit: '50',
      cursor: 'cur1',
    });
    expect(result).toBe(expected);
  });

  it('crossRepo delegates to GraphService.crossRepo with the query params', async () => {
    const expected = { nodes: [], edges: [], truncated: false };
    (service.crossRepo as any).mockResolvedValue(expected);

    const result = await controller.crossRepo('ws-1', 'api-server', '25');

    expect(service.crossRepo).toHaveBeenCalledWith('ws-1', { scopeRepo: 'api-server', limit: '25' });
    expect(result).toBe(expected);
  });

  it('capabilities delegates to GraphService.capabilities with the workspace id', async () => {
    const expected = { cypher: true, edgesAmong: true };
    (service.capabilities as any).mockResolvedValue(expected);

    const result = await controller.capabilities('ws-1');

    expect(service.capabilities).toHaveBeenCalledWith('ws-1');
    expect(result).toBe(expected);
  });
});

/**
 * Derive the controller's actual route methods from Nest's own route
 * metadata (`PATH_METADATA`, set by `@Get`/`@Post`/etc.) instead of a
 * hand-maintained array. A hardcoded `['search', 'overview', ...]` list is a
 * foot-gun: add a new `@Get` route to GraphController without also
 * remembering to append it to that array, and the guard-coverage test below
 * would keep passing while silently never checking the new, possibly
 * unguarded, route. Reflecting over the prototype means a new route is
 * covered automatically — and if it lacks the metadata, the test fails.
 */
async function getRouteMethodNames(): Promise<string[]> {
  const { PATH_METADATA } = await import('@nestjs/common/constants');
  const proto = GraphController.prototype as unknown as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto).filter((name) => {
    if (name === 'constructor') return false;
    const member = proto[name];
    return typeof member === 'function' && Reflect.getMetadata(PATH_METADATA, member) !== undefined;
  });
}

describe('GraphController guard wiring', () => {
  it('finds all known routes via reflection (sanity check on the derivation itself)', async () => {
    const routes = await getRouteMethodNames();
    expect(routes.sort()).toEqual(
      [
        'capabilities',
        'crossRepo',
        'cypher',
        'deadCode',
        'edgesAmong',
        'entrypoints',
        'neighbors',
        'node',
        'nodes',
        'overview',
        'repos',
        'search',
        'serviceDependencies',
        'subgraph',
      ].sort(),
    );
  });

  it('carries the required permission metadata on every route (service-token gate)', async () => {
    const { Reflector } = await import('@nestjs/core');
    const { PERMISSION_KEY } = await import('../../auth/decorators/require-permission.decorator.js');
    const { TokenPermission } = await import('../../auth/token-permissions.js');
    const reflector = new Reflector();

    const routes = await getRouteMethodNames();
    expect(routes.length).toBeGreaterThan(0);
    for (const method of routes) {
      const permissions = reflector.get(PERMISSION_KEY, (GraphController.prototype as any)[method]);
      expect(permissions).toEqual([TokenPermission.GraphRead]);
    }
  });

  it('carries the member workspace-role metadata on every route', async () => {
    const { Reflector } = await import('@nestjs/core');
    const { WORKSPACE_ROLE_KEY } = await import('../../auth/decorators/workspace-role.decorator.js');
    const reflector = new Reflector();

    const routes = await getRouteMethodNames();
    expect(routes.length).toBeGreaterThan(0);
    for (const method of routes) {
      const role = reflector.get(WORKSPACE_ROLE_KEY, (GraphController.prototype as any)[method]);
      expect(role).toBe('member');
    }
  });

  // Reasoned through, not committed as a test (per the task brief): if a new
  // route method were added to GraphController decorated with `@Get(...)` but
  // WITHOUT `@RequirePermission`/`@WorkspaceRole`, `getRouteMethodNames()`
  // would include it (it carries PATH_METADATA from `@Get`), and the two
  // tests above would then call `reflector.get(...)` for that method and get
  // `undefined` — failing `toEqual([TokenPermission.GraphRead])` /
  // `toBe('member')`. That is the intended failure: an undecorated route now
  // fails the suite instead of silently passing because it was never in a
  // hardcoded list.
});

describe('GraphModule route table', () => {
  it('registers only the graph read controller and no rollback product route', async () => {
    const { MODULE_METADATA, PATH_METADATA } = await import('@nestjs/common/constants');
    const controllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, GraphModule) ?? []) as Array<{
      prototype: Record<string, unknown>;
    }>;
    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, GraphModule) ?? []) as Array<{ name?: string }>;

    expect(controllers).toEqual([GraphController]);
    expect(imports.map((entry) => entry.name)).not.toContain('GraphSnapshotModule');

    const routePaths = controllers.flatMap((controller) =>
      Object.getOwnPropertyNames(controller.prototype)
        .filter((name) => name !== 'constructor')
        .map((name) => Reflect.getMetadata(PATH_METADATA, controller.prototype[name]))
        .filter((path): path is string => typeof path === 'string'),
    );
    expect(routePaths).not.toContain('rollback');
  });
});
