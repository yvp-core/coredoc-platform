/**
 * STATE refusals of the cloud intent service — the second half of the §12
 * public error surface.
 *
 * `IntentErrorCode` (contract/intent-errors.ts) enumerates the CONTENT failures
 * a request can carry: schema shape, secret/email-shaped text, structure
 * budgets. What this file adds is the other kind of refusal: the request was
 * well-formed, and the WORKSPACE STATE says no — the domain does not exist, the
 * item is not a candidate, the version moved, the idempotency key was already
 * spent on a different request.
 *
 * The wire shape is deliberately identical (`{code, message, path}`), so a CLI
 * or agent branches on `code` and never has to know which half a refusal came
 * from. The state codes therefore LIVE IN `IntentErrorCode` too: this file owns
 * the STATUS mapping (400 / 404 / 409) and the value-vs-exception distinction,
 * not a second vocabulary. It previously owned an `IntentStateErrorCode` enum
 * bridged into the contract by widening casts; the enums are merged and the
 * casts are gone.
 *
 * Messages state the rule and may name IDS the caller itself supplied or that
 * the workspace already holds (blocking domains, the conflicting item). They
 * never echo free-text content.
 */
import { HttpStatus } from '@nestjs/common';
import {
  IntentErrorCode,
  IntentPublicException,
  boundIntentPublicError,
  type IntentErrorDetail,
} from './contract/index.js';

/** A thrown state refusal. */
export function intentStateError(
  code: IntentErrorCode,
  message: string,
  path: string[],
  status: HttpStatus = HttpStatus.BAD_REQUEST,
  details?: IntentErrorDetail[],
): IntentPublicException {
  return new IntentPublicException({ code, message, path, ...(details ? { details } : {}) }, status);
}

/**
 * A state refusal reported as a VALUE rather than thrown.
 *
 * Batch review reports one result per decision (spec §5): one item's refusal
 * must not roll back another item's applied decision, so a per-decision refusal
 * cannot travel as an exception. It still travels through the same message
 * bound as a thrown one, so the `{code, message, path}` a caller reads is
 * identical whichever half of the batch produced it.
 */
export function intentStateRefusal(code: IntentErrorCode, message: string, path: string[]): IntentErrorDetail {
  return boundIntentPublicError({ code, message, path });
}

/** A refusal about state that cannot be reached: 404. */
export function intentNotFound(code: IntentErrorCode, message: string, path: string[]): IntentPublicException {
  return intentStateError(code, message, path, HttpStatus.NOT_FOUND);
}

/** A refusal about state that changed under the caller, or a spent key: 409. */
export function intentConflict(code: IntentErrorCode, message: string, path: string[]): IntentPublicException {
  return intentStateError(code, message, path, HttpStatus.CONFLICT);
}

/**
 * Assert that a route path id and the same id in the request body agree.
 *
 * The operation schemas carry every id in the BODY, because the MCP surface has
 * no path (see `contract/intent-operations.ts`). A REST route that also names
 * the id in its path must therefore prove the two say the same thing rather
 * than silently preferring one — a mismatch is a caller bug, and picking a
 * winner would make the same request mean different things on the two surfaces.
 */
export function assertPathMatchesBody(pathValue: string, bodyValue: string, field: string): void {
  if (pathValue === bodyValue) return;
  throw intentStateError(
    IntentErrorCode.PathBodyMismatch,
    `The '${field}' in the request body must match the one in the route path`,
    [field],
  );
}
