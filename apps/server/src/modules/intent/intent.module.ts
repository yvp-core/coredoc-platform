/**
 * The cloud intent module (spec §7).
 *
 * Two graphs, house style: `IntentModule` is the API surface (controller +
 * services), `IntentWorkerScheduleModule` carries the retention cron and is
 * imported only by the worker app — a scheduled sweep must run once per
 * deployment, not once per API replica.
 *
 * Later issues extend this module rather than adding siblings: anchors (05) and
 * derivation (06) arrive as imported modules, the context read (07) as a third
 * controller over their two services, and import/export (09) as the fourth and
 * fifth. Its MCP tools (08) live under `src/mcp/` with the rest of the tool
 * registry.
 *
 * WHY SO MANY CONTROLLERS UNDER ONE ROUTE PREFIX. They are split by GATE, not
 * by taste. `IntentReviewController` and `IntentImportController` carry
 * `UserSessionGuard` with no token permission at all (spec §5: no machine-only
 * path to an authority change, and import lands accepted items); `IntentExport`,
 * `IntentContext`, and `IntentReviewQueue` are ordinary member reads — the last
 * of those reads the SAME queue the review write decides on, and is split off
 * for exactly that reason. A gate that strict belongs to
 * a class whose every route shares it — mixing them is how one ends up on the
 * wrong route.
 */
import { IntentReleaseController } from './intent-release.controller.js';
import { IntentReleaseModule } from './intent-release.module.js';

import { IntentHandoffModule } from './intent-handoff.module.js';
import { IntentHandoffCron } from './intent-handoff.cron.js';

import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { IntentDerivationModule } from './derivation/intent-derivation.module.js';
import { IntentAnchorModule } from './intent-anchor.module.js';
import { IntentContextController } from './intent-context.controller.js';
import { IntentContextService } from './intent-context.service.js';
import { IntentReadService } from './intent-read.service.js';
import { IntentWorkspaceImportService } from './intent-workspace-import.js';
import { IntentController } from './intent.controller.js';
import { IntentExportController } from './intent-export.controller.js';
import { IntentExportService } from './intent-export.service.js';
import { IntentImportController } from './intent-import.controller.js';
import { IntentImportService } from './intent-import.service.js';
import { IntentItemService } from './intent-item.service.js';
import { IntentProposeService } from './intent-propose.service.js';
import { IntentRetentionCron } from './intent-retention.cron.js';
import { IntentReviewController } from './intent-review.controller.js';
import { IntentReviewQueueController } from './intent-review-queue.controller.js';
import { IntentReviewQueueService } from './intent-review-queue.service.js';
import { IntentReviewService } from './intent-review.service.js';
import { IntentTransitionsService } from './intent-transitions.service.js';
import { IntentTreeService } from './intent-tree.service.js';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    IntentAnchorModule,
    IntentDerivationModule,
    IntentReleaseModule,
    IntentHandoffModule,
  ],
  controllers: [
    IntentController,
    IntentReleaseController,
    IntentReviewController,
    IntentReviewQueueController,
    IntentContextController,
    IntentImportController,
    IntentExportController,
  ],
  providers: [
    IntentTreeService,
    IntentItemService,
    IntentProposeService,
    IntentReviewService,
    IntentReviewQueueService,
    IntentTransitionsService,
    IntentContextService,
    IntentReadService,
    IntentImportService,
    IntentWorkspaceImportService,
    IntentExportService,
  ],
  exports: [
    IntentHandoffModule,
    IntentTreeService,
    // Re-exported so `IntentModule`'s consumers (the MCP tool registry) still see the
    // release service through the module they already import.
    IntentReleaseModule,
    IntentItemService,
    IntentProposeService,
    IntentReviewService,
    IntentReviewQueueService,
    IntentTransitionsService,
    // Exported for the MCP tool surface (issue 08), which serves the same
    // selectors over the same service rather than a second implementation.
    IntentContextService,
    IntentReadService,
  ],
})
export class IntentModule {}

@Module({
  imports: [DatabaseModule, IntentHandoffModule],
  providers: [IntentRetentionCron, IntentHandoffCron],
})
export class IntentWorkerScheduleModule {}
