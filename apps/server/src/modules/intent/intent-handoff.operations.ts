import { z } from 'zod';
import { parseAnchorEnvelope, type AnchorEnvelope } from '@coredoc/core';
import { idempotencyKey, itemVersion, repoKey, slugId } from './contract/intent-primitives.js';

export const HandoffSha = z.string().regex(/^[a-f0-9]{40}$/);
const ref = z.object({ itemId: slugId(), version: itemVersion }).strict();
export const HandoffDeclarationsSchema = z
  .object({
    delivers: z.array(ref).max(200).default([]),
    retires: z.array(ref).max(200).default([]),
  })
  .strict()
  .superRefine((v, ctx) => {
    const ids = [...v.delivers, ...v.retires].map((r) => r.itemId);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', message: 'An item may occur only once across delivers and retires.' });
  });
export const SaveIntentHandoffSchema = z
  .object({
    id: z.uuid(),
    expectedVersion: z.number().int().min(0),
    idempotencyKey,
    repoKey,
    headSha: HandoffSha,
    prNumber: z.number().int().positive().optional(),
    bindings: z.array(z.unknown()).max(50).default([]),
    delivers: z.array(ref).max(200).default([]),
    retires: z.array(ref).max(200).default([]),
    supersedesMappingIds: z.array(z.uuid()).max(10).default([]),
  })
  .strict()
  .transform((v, ctx) => {
    const envelope = parseAnchorEnvelope({ schemaVersion: 1, headSha: v.headSha, bindings: v.bindings });
    const declarations = HandoffDeclarationsSchema.safeParse({ delivers: v.delivers, retires: v.retires });
    if (!envelope || !declarations.success || v.supersedesMappingIds.includes(v.id)) {
      ctx.addIssue({ code: 'custom', message: 'Invalid or oversized handoff mapping/declarations' });
      return z.NEVER;
    }
    return { ...v, bindings: envelope.bindings };
  });
export const IntentHandoffToolSchema = z
  .object({
    action: z.enum(['save', 'get', 'list']),
    request: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export const GetIntentHandoffSchema = z.object({ id: z.uuid() }).strict();
export const ListIntentHandoffsSchema = z
  .object({
    repoKey: repoKey.optional(),
    before: z.uuid().optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
export type SaveIntentHandoff = z.infer<typeof SaveIntentHandoffSchema>;
export type HandoffPayload = Pick<SaveIntentHandoff, 'bindings' | 'delivers' | 'retires' | 'supersedesMappingIds'>;
export interface HandoffSnapshot {
  repoKey: string;
  graphVersionId: string;
  graphCommit: string;
  branch: string;
}
export function handoffEnvelope(headSha: string, payload: HandoffPayload): AnchorEnvelope {
  return { schemaVersion: 1, headSha, bindings: payload.bindings };
}

/** CI supplies deployment evidence only; declarations are resolved from the server handoff. */
export const IntentDeploymentSchema = z
  .object({
    kind: z.literal('release'),
    repoKey,
    deliveredRef: HandoffSha,
    deployId: z.string().min(1).max(200),
    deployedAt: z.iso.datetime({ offset: true }),
    handoffId: z.uuid().optional(),
  })
  .strict();
export type IntentDeployment = z.infer<typeof IntentDeploymentSchema>;
