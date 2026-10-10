import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { PushLeaseService } from './push-lease.service.js';

/**
 * Leaf module for the distributed push leases. PushLeaseService only needs
 * PrismaService, so both PushCoreModule and MapperCoreModule import this module
 * directly — keeping the leasing concern out of the push↔mapper dependency
 * edge. Without this, the mapper module had to forwardRef the push module just to
 * reach the lease provider, creating a bidirectional forwardRef cycle with
 * resolution-order failure modes. The dependency is REQUIRED in its
 * consumers: a missing provider fails the bootstrap loudly instead of
 * silently disabling distributed leasing.
 */
@Module({
  imports: [DatabaseModule],
  providers: [PushLeaseService],
  exports: [PushLeaseService],
})
export class LeaseModule {}
