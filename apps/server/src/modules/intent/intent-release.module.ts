/**
 * The release ledger as its own tiny module.
 *
 * `IntentModule` owns the API surface and `DeliveryCoreModule` owns the GitHub
 * connector, and BOTH write release events (RE-03: the connector is an actor).
 * Importing `IntentModule` from delivery would drag seven controllers and the
 * whole propose/review graph into the worker and create an import cycle;
 * exporting the one service from a module that imports nothing but the database
 * is the smallest wiring that keeps a single instance of the write path.
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { IntentReleaseService } from './intent-release.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [IntentReleaseService],
  exports: [IntentReleaseService],
})
export class IntentReleaseModule {}
