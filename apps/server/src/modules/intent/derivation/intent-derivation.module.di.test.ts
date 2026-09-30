/**
 * The module is not wired into `AppModule` yet (that lands with the context-read
 * API), so nothing else would notice an unresolvable constructor token until
 * then. Compiling the real graph here keeps that gap from becoming a surprise.
 */

import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { PrismaService } from '../../../database/prisma.service.js';
import { IntentDerivationModule } from './intent-derivation.module.js';
import { IntentDerivationService } from './intent-derivation.service.js';

describe('IntentDerivationModule DI', () => {
  it('compiles standalone and exposes the derivation service', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [IntentDerivationModule] })
      .overrideProvider(PrismaService)
      .useValue({} as PrismaService)
      .compile();

    expect(moduleRef.get(IntentDerivationService)).toBeInstanceOf(IntentDerivationService);
    await moduleRef.close();
  });
});
