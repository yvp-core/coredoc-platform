import { describe, it, expect, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { MCP_GUARDS_METADATA_KEY, MCP_TOOL_METADATA_KEY } from '@rekog/mcp-nest';
// MCP-Nest's own tools/list + tools/call handler, which turns a guard's `false`
// into "hidden" and "refused". The package does not export it, hence the deep path.
import { McpToolsHandler } from '@rekog/mcp-nest/dist/mcp/services/handlers/mcp-tools.handler.js';
import { ToolAuthorizationService } from '@rekog/mcp-nest/dist/mcp/services/tool-authorization.service.js';
import { IntentEnabledToolGuard } from './intent-enabled.tool-guard.js';
import { McpAuthKind } from './mcp-auth-context.js';
import { IntentTools } from './tools/intent.tools.js';
import type { IntentConfig } from '../config/app-config.js';
import type { PrismaService } from '../database/prisma.service.js';
import { WorkspaceMemberRole } from '../modules/members/dto/workspace-role.enum.js';

function createMockContext(workspaceId?: string, extra: Record<string, unknown> = {}): ExecutionContext {
  const request = { workspaceId, ...extra };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function mockPrisma(workspace: { intentEnabled: boolean } | null) {
  return {
    workspace: {
      findUnique: vi.fn().mockResolvedValue(workspace),
    },
  } as unknown as PrismaService & { workspace: { findUnique: ReturnType<typeof vi.fn> } };
}

describe('IntentEnabledToolGuard', () => {
  it('allows the tool when the workspace has intentEnabled=true (one scoped findUnique)', async () => {
    const prisma = mockPrisma({ intentEnabled: true });
    const guard = new IntentEnabledToolGuard(prisma);

    await expect(guard.canActivate(createMockContext('ws_1'))).resolves.toBe(true);
    expect(prisma.workspace.findUnique).toHaveBeenCalledWith({
      where: { id: 'ws_1' },
      select: { intentEnabled: true },
    });
  });

  it('returns false (never throws) when intentEnabled=false', async () => {
    const guard = new IntentEnabledToolGuard(mockPrisma({ intentEnabled: false }));
    await expect(guard.canActivate(createMockContext('ws_1'))).resolves.toBe(false);
  });

  it('returns false when the workspace is missing (findUnique → null) — fail closed', async () => {
    const guard = new IntentEnabledToolGuard(mockPrisma(null));
    await expect(guard.canActivate(createMockContext('ws_1'))).resolves.toBe(false);
  });

  it('returns false without touching prisma when the request carries no workspaceId', async () => {
    const prisma = mockPrisma({ intentEnabled: true });
    const guard = new IntentEnabledToolGuard(prisma);

    await expect(guard.canActivate(createMockContext())).resolves.toBe(false);
    expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
  });
});

const PRODUCT_FIRST: IntentConfig = {
  rolloutRoles: [WorkspaceMemberRole.Owner, WorkspaceMemberRole.Admin, WorkspaceMemberRole.Product],
};

describe('IntentEnabledToolGuard — temporary INTENT_ROLES rollout', () => {
  it('allows an in-list role on an intent-enabled workspace', async () => {
    const guard = new IntentEnabledToolGuard(mockPrisma({ intentEnabled: true }), PRODUCT_FIRST);
    await expect(
      guard.canActivate(createMockContext('ws_1', { userWorkspaceRole: WorkspaceMemberRole.Product })),
    ).resolves.toBe(true);
  });

  it('returns false for an out-of-list role even though the workspace has intent on', async () => {
    const guard = new IntentEnabledToolGuard(mockPrisma({ intentEnabled: true }), PRODUCT_FIRST);
    await expect(
      guard.canActivate(createMockContext('ws_1', { userWorkspaceRole: WorkspaceMemberRole.Member })),
    ).resolves.toBe(false);
  });

  it("keeps today's behaviour when INTENT_ROLES is unset", async () => {
    const guard = new IntentEnabledToolGuard(mockPrisma({ intentEnabled: true }), {});
    await expect(
      guard.canActivate(createMockContext('ws_1', { userWorkspaceRole: WorkspaceMemberRole.Member })),
    ).resolves.toBe(true);
  });
});

/** The registry entries MCP-Nest's discovery builds for `IntentTools`, read off the real decorators. */
function intentToolEntries() {
  const proto = IntentTools.prototype as unknown as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto).flatMap((methodName) => {
    const method = proto[methodName];
    if (typeof method !== 'function') return [];
    const metadata = Reflect.getMetadata(MCP_TOOL_METADATA_KEY, method) as { name: string } | undefined;
    if (!metadata) return [];
    const guards = Reflect.getMetadata(MCP_GUARDS_METADATA_KEY, method) as unknown[] | undefined;
    return [{ type: 'tool', metadata: { ...metadata, guards }, providerClass: IntentTools, methodName }];
  });
}

type Handler = (request?: unknown) => Promise<unknown>;

/** MCP-Nest's tools handler over the real intent tools, for one trusted MCP request. */
function mcpSurface(guard: IntentEnabledToolGuard, request: Record<string, unknown>) {
  const tools = intentToolEntries();
  const registry = {
    getTools: () => tools,
    findTool: (_moduleId: string, name: string) => tools.find((tool) => tool.metadata.name === name),
  };
  const moduleRef = { get: () => guard };
  const handler = new McpToolsHandler(
    moduleRef as never,
    registry as never,
    new Reflector(),
    'intent-rollout-test',
    { logging: false } as never,
    new ToolAuthorizationService(),
  );
  // Keyed by the request method literal: MCP-Nest registers with its own (CJS)
  // copy of the SDK's schemas, so the schema objects are not ours to compare.
  const handlers = new Map<string, Handler>();
  const server = {
    setRequestHandler: (schema: { shape: { method: { value: string } } }, fn: Handler) =>
      handlers.set(schema.shape.method.value, fn),
  };
  handler.registerHandlers({ server } as never, { raw: request } as never);
  const route = (method: string): Handler => {
    const fn = handlers.get(method);
    if (!fn) throw new Error(`MCP-Nest registered no ${method} handler`);
    return fn;
  };
  return {
    names: tools.map((tool) => tool.metadata.name),
    list: async () =>
      ((await route('tools/list')()) as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name),
    call: (name: string) => route('tools/call')({ method: 'tools/call', params: { name, arguments: {} } }),
  };
}

/** The trusted context `McpRewriteMiddleware` attaches. */
function trusted(role: WorkspaceMemberRole, authKind: McpAuthKind = McpAuthKind.Jwt): Record<string, unknown> {
  return {
    workspaceId: 'ws_1',
    user: { id: 'user_1', email: 'user@example.com' },
    userWorkspaceRole: role,
    mcpAuthKind: authKind,
    ...(authKind === McpAuthKind.ServiceToken ? { serviceTokenPermissions: ['intent:read', 'intent:propose'] } : {}),
  };
}

describe('intent MCP tools under INTENT_ROLES — tools/list and tools/call through MCP-Nest', () => {
  it('finds every intent tool, each carrying the guard', () => {
    const entries = intentToolEntries();
    expect(entries.length).toBeGreaterThanOrEqual(9);
    for (const entry of entries) expect(entry.metadata.guards).toContain(IntentEnabledToolGuard);
  });

  it('lists every intent tool for an in-list role', async () => {
    const guard = new IntentEnabledToolGuard(mockPrisma({ intentEnabled: true }), PRODUCT_FIRST);
    const surface = mcpSurface(guard, trusted(WorkspaceMemberRole.Product));
    expect(await surface.list()).toEqual(surface.names);
  });

  it('hides every intent tool from an out-of-list role and refuses each call', async () => {
    const guard = new IntentEnabledToolGuard(mockPrisma({ intentEnabled: true }), PRODUCT_FIRST);
    const surface = mcpSurface(guard, trusted(WorkspaceMemberRole.Member));

    expect(await surface.list()).toEqual([]);
    for (const name of surface.names) {
      // Matched by shape: MCP-Nest throws its own (CJS) copy of the SDK's McpError.
      await expect(surface.call(name)).rejects.toMatchObject({
        code: ErrorCode.InvalidRequest,
        message: expect.stringContaining(`Access denied: insufficient permissions for tool '${name}'`),
      });
    }
  });

  // McpRewriteMiddleware resolves a cdt_ token to its CREATOR's membership role.
  it('hides the tools from a service token whose creator is outside the list', async () => {
    const guard = new IntentEnabledToolGuard(mockPrisma({ intentEnabled: true }), PRODUCT_FIRST);
    const surface = mcpSurface(guard, trusted(WorkspaceMemberRole.Member, McpAuthKind.ServiceToken));
    expect(await surface.list()).toEqual([]);
    await expect(surface.call('intent_read')).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
  });

  it('lists the tools for a service token minted by an in-list admin', async () => {
    const guard = new IntentEnabledToolGuard(mockPrisma({ intentEnabled: true }), PRODUCT_FIRST);
    const surface = mcpSurface(guard, trusted(WorkspaceMemberRole.Admin, McpAuthKind.ServiceToken));
    expect(await surface.list()).toEqual(surface.names);
  });

  it("keeps today's listing for a plain member when INTENT_ROLES is unset", async () => {
    const guard = new IntentEnabledToolGuard(mockPrisma({ intentEnabled: true }), {});
    const surface = mcpSurface(guard, trusted(WorkspaceMemberRole.Member));
    expect(await surface.list()).toEqual(surface.names);
  });
});
