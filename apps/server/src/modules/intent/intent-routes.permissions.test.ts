/**
 * The guard matrix over EVERY intent REST route (AC-1, AC-2, BR-1).
 *
 * BR-1: any workspace member may perform every intent action in their own
 * session, so no intent route asks for more than `member`. The fence against a
 * machine is not the role — `WorkspaceRoleGuard` reads a service token's
 * CREATOR — but `UserSessionGuard`, so every write carries it except the named
 * machine-admissible routes, each gated by a token permission instead.
 *
 * Read off decorator metadata rather than through HTTP: the rule is guard
 * metadata, and a new route that forgets it must fail here without a fixture.
 */
import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { WORKSPACE_ROLE_KEY } from '../../auth/decorators/workspace-role.decorator.js';
import { PERMISSION_KEY } from '../../auth/decorators/require-permission.decorator.js';
import { TokenPermission } from '../../auth/token-permissions.js';
import { UserSessionGuard } from '../../auth/user-session.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { IntentAnchorController } from './intent-anchor.controller.js';
import { IntentContextController } from './intent-context.controller.js';
import { IntentExportController } from './intent-export.controller.js';
import { IntentImportController } from './intent-import.controller.js';
import { IntentReleaseController } from './intent-release.controller.js';
import { IntentReviewQueueController } from './intent-review-queue.controller.js';
import { IntentReviewController } from './intent-review.controller.js';
import { IntentController } from './intent.controller.js';
import { IntentEnabledGuard } from './intent-enabled.guard.js';

const CONTROLLERS = [
  IntentController,
  IntentReviewController,
  IntentReviewQueueController,
  IntentAnchorController,
  IntentImportController,
  IntentExportController,
  IntentContextController,
  IntentReleaseController,
];

interface Route {
  name: string;
  method: RequestMethod;
  role: unknown;
  session: boolean;
  permission: string[] | undefined;
  /** Class guards then handler guards — the order Nest runs them in. */
  guards: unknown[];
}

function routes(): Route[] {
  return CONTROLLERS.flatMap((controller) =>
    Object.getOwnPropertyNames(controller.prototype)
      .filter((key) => key !== 'constructor')
      .map((key) => ({ key, handler: controller.prototype[key] as unknown }))
      .filter(
        ({ handler }) => typeof handler === 'function' && Reflect.getMetadata(PATH_METADATA, handler) !== undefined,
      )
      .map(({ key, handler }) => {
        const guards = [
          ...((Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[]) ?? []),
          ...((Reflect.getMetadata(GUARDS_METADATA, handler as object) as unknown[]) ?? []),
        ];
        return {
          name: `${controller.name}.${key}`,
          method: Reflect.getMetadata(METHOD_METADATA, handler as object) as RequestMethod,
          role:
            Reflect.getMetadata(WORKSPACE_ROLE_KEY, handler as object) ??
            Reflect.getMetadata(WORKSPACE_ROLE_KEY, controller),
          session: guards.includes(UserSessionGuard),
          permission: Reflect.getMetadata(PERMISSION_KEY, handler as object) as string[] | undefined,
          guards,
        };
      }),
  );
}

/**
 * The writes that admit a machine credential, each by a token permission. A read
 * that happens to be a POST (a batch preview) carries `intent:read` and is not
 * a write at all; the rest are the named machine paths of BR-1.
 */
const MACHINE_ADMISSIBLE: Record<string, TokenPermission> = {
  'IntentReleaseController.record': TokenPermission.IntentRelease,
};

describe('intent REST guard matrix', () => {
  const all = routes();

  it('finds the intent routes', () => {
    expect(all.length).toBeGreaterThan(20);
  });

  it.each(all.map((r) => [r.name, r] as const))('%s asks for no more than a member', (_name, route) => {
    expect(route.role).toBe('member');
  });

  // The intent gate — workspace flag plus the temporary INTENT_ROLES list — reads
  // the role WorkspaceRoleGuard resolved, so it must run on every route, after it.
  it.each(all.map((r) => [r.name, r] as const))('%s is behind IntentEnabledGuard, after the role', (_name, route) => {
    const gate = route.guards.indexOf(IntentEnabledGuard);
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(route.guards.indexOf(WorkspaceRoleGuard));
    expect(route.guards.indexOf(WorkspaceRoleGuard)).toBeGreaterThan(-1);
  });

  const writes = all.filter(
    (r) => r.method !== RequestMethod.GET && !r.permission?.includes(TokenPermission.IntentRead),
  );

  it.each(writes.map((r) => [r.name, r] as const))('%s is fenced from a bare service token', (name, route) => {
    const machine = MACHINE_ADMISSIBLE[name];
    if (machine) {
      expect(route.session).toBe(false);
      expect(route.permission).toEqual([machine]);
    } else {
      expect(route.session).toBe(true);
      expect(route.permission).toBeUndefined();
    }
  });
});
