/**
 * The anchor module's wiring, compiled for real.
 *
 * Two things this catches that nothing else would until boot: an unresolvable
 * constructor token in the anchor graph, and the fact that the exported
 * resolver actually crosses the module boundary into an importing module —
 * `IntentModule`'s propose service depends on exactly that. A module that
 * forgot to `exports:` its provider looks fine until an importer fails to
 * inject it.
 */

import { Test } from '@nestjs/testing';
import { Module } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { PrismaService } from '../../database/prisma.service.js';
import { IntentAnchorTargetService } from './intent-anchor-target.js';
import { IntentAnchorModule } from './intent-anchor.module.js';
import { IntentAnchorService } from './intent-anchor.service.js';

/** Stands in for `IntentModule`: sees the resolver only through `imports:`. */
@Module({ imports: [IntentAnchorModule], providers: [], exports: [] })
class ImportingModule {}

describe('IntentAnchorModule DI', () => {
  it('compiles and exposes the anchor services', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [IntentAnchorModule] })
      .overrideProvider(PrismaService)
      .useValue({} as PrismaService)
      .compile();

    expect(moduleRef.get(IntentAnchorService)).toBeInstanceOf(IntentAnchorService);
    expect(moduleRef.get(IntentAnchorTargetService)).toBeInstanceOf(IntentAnchorTargetService);
    await moduleRef.close();
  });

  it('publishes the target resolver to an importing module', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ImportingModule] })
      .overrideProvider(PrismaService)
      .useValue({} as PrismaService)
      .compile();

    expect(moduleRef.select(ImportingModule).get(IntentAnchorTargetService, { strict: false })).toBeInstanceOf(
      IntentAnchorTargetService,
    );
    await moduleRef.close();
  });
});
