import { ConflictException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service.js';
import { GraphWriteLeaseTimeoutError, PushLeaseService } from './push-lease.service.js';

function makePrismaMock() {
  return {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  };
}

describe('PushLeaseService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: PushLeaseService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new PushLeaseService(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('acquires a repository lease with a fencing generation', async () => {
    prisma.$queryRaw.mockResolvedValue([{ generation: 7n }]);

    await expect(
      service.acquireRepository(
        '11111111-1111-4111-8111-111111111111',
        'gateway',
        '22222222-2222-4222-8222-222222222222',
      ),
    ).resolves.toEqual({ ownerToken: '22222222-2222-4222-8222-222222222222', generation: 7n });

    const sql = (prisma.$queryRaw.mock.calls[0]![0] as TemplateStringsArray).join('');
    expect(sql).toContain('repo_push_leases.expires_at < NOW()');
    expect(sql).toContain('repo_push_leases.generation + 1');
  });

  it('rejects a concurrent repository owner while the lease is live', async () => {
    prisma.$queryRaw.mockResolvedValue([]);

    await expect(
      service.acquireRepository(
        '11111111-1111-4111-8111-111111111111',
        'gateway',
        '22222222-2222-4222-8222-222222222222',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('uses owner token and generation for renew and release fencing', async () => {
    prisma.$executeRaw.mockResolvedValueOnce(1).mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const lease = { ownerToken: '22222222-2222-4222-8222-222222222222', generation: 4n };

    await expect(service.renewRepository('11111111-1111-4111-8111-111111111111', 'gateway', lease)).resolves.toBe(true);
    await expect(service.renewGraphWrite('11111111-1111-4111-8111-111111111111', lease)).resolves.toBe(false);
    await service.releaseRepository('11111111-1111-4111-8111-111111111111', 'gateway', lease);

    for (const call of prisma.$executeRaw.mock.calls) {
      const sql = (call[0] as TemplateStringsArray).join('');
      expect(sql).toContain('owner_token = ');
      expect(sql).toContain('generation = ');
    }
  });

  it('acquires the workspace graph-write lease without polling when it is free', async () => {
    prisma.$queryRaw.mockResolvedValue([{ generation: 3n }]);
    const onWait = vi.fn();

    await expect(
      service.acquireGraphWrite(
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        undefined,
        onWait,
      ),
    ).resolves.toEqual({ ownerToken: '22222222-2222-4222-8222-222222222222', generation: 3n });
    expect(onWait).not.toHaveBeenCalled();
  });

  it('deterministically waits until the current graph writer releases ownership', async () => {
    vi.useFakeTimers();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ generation: 1n }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ generation: 2n }]);
    const first = await service.acquireGraphWrite(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    );
    const onWait = vi.fn();
    const second = service.acquireGraphWrite(
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333',
      undefined,
      onWait,
    );
    await vi.waitFor(() => expect(onWait).toHaveBeenCalledOnce());

    await vi.advanceTimersByTimeAsync(750);

    await expect(second).resolves.toEqual({
      ownerToken: '33333333-3333-4333-8333-333333333333',
      generation: 2n,
    });
    expect(first.generation).toBe(1n);
  });

  it('removes each polling AbortSignal listener after the delay resolves', async () => {
    vi.useFakeTimers();
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ generation: 2n }]);
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');

    const pending = service.acquireGraphWrite(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      controller.signal,
    );
    await vi.waitFor(() => expect(add).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(750);

    await expect(pending).resolves.toEqual({
      ownerToken: '22222222-2222-4222-8222-222222222222',
      generation: 2n,
    });
    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('tolerates transient renewal query failures until half the TTL is exhausted', async () => {
    vi.useFakeTimers();
    const renew = vi.fn().mockRejectedValue(new Error('postgres transient'));
    const abort = vi.fn();
    const renewal = service.startRenewal(renew, abort);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(renew).toHaveBeenCalledTimes(4);
    expect(abort).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(abort).toHaveBeenCalledOnce();
    clearInterval(renewal);
  });

  it('aborts immediately when renewal confirms that ownership was lost', async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    const renewal = service.startRenewal(vi.fn().mockResolvedValue(false), abort);

    await vi.advanceTimersByTimeAsync(15_000);

    expect(abort).toHaveBeenCalledOnce();
    expect(abort.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ message: 'Distributed push lease was lost' }));
    clearInterval(renewal);
  });

  it('raises a named transient error when graph-write waiting exceeds ten minutes', async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(600_001);

    await expect(
      service.acquireGraphWrite('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'),
    ).rejects.toBeInstanceOf(GraphWriteLeaseTimeoutError);
  });
});

describe('PushLeaseService.startRenewal', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeService(): PushLeaseService {
    return new PushLeaseService({} as never);
  }

  it('aborts immediately when renewal confirms the lease is gone (0 rows)', async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    const timer = makeService().startRenewal(async () => false, abort);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(abort).toHaveBeenCalledTimes(1);
    expect((abort.mock.calls[0]![0] as Error).message).toContain('lease was lost');
    clearInterval(timer);
  });

  it('tolerates transient renewal errors until the failure budget, then aborts', async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    const timer = makeService().startRenewal(async () => {
      throw new Error('pg blip');
    }, abort);

    // Two failing ticks (30s) stay within the TTL/2 = 60s budget.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(abort).not.toHaveBeenCalled();

    // Past the budget the next failure aborts.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(abort).toHaveBeenCalled();
    expect((abort.mock.calls[0]![0] as Error).message).toContain('pg blip');
    clearInterval(timer);
  });

  it('a successful renewal resets the transient-failure budget', async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    const results = [true, true, true, true];
    const renew = vi.fn(async () => {
      const next = results.shift();
      if (next === undefined) throw new Error('late blip');
      return next;
    });
    const timer = makeService().startRenewal(renew, abort);

    await vi.advanceTimersByTimeAsync(60_000); // four healthy beats
    await vi.advanceTimersByTimeAsync(30_000); // two failing beats, budget re-anchored at the last success
    expect(abort).not.toHaveBeenCalled();
    clearInterval(timer);
  });

  it('never overlaps a slow in-flight renewal with the next tick', async () => {
    vi.useFakeTimers();
    let inFlight = 0;
    let maxInFlight = 0;
    const renew = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 40_000));
      inFlight -= 1;
      return true;
    });
    const timer = makeService().startRenewal(renew, vi.fn());
    await vi.advanceTimersByTimeAsync(90_000);
    expect(maxInFlight).toBe(1);
    clearInterval(timer);
  });
});
