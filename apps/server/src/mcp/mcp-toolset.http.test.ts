import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { McpModule as McpNestModule, Tool, ToolGuards } from '@rekog/mcp-nest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

import type { AuthService } from '../auth/auth.service.js';
import type { ControlPlaneService } from '../database/control-plane.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { ROOT_ROUTES } from '../libs/spa-serving.js';
import { IntentEnabledToolGuard } from './intent-enabled.tool-guard.js';
import { MCP_SERVER_OPTIONS } from './mcp.module.js';
import { isMcpRequestPath, McpRewriteMiddleware } from './mcp-rewrite.middleware.js';
import { McpToolset, TOOLSET_TOOLS } from './mcp-toolset.js';
import { SessionFeedbackTools } from './tools/feedback.tools.js';
import { IntentTools } from './tools/intent.tools.js';

const WS = '11111111-1111-1111-1111-111111111111';
const ALL_TOOLS = ['explain', 'intent_read', 'submit_session_feedback'];

const prisma = { workspace: { findUnique: vi.fn() } };

// One stand-in per kind of tool: a graph tool, an intent tool behind the real
// intent guard, and the feedback tool the intent toolset keeps.
@Injectable()
class StubTools {
  @Tool({ name: 'explain', description: 'graph', parameters: z.object({}) })
  explain() {
    return 'graph answer';
  }

  @ToolGuards([IntentEnabledToolGuard])
  @Tool({ name: 'intent_read', description: 'intent', parameters: z.object({}) })
  intentRead() {
    return 'intent answer';
  }

  @Tool({ name: 'submit_session_feedback', description: 'feedback', parameters: z.object({}) })
  feedback() {
    return 'feedback answer';
  }
}

@Module({
  imports: [McpNestModule.forRoot(MCP_SERVER_OPTIONS)],
  providers: [StubTools, IntentEnabledToolGuard, { provide: PrismaService, useValue: prisma }],
})
class StubMcpModule {}

/**
 * The real MCP-Nest transports with the production server options, behind the
 * real McpRewriteMiddleware, arranged as bootstrap arranges them (JSON body
 * parser, then the middleware, then the global prefix with the root routes).
 */
