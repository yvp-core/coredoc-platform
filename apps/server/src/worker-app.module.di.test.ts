import { describe, it, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import { WorkerAppModule } from './worker-app.module.js';
import { PrismaService } from './database/prisma.service.js';
import { LicenseService } from './modules/license/license.service.js';

describe('WorkerAppModule DI', () => {
  /**
   * Licensing used to exist only in the API graph, so the worker process — the
   * one that actually imports external data and writes graphs — ran unlicensed.
   * Its presence here is what makes the boot verification and the two claim /
   * enqueue gates reachable in the worker role at all.
   */
  it('compiles and provides LicenseService', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [WorkerAppModule] })
      .overrideProvider(PrismaService)
      .useValue({} as PrismaService)
      .compile();
    expect(moduleRef.get(LicenseService, { strict: false })).toBeInstanceOf(LicenseService);
    await moduleRef.close();
  });
});
