/** A deployment's runner configuration, baked into its runner image; absent keys keep the platform defaults. */
import { z } from 'zod';
import {
  DEFAULT_WORKFLOW_SHAPE,
  DeliveryKind,
  MAX_WORKFLOWS,
  PHASE_EFFORTS,
  type PhaseEffort,
  PHASE_ID_PATTERN,
  PhaseGate,
  RepositoryMode,
  TurnKind,
  WORKFLOW_ID_PATTERN,
  type WorkflowShape,
} from './protocol.js';

/** The plugin the default phase prompts run; a manifest may leave it out only when every phase names an entry skill. */
export const CORE_PLUGIN_NAME = 'coredoc-workflows';

export enum JiraAccess {
  Read = 'read',
}

const model = z.string().trim().min(1).max(100);
const effort = z.enum(PHASE_EFFORTS);
/** `<plugin>:<skill>`; the run-control tools are refused until the session has invoked it. */
const entrySkill = z.string().regex(/^[^:\s]+:[^:\s]+$/);
const plugins = z
  .array(z.strictObject({ path: z.string().startsWith('/') }))
  .min(1)
  .max(10);
const tools = z.strictObject({ jira: z.array(z.enum(JiraAccess)).default([]) }).default({ jira: [] });

const V1PhaseSchema = z.strictObject({
  model: model.optional(),
  effort: effort.optional(),
  entrySkill: entrySkill.optional(),
});

const ManifestV1Schema = z.strictObject({
  version: z.literal(1),
  plugins: plugins.optional(),
  tools,
  phases: z
    .strictObject({ scope: V1PhaseSchema.default({}), implement: V1PhaseSchema.default({}) })
    .default({ scope: {}, implement: {} }),
});

const WorkflowSchema = z.strictObject({
  title: z.string().trim().min(1).max(80),
  repositories: z.enum(RepositoryMode),
  delivery: z.enum(DeliveryKind),
  plugins,
  tools,
  phases: z
    .array(
      z.strictObject({
        id: z.string().regex(PHASE_ID_PATTERN),
        gate: z.enum(PhaseGate),
        model: model.optional(),
        effort: effort.optional(),
        entrySkill,
      }),
    )
    .min(1)
    .max(8),
});

const ManifestV2Schema = z.strictObject({
  version: z.literal(2),
  workflows: z.record(z.string().regex(WORKFLOW_ID_PATTERN), WorkflowSchema),
});

export const AgentRunManifestSchema = z.discriminatedUnion('version', [ManifestV1Schema, ManifestV2Schema]);

export interface WorkflowPhase {
  id: string;
  gate: PhaseGate;
  model?: string;
  effort?: PhaseEffort;
  /** Absent only in the default workflow, whose phases then run the built-in prompts. */
  entrySkill?: string;
}

export interface ResolvedWorkflow {
  id: string;
  title: string;
  repositories: RepositoryMode;
  delivery: DeliveryKind;
  plugins: Array<{ path: string }>;
  tools: { jira: JiraAccess[] };
  phases: WorkflowPhase[];
}

export interface ResolvedManifest {
  workflows: ResolvedWorkflow[];
}

export class ManifestError extends Error {}

type V1Phases = z.infer<typeof ManifestV1Schema>['phases'];

function defaultWorkflow(pluginPaths: Array<{ path: string }>, jira: JiraAccess[], phases: V1Phases): ResolvedWorkflow {
  const [scope, implement] = DEFAULT_WORKFLOW_SHAPE.phases;
  return {
    ...DEFAULT_WORKFLOW_SHAPE,
    plugins: pluginPaths,
    tools: { jira },
    phases: [
      { ...scope!, ...phases.scope },
      { ...implement!, ...phases.implement },
    ],
  };
}

/** What a version 2 workflow must satisfy beyond its shape; each problem names the workflow. */
function workflowProblems(id: string, workflow: z.infer<typeof WorkflowSchema>): string[] {
  const problems: string[] = [];
  const ids = workflow.phases.map((phase) => phase.id);
  if (new Set(ids).size !== ids.length) problems.push(`${id}: phase ids must be unique`);
  if (ids.includes(TurnKind.Delivery)) {
    problems.push(`${id}: "${TurnKind.Delivery}" is reserved and cannot name a phase`);
  }
  workflow.phases.forEach((phase, index) => {
    const last = index === workflow.phases.length - 1;
    if (last && phase.gate !== PhaseGate.None) {
      problems.push(`${id}: the last phase (${phase.id}) must have gate "none"`);
    }
    if (!last && phase.gate !== PhaseGate.Acceptance) {
      problems.push(`${id}: phase ${phase.id} is not the last one, so it must have gate "acceptance"`);
    }
  });
  if (workflow.delivery === DeliveryKind.PullRequest && workflow.repositories !== RepositoryMode.Write) {
    problems.push(`${id}: delivery "pull-request" needs repositories "write"`);
  }
  return problems;
}

export function resolveManifest(text: string | undefined, defaultPluginPath: string): ResolvedManifest {
  const defaultPlugins = [{ path: defaultPluginPath }];
  if (text === undefined) {
    return { workflows: [defaultWorkflow(defaultPlugins, [], { scope: {}, implement: {} })] };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ManifestError(`The runner manifest is not JSON: ${(error as Error).message}`);
  }
  const parsed = AgentRunManifestSchema.safeParse(json);
  if (!parsed.success) throw new ManifestError(`The runner manifest is invalid: ${z.prettifyError(parsed.error)}`);
  const manifest = parsed.data;
  if (manifest.version === 1) {
    return {
      workflows: [defaultWorkflow(manifest.plugins ?? defaultPlugins, manifest.tools.jira, manifest.phases)],
    };
  }

  const entries = Object.entries(manifest.workflows);
  const problems = entries.flatMap(([id, workflow]) => workflowProblems(id, workflow));
  if (entries.length === 0) problems.push('workflows must name at least one workflow');
  if (entries.length > MAX_WORKFLOWS) problems.push(`workflows must name at most ${MAX_WORKFLOWS} workflows`);
  if (problems.length) throw new ManifestError(`The runner manifest is invalid: ${problems.join('; ')}`);
  return { workflows: entries.map(([id, workflow]) => ({ id, ...workflow })) };
}

/** Every plugin any workflow loads, once each. */
export function manifestPlugins(manifest: ResolvedManifest): Array<{ path: string }> {
  const paths = new Set(manifest.workflows.flatMap((workflow) => workflow.plugins.map((plugin) => plugin.path)));
  return [...paths].map((path) => ({ path }));
}

/** What a runner advertises of a workflow and a run keeps of it. */
export function workflowShape(workflow: ResolvedWorkflow): WorkflowShape {
  return {
    id: workflow.id,
    title: workflow.title,
    repositories: workflow.repositories,
    delivery: workflow.delivery,
    phases: workflow.phases.map(({ id, gate, model: phaseModel, effort: phaseEffort }) => ({
      id,
      gate,
      ...(phaseModel ? { model: phaseModel } : {}),
      ...(phaseEffort ? { effort: phaseEffort } : {}),
    })),
  };
}
