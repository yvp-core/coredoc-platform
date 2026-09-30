import { Global, Module, type DynamicModule } from '@nestjs/common';
import {
  APP_CONFIG,
  type AppConfig,
  AUTH_CONFIG,
  CONNECTORS_CONFIG,
  loadAppConfig,
  MISC_CONFIG,
  STORAGE_CONFIG,
  TELEMETRY_CONFIG,
  TURSO_CONFIG,
  WORKERS_CONFIG,
} from './app-config.js';
import type { ProcessRole } from '../process-role.js';

/**
 * The boot gate and the injectable value, in one place.
 *
 * `forRole` runs while the app root's `imports` array is being built — before
 * any provider exists — so a bad or missing variable throws during Nest
 * bootstrap and `main.ts` exits non-zero with one line per variable. It is
 * placed after `ConfigModule.forRoot()` in that array so `.env` is already
 * loaded when it reads the environment.
 *
 * Global on purpose: config is ambient to the process, and threading an import
 * through 18 feature modules to hand out one frozen object would be ceremony.
 * Each group also gets its own token so a consumer depends on the slice it uses
 * (`STORAGE_CONFIG`) rather than on everything.
 *
 * Deliberately NOT wired as `ConfigModule.forRoot({ validate })`: @nestjs/config
 * assigns whatever `validate` returns back into `process.env`, which would
 * stringify the grouped objects into the environment.
 */
@Global()
@Module({})
export class AppConfigModule {
  static forRole(role: ProcessRole): DynamicModule {
    const config: AppConfig = loadAppConfig(process.env, role);
    return {
      module: AppConfigModule,
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: STORAGE_CONFIG, useValue: config.storage },
        { provide: AUTH_CONFIG, useValue: config.auth },
        { provide: WORKERS_CONFIG, useValue: config.workers },
        { provide: CONNECTORS_CONFIG, useValue: config.connectors },
        { provide: TELEMETRY_CONFIG, useValue: config.telemetry },
        { provide: TURSO_CONFIG, useValue: config.turso },
        { provide: MISC_CONFIG, useValue: config.misc },
      ],
      exports: [
        APP_CONFIG,
        STORAGE_CONFIG,
        AUTH_CONFIG,
        WORKERS_CONFIG,
        CONNECTORS_CONFIG,
        TELEMETRY_CONFIG,
        TURSO_CONFIG,
        MISC_CONFIG,
      ],
    };
  }
}
