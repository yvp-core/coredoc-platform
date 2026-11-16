import { HttpStatus, Injectable } from '@nestjs/common';
import {
  DEFAULT_WORKFLOW_SHAPE,
  WORKFLOW_ID_PATTERN,
  type WorkflowShape,
  WorkflowShapeSchema,
} from '@coredoc/core/agent-runner';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service.js';
import { cloudAgentRunError, CloudAgentRunErrorCode } from './run-states.js';

const ADMIN_ROLES = new Set(['admin', 'owner']);

/** Who may start, re-run or continue a workflow's runs: a minimum role, or exactly the named members. */
export const WorkflowAccessSchema = z.record(
  z.string().regex(WORKFLOW_ID_PATTERN),
  z.union([
    z.strictObject({ minRole: z.enum(['member', 'admin']) }),
    z.strictObject({ members: z.array(z.string().min(1).max(256)).min(1).max(200) }),
  ]),
);
export type WorkflowAccess = z.infer<typeof WorkflowAccessSchema>[string];

const ANY_MEMBER: WorkflowAccess = { minRole: 'member' };

export interface WorkflowActor {
  id: string;
  /** Undefined only for callers the role guard does not resolve; they pass no access rule but `member`. */
  role: string | undefined;
}

interface AdvertisedWorkflow {
  shape: WorkflowShape;
  /** Runner tokens last advertised different shapes under this id. */
  conflict: boolean;
}

function accessOf(stored: unknown, workflowId: string): WorkflowAccess {
  const parsed = WorkflowAccessSchema.safeParse(stored);
  return (parsed.success ? parsed.data[workflowId] : undefined) ?? ANY_MEMBER;
}

function allowed(access: WorkflowAccess, actor: WorkflowActor): boolean {
  if ('members' in access) return access.members.includes(actor.id);
  return access.minRole === 'member' || (actor.role !== undefined && ADMIN_ROLES.has(actor.role));
}

@Injectable()
export class CloudAgentRunWorkflows {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * What the workspace's runner tokens last advertised. Not limited to runners seen recently:
   * a deployment that scales its runners to zero still has its workflows. Until a runner has
   * advertised (a new token, or the first claim after the upgrade that added workflows) the
   * workspace has the default workflow, so a run can queue the turn that starts a runner.
   */
  async advertised(workspaceId: string): Promise<AdvertisedWorkflow[]> {
    const rows = await this.prisma.agentRunnerSeen.findMany({
      where: { workspaceId, refusedReason: null },
      orderBy: { lastSeenAt: 'desc' },
      select: { versions: true },
    });
    const byId = new Map<string, AdvertisedWorkflow>();
    for (const row of rows) {
      const manifest = (row.versions as { manifest?: { workflows?: unknown } } | null)?.manifest;
      for (const raw of Array.isArray(manifest?.workflows) ? manifest.workflows : []) {
        const parsed = WorkflowShapeSchema.safeParse(raw);
        if (!parsed.success) continue;
        const known = byId.get(parsed.data.id);
        if (!known) byId.set(parsed.data.id, { shape: parsed.data, conflict: false });
        else if (JSON.stringify(known.shape) !== JSON.stringify(parsed.data)) known.conflict = true;
      }
    }
    if (byId.size === 0) return [{ shape: DEFAULT_WORKFLOW_SHAPE, conflict: false }];
    return [...byId.values()].sort((a, b) => a.shape.id.localeCompare(b.shape.id));
  }

  async list(workspaceId: string, actor: WorkflowActor) {
    const [advertised, settings] = await Promise.all([
      this.advertised(workspaceId),
      this.prisma.agentRunSettings.findUnique({ where: { workspaceId }, select: { workflowAccess: true } }),
    ]);
    return {
      workflows: advertised.map(({ shape, conflict }) => {
        const access = accessOf(settings?.workflowAccess, shape.id);
        const reason = conflict
          ? 'Runners advertise different definitions of this workflow; roll every runner to one image.'
          : allowed(access, actor)
            ? null
            : 'Your workspace access does not allow starting this workflow.';
        return { ...shape, access, startable: reason === null, reason };
      }),
    };
  }

  /** The shape a new run of the workflow starts with; refuses an unknown, conflicting or not-permitted one. */
  async startable(workspaceId: string, workflowId: string, actor: WorkflowActor): Promise<WorkflowShape> {
    const advertised = (await this.advertised(workspaceId)).find(({ shape }) => shape.id === workflowId);
    if (!advertised) {
      throw cloudAgentRunError(
        CloudAgentRunErrorCode.UnknownWorkflow,
        `No runner of this workspace advertises a workflow "${workflowId}"`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (advertised.conflict) {
      throw cloudAgentRunError(
        CloudAgentRunErrorCode.UnknownWorkflow,
        `Runners advertise different definitions of workflow "${workflowId}"; roll every runner to one image`,
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.assertAllowed(workspaceId, workflowId, actor);
    return advertised.shape;
  }

  async assertAllowed(workspaceId: string, workflowId: string, actor: WorkflowActor): Promise<void> {
    const settings = await this.prisma.agentRunSettings.findUnique({
      where: { workspaceId },
      select: { workflowAccess: true },
    });
    if (!allowed(accessOf(settings?.workflowAccess, workflowId), actor)) {
      throw cloudAgentRunError(
        CloudAgentRunErrorCode.WorkflowNotAllowed,
        `Your workspace access does not allow starting workflow "${workflowId}"`,
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /** For runs no person starts: the advertised shape, or null while it is unknown or conflicting. */
  async shape(workspaceId: string, workflowId: string): Promise<WorkflowShape | null> {
    const advertised = (await this.advertised(workspaceId)).find(({ shape }) => shape.id === workflowId);
    return advertised && !advertised.conflict ? advertised.shape : null;
  }
}
