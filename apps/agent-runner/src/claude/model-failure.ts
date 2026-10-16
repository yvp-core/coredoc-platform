/**
 * After Claude Code's own retries, the pinned SDK reports a model API failure as a synthetic assistant
 * message whose `error` names the kind, then a result with `terminal_reason: 'api_error'` and
 * `api_error_status` (null when no response arrived).
 */
import type { SDKAssistantMessageError } from '@anthropic-ai/claude-agent-sdk';

export interface ModelFailure {
  transient: boolean;
  reason: string;
}

const TRANSIENT_ERRORS = new Set<SDKAssistantMessageError>(['rate_limit', 'overloaded', 'server_error']);
const CREDENTIAL_ERRORS = new Set<SDKAssistantMessageError>([
  'authentication_failed',
  'oauth_org_not_allowed',
  'verification_required',
  'cloud_credential_error',
]);
const EXHAUSTED_ERRORS = new Set<SDKAssistantMessageError>(['billing_error', 'account_on_hold']);
/** The API answers a reached usage limit with a plain 400, which the SDK calls `unknown`. */
const EXHAUSTED_TEXT = /usage limit|credit balance/i;

export function classifyModelFailure(input: {
  error: SDKAssistantMessageError | null;
  status: number | null | undefined;
  /** The SDK's own wording, kept after the plain reason. */
  text: string;
}): ModelFailure {
  const { error, status, text } = input;
  const detail = text.trim() ? ` (${text.trim()})` : '';
  const permanent = (reason: string): ModelFailure => ({ transient: false, reason: `${reason}${detail}` });
  if ((error && CREDENTIAL_ERRORS.has(error)) || status === 401 || status === 403) {
    return permanent('The model credential was rejected.');
  }
  if ((error && EXHAUSTED_ERRORS.has(error)) || EXHAUSTED_TEXT.test(text)) {
    return permanent("The model provider's credit or limit is exhausted.");
  }
  if (error === 'model_not_found' || status === 404) {
    return permanent('The configured model does not exist or the model credential cannot use it.');
  }
  // No status means no response arrived: the connection was lost.
  if ((error && TRANSIENT_ERRORS.has(error)) || status === null || status === 429 || (status ?? 0) >= 500) {
    return { transient: true, reason: `The model was unavailable${detail}.` };
  }
  return permanent('The model provider refused the request.');
}
