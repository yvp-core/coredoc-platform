/**
 * The strip-source trust boundary, as one predicate and one message.
 *
 * `NO_SOURCE_CODE_MESSAGE` and the `containsSourceCode` check from `@coredoc/db` are the boundary
 * itself and are shared verbatim by both enforcement points:
 *
 * - `NoSourceCodePipe` — the runtime gate on the push endpoints, whose bodies are bare or
 *   polymorphic and cannot be described by a single schema;
 * - `noSourceCode(schema)` — the refinement a request schema wears to state the same contract on
 *   a field it does describe.
 *
 * It was a class-validator decorator until Track B3 retired that stack
 * (`.scratch/server-structure-cleanup/spec.md`); the predicate, the message and its tests are
 * unchanged, which is the point: this boundary is never weakened in passing.
 */
import { containsSourceCode } from '@coredoc/db';
import type { z } from 'zod';

export const NO_SOURCE_CODE_MESSAGE = 'Payload must not contain sourceCode fields. Strip source code before push.';

export function noSourceCode<T extends z.ZodTypeAny>(schema: T): T {
  return schema.refine((value: unknown) => !containsSourceCode(value), NO_SOURCE_CODE_MESSAGE) as unknown as T;
}
