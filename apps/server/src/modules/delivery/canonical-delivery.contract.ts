/**
 * Request shapes for the delivery v2 write routes, as zod schemas applied by
 * `ZodValidationPipe` at the controller boundary (`.scratch/server-structure-cleanup/spec.md`,
 * Track B1). Every message here is the literal string the previous hand-rolled validators threw,
 * because clients match on the 400 body; `canonical-delivery.validation-parity.test.ts` freezes
 * them route by route.
 */
import { BadRequestException, ForbiddenException, type HttpException } from '@nestjs/common';
import { z } from 'zod';
import { validateCaptureRepositoryKey, validateDeliveryTaskId } from '../capture/capture-contract.js';

const LIFECYCLES = new Set(['active', 'completed', 'abandoned']);
const ADAPTER_KEY_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const POSITIVE_DECIMAL_RE = /^[1-9][0-9]{0,18}$/;
const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;

export const TASK_AUTHORITY_FORBIDDEN_CODE = 'TASK_AUTHORITY_FORBIDDEN';
export const TASK_AUTHORITY_FORBIDDEN_MESSAGE =
  'Telemetry task ensure cannot submit connector authority or external references';

export type DeliveryTaskLifecycle = 'active' | 'completed' | 'abandoned';

export interface TaskExternalRefInput {
  provider: string;
  externalId: string;
  externalKey: string | null;
  externalUrl: string | null;
  externalState: string | null;
}

export type TaskAuthorityFallback = { kind: 'coredoc' } | { kind: 'external_ref'; externalRefId: string };