describe('?toolset= on the MCP transports', () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  const clients: Client[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [StubMcpModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    const authService = { verifyAccessToken: vi.fn().mockResolvedValue({ id: 'user_1', email: 'pm@example.com' }) };
    const controlPlane = {
      getMember: vi.fn().mockResolvedValue({ role: 'admin' }),
      listWorkspacesForUser: vi.fn().mockResolvedValue([{ id: WS, slug: 'acme', name: 'Acme', role: 'admin' }]),
    };
    const middleware = new McpRewriteMiddleware(
      authService as unknown as AuthService,
      controlPlane as unknown as ControlPlaneService,
    );
    app.useBodyParser('json');
    app.use((req: Request, res: Response, next: NextFunction) =>
      isMcpRequestPath(req.url) ? middleware.use(req, res, next) : next(),
    );
    app.setGlobalPrefix('/api/v1', { exclude: ROOT_ROUTES });
    await app.listen(0, '127.0.0.1');
    const { port } = (app.getHttpServer() as Server).address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    (app.getHttpServer() as Server).closeAllConnections();
    await app.close();
  });

  beforeEach(() => {
    prisma.workspace.findUnique.mockResolvedValue({ intentEnabled: true });
  });

  async function connect(path: string): Promise<Client> {
    const url = new URL(path, baseUrl);
    const requestInit = { headers: { Authorization: 'Bearer user-token' } };
    // MCP-Nest announces the SSE message endpoint under the global prefix
    // (/api/v1/messages), where no route serves it; post to the root route the
    // transport actually mounts. The toolset must survive that hop, since the
    // message URL carries no toolset of its own.
    const sseFetch: typeof fetch = (input, init) => fetch(String(input).replace('/api/v1/messages', '/messages'), init);
    const transport = url.pathname.endsWith('/sse')
      ? new SSEClientTransport(url, { requestInit, fetch: sseFetch })
      : new StreamableHTTPClientTransport(url, { requestInit });
    const client = new Client({ name: 'toolset-test', version: '0.0.0' });
    await client.connect(transport);
    clients.push(client);
    return client;
  }

  async function listedNames(client: Client): Promise<string[]> {
    return (await client.listTools()).tools.map((tool) => tool.name).sort();
  }

  describe.each([
    { transport: 'Streamable HTTP, workspace path', path: `/api/v1/workspaces/${WS}/mcp` },
    { transport: 'Streamable HTTP, direct path', path: '/mcp' },
    { transport: 'SSE, workspace path', path: `/api/v1/workspaces/${WS}/mcp/sse` },
    { transport: 'SSE, direct path', path: '/sse' },
  ])('$transport', ({ path }) => {
    it('lists and calls every tool without a toolset', async () => {
      const client = await connect(path);

      expect(await listedNames(client)).toEqual(ALL_TOOLS);
      await expect(client.callTool({ name: 'explain', arguments: {} })).resolves.toMatchObject({
        content: [{ type: 'text', text: '"graph answer"' }],
      });
    });

    it('lists and calls only the intent tools with toolset=intent', async () => {
      const client = await connect(`${path}?toolset=intent`);

      expect(await listedNames(client)).toEqual(['intent_read', 'submit_session_feedback']);
      await expect(client.callTool({ name: 'intent_read', arguments: {} })).resolves.toMatchObject({
        content: [{ type: 'text', text: '"intent answer"' }],
      });
      await expect(client.callTool({ name: 'submit_session_feedback', arguments: {} })).resolves.toMatchObject({
        content: [{ type: 'text', text: '"feedback answer"' }],
      });
      await expect(client.callTool({ name: 'explain', arguments: {} })).rejects.toThrow(
        "Tool 'explain' is not in the 'intent' toolset",
      );
    });

    it('still hides and refuses the intent tools when intent is off for the actor', async () => {
      prisma.workspace.findUnique.mockResolvedValue({ intentEnabled: false });
      const client = await connect(`${path}?toolset=intent`);

      expect(await listedNames(client)).toEqual(['submit_session_feedback']);
      await expect(client.callTool({ name: 'intent_read', arguments: {} })).rejects.toThrow(
        "Access denied: insufficient permissions for tool 'intent_read'",
      );
      await expect(client.callTool({ name: 'explain', arguments: {} })).rejects.toThrow("not in the 'intent' toolset");
    });
  });

  it.each([
    `/api/v1/workspaces/${WS}/mcp?toolset=graph`,
    '/mcp?toolset=',
    '/sse?toolset=intent&toolset=intent',
  ])('refuses an invalid toolset with the valid values: %s', async (path) => {
    const response = await fetch(new URL(path, baseUrl), {
      method: path.startsWith('/sse') ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer user-token', 'Content-Type': 'application/json' },
      body: path.startsWith('/sse') ? undefined : '{}',
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; validToolsets: string[] };
    expect(body.error).toMatch(/^Unknown toolset '.*'\. Valid values: intent\./);
    expect(body.validToolsets).toEqual(['intent']);
  });
});

describe('the intent toolset', () => {
  /** `@Tool()` metadata key set by @rekog/mcp-nest, as in tool-classes.test.ts. */
  function toolNames(provider: { prototype: object }): string[] {
    return Object.getOwnPropertyNames(provider.prototype).flatMap((key) => {
      const method = Object.getOwnPropertyDescriptor(provider.prototype, key)?.value;
      const meta = typeof method === 'function' ? Reflect.getMetadata('mcp:tool', method) : undefined;
      return typeof meta?.name === 'string' ? [meta.name as string] : [];
    });
  }

  it('is every intent tool plus the session feedback tool', () => {
    const intentTools = toolNames(IntentTools);
    expect(intentTools).toContain('get_intent_context');
    expect([...TOOLSET_TOOLS[McpToolset.Intent]].sort()).toEqual(
      [...intentTools, ...toolNames(SessionFeedbackTools)].sort(),
    );
  });
});
