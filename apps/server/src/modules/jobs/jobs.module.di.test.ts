import { describe, it, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import { JobsModule } from './jobs.module.js';
import { TelemetryModule } from '../telemetry/telemetry.module.js';
import { PrismaService } from '../../database/prisma.service.js';

describe('JobsModule DI', () => {
  it('compiles the real module graph (guards against unresolvable constructor tokens)', async () => {
    // Mirror of delivery.module.di.test: compile the real JobsModule graph so any
    // unresolvable constructor token (JobProcessor/PushWorker/PushService and the whole
    // Push/Mapper/Delivery web JobsModule pulls in) fails loudly here. PrismaService is
    // stubbed (the data plane isn't needed to instantiate). TelemetryModule is imported
    // because PushService depends on TelemetryService, which is provided app-wide by the
    // @Global TelemetryModule (AppModule) — an isolated JobsModule import does not pull it
    // in, so the test supplies the same global module the real app does.
    const moduleRef = await Test.createTestingModule({ imports: [JobsModule, TelemetryModule] })
      .overrideProvider(PrismaService)
      .useValue({} as PrismaService)
      .compile();
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });
});