/** A capture-contract validator read as a predicate: it returns its input or throws. */
function accepts(validate: (value: unknown) => unknown): (value: unknown) => boolean {
  return (value: unknown) => {
    try {
      validate(value);
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * A body object with exactly the declared fields. The single `error` hook carries both bespoke
 * messages the hand-rolled `exactFields` produced: the shape one and the unknown-field one.
 */
function exact<Shape extends z.ZodRawShape>(label: string, shape: Shape) {
  return z.strictObject(shape, {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? `Unsupported ${label} field: ${issue.keys[0]}`
        : `${label} must be an object`,
  });
}

const boundedString = (label: string, maximum: number) =>
  z.custom<string>(
    (value) => typeof value === 'string' && value.length >= 1 && value.length <= maximum,
    `${label} must contain between 1 and ${maximum} characters`,
  );

const adapterKey = (label: string) =>
  z.custom<string>(
    (value) => typeof value === 'string' && ADAPTER_KEY_RE.test(value),
    `${label} must be a compact lowercase adapter key`,
  );

const uuid = (label: string) =>
  z
    .custom<string>((value) => typeof value === 'string' && UUID_RE.test(value), `${label} must be a UUID`)
    .transform((value) => value.toLowerCase());

const positiveDecimal = (label: string) =>
  z.custom<string>(
    (value) => typeof value === 'string' && POSITIVE_DECIMAL_RE.test(value) && BigInt(value) <= MAX_SIGNED_BIGINT,
    `${label} must be a positive bounded decimal string`,
  );

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = ISO_TIMESTAMP_RE.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maximumDay = month === 2 ? (leapYear ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return month >= 1 && month <= 12 && day >= 1 && day <= maximumDay && hour <= 23 && minute <= 59 && second <= 59;
}

const timestamp = (label: string) => z.custom<string>(isIsoTimestamp, `${label} must be an ISO-8601 timestamp`);

/** The canonical `cdt_<UUID>` task id, shared by the path params and the artifact body. */
export const CanonicalTaskIdSchema = z
  .custom<string>(accepts(validateDeliveryTaskId), 'taskId must use the canonical cdt_<UUID> format')
  .transform((value) => validateDeliveryTaskId(value));

export const CaptureRepositoryKeySchema = z.custom<string>(
  accepts(validateCaptureRepositoryKey),
  'repositoryKey must be a normalized repository identifier',
);

/** `PUT tasks/:taskId` — the telemetry producer wire. */
export const DeliveryTaskEnsureSchema = exact('delivery task ensure', {
  // Declared in the order the hand-rolled validator checked them, so the first zod issue is the
  // message that route used to return. The authority fence is expressed per field rather than as
  // a cross-field refinement for the same reason: it must outrank `repositoryKey`.
  lifecycle: z
    .custom<DeliveryTaskLifecycle>((value) => typeof value === 'string' && LIFECYCLES.has(value), {
      error: (issue) => `Unsupported delivery task lifecycle: ${issue.input}`,
    })
    .optional(),
  externalRefs: z
    .custom<TaskExternalRefInput[]>(
      (value) => Array.isArray(value) && value.length <= 32,
      'externalRefs must contain at most 32 entries',
    )
    .refine((refs) => refs.length === 0, TASK_AUTHORITY_FORBIDDEN_MESSAGE)
    .default([]),
  authority: z.custom<'coredoc'>((value) => value === 'coredoc', TASK_AUTHORITY_FORBIDDEN_MESSAGE).optional(),
  repositoryKey: CaptureRepositoryKeySchema.optional(),
});

/** `POST tasks/:taskId/ship-evidence/coredoc`. */
export const CoredocShipEvidenceSchema = exact('Coredoc ship evidence', {
  eventId: uuid('eventId'),
  shippedAt: timestamp('shippedAt'),
});

/** A provider URL that may be persisted and rendered: no credentials, query or fragment. */
export const TaskExternalRefUrlSchema = boundedString('externalUrl', 2048).pipe(
  z.custom<string>((value) => {
    const raw = value as string;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return false;
    }
    return !(
      parsed.protocol !== 'https:' ||
      parsed.hostname === '' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      raw.includes('?') ||
      raw.includes('#')
    );
  }, 'externalUrl must be a bounded HTTPS URL without credentials, query, or fragment'),
);

/** `POST tasks/:taskId/external-refs`. */
export const TaskExternalRefAttachSchema = exact('task external reference attach', {
  connectorId: z
    .custom<string | null>(
      (value) => value === null || (typeof value === 'string' && UUID_RE.test(value)),
      'connectorId must be a UUID',
    )
    .transform((value) => (value === null ? null : value.toLowerCase())),
  makeAuthority: z.custom<boolean>((value) => typeof value === 'boolean', 'makeAuthority must be a boolean'),
  provider: adapterKey('provider'),
  externalId: boundedString('externalId', 256),
}).refine(
  (input) => !(input.connectorId === null && input.makeAuthority),
  'A connector-less external reference cannot become lifecycle authority',
);

const FallbackAuthoritySchema = z
  .custom<unknown>(
    (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
    'fallbackAuthority must be an object',
  )
  .pipe(
    z.discriminatedUnion(
      'kind',
      [
        exact('Coredoc fallback authority', { kind: z.literal('coredoc') }),
        exact('external-ref fallback authority', {
          kind: z.literal('external_ref'),
          externalRefId: positiveDecimal('fallbackAuthority.externalRefId'),
        }),
      ],
      { error: 'fallbackAuthority kind must be coredoc or external_ref' },
    ),
  );

/** `POST tasks/:taskId/external-refs/:externalRefId/detach` — the path id is validated separately. */
export const TaskExternalRefDetachSchema = exact('task external reference detach', {
  fallbackAuthority: FallbackAuthoritySchema.optional(),
});

export type DeliveryTaskEnsureInput = z.infer<typeof DeliveryTaskEnsureSchema>;
export type CoredocShipEvidenceInput = z.infer<typeof CoredocShipEvidenceSchema>;
export type TaskExternalRefAttachInput = z.infer<typeof TaskExternalRefAttachSchema>;
export type TaskExternalRefDetachInput = z.infer<typeof TaskExternalRefDetachSchema>;

/**
 * The delivery v2 rejection policy, passed to every `ZodValidationPipe` on this controller.
 *
 * Precedence reproduces the order the hand-rolled validators ran in: the body-shape and
 * unknown-field gate first (path-less issues), then the typed telemetry authority fence, which is
 * a 403 with its own `code` rather than a 400, then the first field issue.
 */
export function deliveryBodyError(error: z.ZodError): HttpException {
  const issues = error.issues;
  const forbidden = issues.some((issue) => issue.message === TASK_AUTHORITY_FORBIDDEN_MESSAGE);
  const structural = issues.find((issue) => issue.path.length === 0);
  if (structural) return new BadRequestException(structural.message);
  if (forbidden) {
    return new ForbiddenException({
      statusCode: 403,
      error: 'Forbidden',
      code: TASK_AUTHORITY_FORBIDDEN_CODE,
      message: TASK_AUTHORITY_FORBIDDEN_MESSAGE,
    });
  }
  return new BadRequestException(issues[0]?.message ?? 'Invalid canonical delivery body');
}
