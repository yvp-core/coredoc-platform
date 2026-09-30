// evals/cases-planning/tasks.ts
import type { PlanningTask } from '../harness/planning-types.js';

export function scopedTaskPrompt(task: PlanningTask): string {
  if (!task.repos.length) return task.prompt;
  return `${task.prompt}\n\nScope: this change spans these repositories — investigate EACH one in the codebase before finalizing your spec: ${task.repos.join(', ')}.`;
}

// Example tasks against a fictional "acme" workspace (api-server, web-app,
// billing-service, shared-packages). Point these at your own parsed repos —
// the task shapes (cross-repo contract change, blast radius, single-repo
// feature, read-side aggregation) are what the eval exercises.
export const PLANNING_TASKS: PlanningTask[] = [
  {
    id: 't1-color-propagation',
    title: 'Cross-repo contract change: propagate a new attribute end-to-end',
    repos: ['api-server', 'shared-packages', 'web-app'],
    primaryRepo: 'api-server',
    prompt: `Projects are gaining a new "color" attribute (a hex string). It must propagate
end-to-end so that when api-server syncs a project to the frontend, the color is carried through.
The path today runs from api-server's sync service, through the @acme/api-client SDK, to the
web-app views that render projects.

Produce an implementation spec that lists, for EACH repository involved, every file to create or modify
(with the exact functions/DTOs/entities), plus the data migration. Be specific about the SDK contract
change and how the producing and consuming sides stay in sync.`,
  },
  {
    id: 't2-authz-required-arg',
    title: 'Cross-repo blast radius: new required arg on an authorization SDK method',
    repos: ['api-server', 'shared-packages'],
    primaryRepo: 'api-server',
    prompt: `The api-server service is adding a new REQUIRED argument to its permission-check
method that other services call through the @acme/api-client SDK. Adding a required argument is
a breaking change for every caller.

Produce an implementation spec that (1) identifies every service and call site across the fleet that
invokes this method and must be updated, (2) specifies the change in api-server and the SDK, and
(3) gives a safe rollout order (e.g. optional-arg → migrate callers → make required) so nothing breaks
in production. List affected files per repo.`,
  },
  {
    id: 't3-bulk-delete',
    title: 'Single-repo feature: bulk-delete endpoint mirroring bulk-create',
    repos: ['api-server'],
    primaryRepo: 'api-server',
    prompt: `In the api-server service, add a bulk-delete capability that mirrors the existing bulk-create
endpoint (POST .../items/bulk, handled by ItemsController.createBulk → ItemsService.createBulk).

Produce an implementation spec covering the controller route, service method, request/response DTOs and
validation, and — importantly — the SYMMETRIC domain event: the create path emits a Kafka event, so the
delete path must emit the corresponding delete event. Identify any downstream sync the create path
triggers that the delete path must also mirror. List exact files to create/modify.`,
  },
  {
    id: 't4-summary-field',
    title: 'Management-SDK read-side: new aggregated-summary field',
    repos: ['billing-service', 'api-server', 'web-app'],
    primaryRepo: 'billing-service',
    prompt: `The billing-service composes data from several services via the
@acme/management-api-client SDK. Add a new field to its summary output that requires pulling
additional data from api-server and web-app's backend-for-frontend.

Produce an implementation spec that identifies which SDK calls fetch the needed data (or which new ones
are required), where the aggregation happens, and every file to modify across the involved repos to
surface the new field end-to-end.`,
  },
];
