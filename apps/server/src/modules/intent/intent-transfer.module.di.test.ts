/**
 * The import/export WIRING, compiled for real.
 *
 * The PostgreSQL suite builds a bespoke testing module with just the two
 * controllers and their services, so it proves behaviour and nothing about the
 * module graph. This compiles `IntentModule` itself — the only thing that
 * catches a controller registered without its provider, which would look fine
 * everywhere except at boot.
 */
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { PrismaService } from '../../database/prisma.service.js';
import { IntentExportController } from './intent-export.controller.js';
import { IntentExportService } from './intent-export.service.js';
import { IntentImportController } from './intent-import.controller.js';
import { IntentImportService } from './intent-import.service.js';
import { IntentModule } from './intent.module.js';
import { IntentWorkspaceImportService } from './intent-workspace-import.js';

describe('IntentModule DI (import and export)', () => {
  it('compiles the module and resolves both transfer ends of it', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [IntentModule] })
      .overrideProvider(PrismaService)
      .useValue({} as PrismaService)
      .compile();

    expect(moduleRef.get(IntentImportService)).toBeInstanceOf(IntentImportService);
    expect(moduleRef.get(IntentWorkspaceImportService)).toBeInstanceOf(IntentWorkspaceImportService);
    expect(moduleRef.get(IntentImportController)).toBeInstanceOf(IntentImportController);
    expect(moduleRef.get(IntentExportService)).toBeInstanceOf(IntentExportService);
    expect(moduleRef.get(IntentExportController)).toBeInstanceOf(IntentExportController);
    await moduleRef.close();
  });
});
