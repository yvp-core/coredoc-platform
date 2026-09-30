import { describe, it, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import { DeliveryModule } from './delivery.module.js';
import { DeliveryService } from './delivery.service.js';
import { PrismaService } from '../../database/prisma.service.js';

describe('DeliveryModule DI', () => {
  it('compiles the real module graph (guards against unresolvable constructor tokens)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [DeliveryModule] })
      .overrideProvider(PrismaService)
      .useValue({} as PrismaService)
      .compile();
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });

  it('registers the retained connector orchestration service', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [DeliveryModule] })
      .overrideProvider(PrismaService)
      .useValue({} as PrismaService)
      .compile();
    expect(moduleRef.get(DeliveryService)).toBeInstanceOf(DeliveryService);
    await moduleRef.close();
  });
});
