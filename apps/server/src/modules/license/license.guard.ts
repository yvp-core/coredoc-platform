/**
 * The only globally registered guard in this server (APP_GUARD in
 * api-app.module.ts). It is a no-op in every deployment that has no license
 * file: LicenseService reports `absent` and canActivate returns immediately.
 *
 * Soft degrade, by design: an expired license refuses WRITES on the REST API
 * and nothing else. Reads keep answering, so the graph stays queryable, MCP
 * clients keep working, and operators can still log in and see the license
 * status — expiry must never brick a deployment or take pods out of rotation.
 */

import { CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { API_PREFIX } from '../../libs/api-prefix.js';
import { LicenseService } from './license.service.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Always allowed, whatever the license state: the readiness/liveness probes and
 * the license status route itself must stay reachable so an operator can see
 * WHY writes are failing. Everything in ROOT_ROUTES (OAuth endpoints, MCP
 * transport) is served outside API_PREFIX and is therefore already exempt —
 * see main.ts's setGlobalPrefix exclude list.
 *
 * That exemption covers MCP's one write, `submit_session_feedback`
 * (mcp/tools/feedback.tools.ts), and it stays exempt by decision: it records
 * feedback telemetry ABOUT the tooling (ratings, "this tool was noisy", "this
 * skill was unclear", the user's own review notes), not product data — it
 * imports nothing and grows no graph, and it is precisely the signal worth
 * keeping from a lapsed deployment. Product-data intake is refused
 * elsewhere and unconditionally: pushes here, connector syncs at the delivery
 * cron, and the whole queue at PushWorkerService's claim. Recorded in
 * apps/server/ONPREM.md (license section) and issue
 * .scratch/onprem-distribution/issues/02-server-offline-license.md.
 */
const ALWAYS_ALLOWED = [`${API_PREFIX}/health`, `${API_PREFIX}/license`];

function matchesRoute(path: string, route: string): boolean {
  return path === route || path.startsWith(`${route}/`);
}

/**
 * Pure predicate — exported for tests.
 *
 * The path is lowercased first because Express routing is case-INSENSITIVE by
 * default: `POST /API/v1/workspaces/...` reaches the same handler as the
 * lowercase spelling, so a case-sensitive comparison here would hand an expired
 * deployment a one-keystroke bypass of the whole write gate.
 */
export function isLicenseGatedRequest(method: string, path: string): boolean {
  if (!MUTATING_METHODS.has(method.toUpperCase())) return false;
  const normalized = path.toLowerCase();
  if (!matchesRoute(normalized, API_PREFIX)) return false;
  return !ALWAYS_ALLOWED.some((route) => matchesRoute(normalized, route));
}

@Injectable()
export class LicenseGuard implements CanActivate {
  constructor(private readonly license: LicenseService) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.license.isExpired()) return true;
    // Non-HTTP contexts (none today, but Nest applies global guards to every
    // transport) carry no method/path to gate on — let them through.
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<Request>();
    const path = request.path ?? (request.url ?? '').split('?')[0] ?? '';
    if (!isLicenseGatedRequest(request.method ?? 'GET', path)) return true;
    const status = this.license.getStatus();
    throw new ForbiddenException({
      code: 'LICENSE_EXPIRED',
      message: `Coredoc license expired on ${status.expiresAt} and its grace period has ended. Reads still work; renew the license to restore writes.`,
    });
  }
}
