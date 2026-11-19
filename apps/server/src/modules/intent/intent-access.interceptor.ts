import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { AuthUser } from '../../auth/decorators/current-user.decorator.js';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import { withWithheldIntentDomains } from './intent-access.js';

/**
 * Runs an intent route with the domains withheld from its caller in scope (see
 * intent-access.ts). Sits after `WorkspaceRoleGuard`, which resolves the role; a
 * request without one is treated as a reader bound to nothing.
 */
@Injectable()
export class IntentAccessInterceptor implements NestInterceptor {
  constructor(private readonly controlPlane: ControlPlaneService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context
      .switchToHttp()
      .getRequest<{ params: { workspaceId?: string }; user?: AuthUser; userWorkspaceRole?: string }>();
    const workspaceId = request.params.workspaceId;
    if (!workspaceId) return next.handle();
    const withheld = await this.controlPlane.withheldIntentDomains(workspaceId, {
      userId: request.user?.id ?? '',
      role: request.userWorkspaceRole ?? '',
    });
    return new Observable((subscriber) =>
      withWithheldIntentDomains(withheld, () => next.handle().subscribe(subscriber)),
    );
  }
}
