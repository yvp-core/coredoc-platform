/**
 * The context read's WIRING, compiled for real.
 *
 * The PostgreSQL suite hands `IntentContextService` its three dependencies by
 * hand, so it proves the behaviour and nothing about the module graph. This
 * compiles `IntentModule` itself, which is what catches the two failures that
 * would otherwise only appear at boot: a constructor token no imported module
 * exports (the derivation service, the control plane), and a controller whose
 * provider is missing from the module it is declared in.
 */
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { PrismaService } from '../../database/prisma.service.js';
import { IntentDerivationService } from './derivation/intent-derivation.service.js';
import { IntentContextController } from './intent-context.controller.js';
import { IntentContextService } from './intent-context.service.js';
import { IntentModule } from './intent.module.js';

describe('IntentModule DI (context read)', () => {
  it('compiles the module and resolves the context read end of it', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [IntentModule] })
      .overrideProvider(PrismaService)
      .useValue({} as PrismaService)
      .compile();

    expect(moduleRef.get(IntentContextService)).toBeInstanceOf(IntentContextService);
    expect(moduleRef.get(IntentContextController)).toBeInstanceOf(IntentContextController);
    // Derivation crosses a module boundary to get here; a missing `exports:`
    // on `IntentDerivationModule` would look fine until this line.
    expect(moduleRef.get(IntentDerivationService, { strict: false })).toBeInstanceOf(IntentDerivationService);
    await moduleRef.close();
  });
});
