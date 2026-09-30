/**
 * Database Module
 *
 * Provides control plane (PostgreSQL) and per-workspace data (Turso/libSQL) services.
 * - ControlPlaneService: workspace metadata, members, repos, invites, service tokens
 * - TursoProvisioningService: creates/deletes per-workspace Turso databases
 * - WorkspaceDbPoolService: manages a pool of libSQL connections per workspace
 */

import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';
import { ControlPlaneService } from './control-plane.service.js';
import { TursoProvisioningService } from './turso-provisioning.service.js';
import { WorkspaceDbPoolService } from './workspace-db-pool.service.js';
import { R2StorageService } from './r2-storage.service.js';
import { WorkspaceFileCacheService } from './workspace-file-cache.service.js';

@Global()
@Module({
  providers: [
    PrismaService,
    ControlPlaneService,
    TursoProvisioningService,
    WorkspaceDbPoolService,
    R2StorageService,
    WorkspaceFileCacheService,
  ],
  exports: [
    PrismaService,
    ControlPlaneService,
    TursoProvisioningService,
    WorkspaceDbPoolService,
    R2StorageService,
    WorkspaceFileCacheService,
  ],
})
export class DatabaseModule {}
