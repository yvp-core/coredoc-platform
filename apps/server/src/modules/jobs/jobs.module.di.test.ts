import { describe, it, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import { JobsWorkerModule } from './jobs.module.js';
import { TelemetryModule } from '../telemetry/telemetry.module.js';
import { PrismaService } from '../../database/prisma.service.js';

describe('JobsWorkerModule DI', () => {
  it('compiles the real module graph (guards against unresolvable constructor tokens)', async () => {
    // Mirror of delivery.module.di.test: compile the real JobsWorkerModule graph so any
    // unresolvable constructor token (JobProcessor/PushWorker/PushService and the whole
    // Push/Mapper/Delivery web JobsWorkerModule pulls in) fails loudly here. PrismaService is
    // stubbed (the data plane isn't needed to instantiate). TelemetryModule is imported
    // because PushService depends on TelemetryService, which is provided app-wide by the
    // @Global TelemetryModule (AppModule) — an isolated JobsWorkerModule import does not pull it
    // in, so the test supplies the same global module the real app does.
    const moduleRef = await Test.createTestingModule({ imports: [JobsWorkerModule, TelemetryModule] })
      .overrideProvider(PrismaService)
      .useValue({} as PrismaService)
      .compile();
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });
});
