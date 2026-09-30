import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentRunsService } from './agent-runs.service.js';
import type { PrismaService } from '../../database/prisma.service.js';
import type { CreateAgentRunInput } from './agent-runs.contract.js';

function dto(over: Partial<CreateAgentRunInput> = {}): CreateAgentRunInput {
  return {
    runId: 'run-1',
    kind: 'author-profile',
    tokensIn: 100,
    tokensOut: 200,
    costUsd: 0.42,
    turns: 3,
    toolCalls: 5,
    interventions: 1,
    outcome: 'success',
    durationMs: 12000,
    ...over,
  };
}

function mockPrisma() {
  const upsert = vi.fn().mockResolvedValue({ id: 'row-1' });
  const aggregate = vi.fn().mockResolvedValue({ _count: { _all: 0 }, _sum: {} });
  const findMany = vi.fn().mockResolvedValue([]);
  return {
    desktopAgentRun: { upsert, aggregate, findMany },
    _upsert: upsert,
    _aggregate: aggregate,
    _findMany: findMany,
  } as unknown as PrismaService & {
    _upsert: ReturnType<typeof vi.fn>;
    _aggregate: ReturnType<typeof vi.fn>;
    _findMany: ReturnType<typeof vi.fn>;
  };
}

describe('AgentRunsService', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let service: AgentRunsService;
  beforeEach(() => {
    prisma = mockPrisma();
    service = new AgentRunsService(prisma as never);
  });

  it('record upserts on the (workspaceId, runId) unique key', async () => {
    await service.record('ws-1', dto(), { userId: 'u1', userEmail: 'u1@acme.com' });
    const call = prisma._upsert.mock.calls[0][0];
    expect(call.where).toEqual({ workspaceId_runId: { workspaceId: 'ws-1', runId: 'run-1' } });
  });

  it('record maps all 8 economics columns plus appVersion/surface', async () => {
    await service.record('ws-1', dto({ appVersion: '1.2.3', surface: 'desktop' }), {
      userId: 'u1',
      userEmail: 'u1@acme.com',
    });
    const call = prisma._upsert.mock.calls[0][0];
    expect(call.create).toMatchObject({
      workspaceId: 'ws-1',
      runId: 'run-1',
      kind: 'author-profile',
      tokensIn: 100,
      tokensOut: 200,
      costUsd: 0.42,
      turns: 3,
      toolCalls: 5,
      interventions: 1,
      outcome: 'success',
      durationMs: 12000,
      appVersion: '1.2.3',
      surface: 'desktop',
    });
  });

  it('record uses server-derived identity, never a payload user field', async () => {
    // The dto carries no user field (stripped by the DTO whitelist); identity is
    // supplied separately by the controller from the authenticated principal.
    await service.record('ws-1', dto(), { userId: 'u1', userEmail: 'u1@acme.com' });
    const call = prisma._upsert.mock.calls[0][0];
    expect(call.create.userId).toBe('u1');
    expect(call.create.userEmail).toBe('u1@acme.com');
  });

  it('record is idempotent — create and update carry the same economics (retry-safe)', async () => {
    await service.record('ws-1', dto(), { userId: 'u1', userEmail: 'u1@acme.com' });
    const call = prisma._upsert.mock.calls[0][0];
    const { workspaceId: _w, runId: _r, ...createData } = call.create;
    expect(call.update).toEqual(createData);
  });

  it('record coalesces absent optional fields to null', async () => {
    await service.record('ws-1', dto(), { userId: undefined, userEmail: undefined });
    const call = prisma._upsert.mock.calls[0][0];
    expect(call.create.userId).toBeNull();
    expect(call.create.userEmail).toBeNull();
    expect(call.create.appVersion).toBeNull();
    expect(call.create.surface).toBeNull();
  });

  it('getWorkspaceAgentRuns returns totals from the aggregate and the last 50 runs desc', async () => {
    prisma._aggregate.mockResolvedValue({
      _count: { _all: 7 },
      _sum: { costUsd: 3.5, tokensIn: 1000, tokensOut: 2000, turns: 20, toolCalls: 35, interventions: 4 },
    });
    prisma._findMany.mockResolvedValue([{ id: 'row-1' }, { id: 'row-2' }]);

    const result = await service.getWorkspaceAgentRuns('ws-1');

    expect(result.totals).toEqual({
      runs: 7,
      costUsd: 3.5,
      tokensIn: 1000,
      tokensOut: 2000,
      turns: 20,
      toolCalls: 35,
      interventions: 4,
    });
    expect(result.runs).toHaveLength(2);

    const findManyArgs = prisma._findMany.mock.calls[0][0];
    expect(findManyArgs.where).toEqual({ workspaceId: 'ws-1' });
    expect(findManyArgs.orderBy).toEqual({ createdAt: 'desc' });
    expect(findManyArgs.take).toBe(50);
  });

  it('getWorkspaceAgentRuns coalesces null aggregate sums to 0 on an empty workspace', async () => {
    const result = await service.getWorkspaceAgentRuns('ws-1');
    expect(result.totals).toEqual({
      runs: 0,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      turns: 0,
      toolCalls: 0,
      interventions: 0,
    });
    expect(result.runs).toEqual([]);
  });
});
