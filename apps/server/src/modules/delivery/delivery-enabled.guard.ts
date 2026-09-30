import { CanActivate, type ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../database/prisma.service.js';

/**
 * Metadata key + decorator to exempt a route from the delivery-enabled gate. The
 * settings routes (GET/PUT delivery/settings) carry `@SkipDeliveryEnabled()` so an
 * admin can still read the flag and — crucially — turn it back ON while the feature
 * is off. Without the exemption the gate would be a one-way door.
 */
export const SKIP_DELIVERY_ENABLED = 'skipDeliveryEnabled';
export const SkipDeliveryEnabled = () => SetMetadata(SKIP_DELIVERY_ENABLED, true);

/**
 * Per-workspace L4 gate. Appended AFTER Auth/WorkspaceRole/Permissions in the
 * controller chain, so only an already-authenticated, authorized caller reaches it.
 * Reads the single `deliveryEnabled` column: `true` → allow; `false` or a missing
 * workspace → `ForbiddenException` (fail closed — never open the feature for a
 * workspace that isn't there).
 */
@Injectable()
export class DeliveryEnabledGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_DELIVERY_ENABLED, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const request = context.switchToHttp().getRequest<{ params: { workspaceId?: string } }>();
    const workspaceId = request.params?.workspaceId;
    const workspace = workspaceId
      ? await this.prisma.workspace.findUnique({
          where: { id: workspaceId },
          select: { deliveryEnabled: true },
        })
      : null;

    if (workspace?.deliveryEnabled === true) return true;
    throw new ForbiddenException('Delivery intelligence is not enabled for this workspace');
  }
}
