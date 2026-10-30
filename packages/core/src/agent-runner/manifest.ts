/** A deployment's runner configuration, baked into its runner image; absent keys keep the platform defaults. */
import { z } from 'zod';

/** The plugin the default phase prompts run; a manifest may leave it out only when every phase names an entry skill. */
export const CORE_PLUGIN_NAME = 'coredoc-workflows';

export enum JiraAccess {
  Read = 'read',
}

const PhaseSchema = z.strictObject({
  model: z.string().trim().min(1).optional(),
  /** `<plugin>:<skill>`; the run-control tools are refused until the session has invoked it. */
  entrySkill: z
    .string()
    .regex(/^[^:\s]+:[^:\s]+$/)
    .optional(),
});

export const AgentRunManifestSchema = z.strictObject({
  version: z.literal(1),
  plugins: z
    .array(z.strictObject({ path: z.string().startsWith('/') }))
    .min(1)
    .max(10)
    .optional(),
  tools: z.strictObject({ jira: z.array(z.enum(JiraAccess)).default([]) }).default({ jira: [] }),
  phases: z
    .strictObject({ scope: PhaseSchema.default({}), implement: PhaseSchema.default({}) })
    .default({ scope: {}, implement: {} }),
});

export type ManifestPhase = z.infer<typeof PhaseSchema>;

export interface ResolvedManifest {
  plugins: Array<{ path: string }>;
  tools: { jira: JiraAccess[] };
  phases: { scope: ManifestPhase; implement: ManifestPhase };
}

export class ManifestError extends Error {}

export function resolveManifest(text: string | undefined, defaultPluginPath: string): ResolvedManifest {
  const plugins = [{ path: defaultPluginPath }];
  if (text === undefined) return { plugins, tools: { jira: [] }, phases: { scope: {}, implement: {} } };

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ManifestError(`The runner manifest is not JSON: ${(error as Error).message}`);
  }
  const parsed = AgentRunManifestSchema.safeParse(json);
  if (!parsed.success) throw new ManifestError(`The runner manifest is invalid: ${z.prettifyError(parsed.error)}`);
  const { tools, phases } = parsed.data;
  return { plugins: parsed.data.plugins ?? plugins, tools, phases };
}
