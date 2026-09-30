import type { LicensePayload } from './license-format.mjs';

/**
 * Lifecycle of the mounted license file, as observed by a RUNNING server.
 *
 * There is deliberately no `invalid` member: an unreadable or forged license
 * file is not a state the server runs in — LicenseService throws at boot so the
 * deployment fails fast with the file name and the reason (a present-but-bad
 * license must never silently degrade into "no license").
 */
export enum LicenseState {
  /** COREDOC_LICENSE_FILE unset — zero enforcement (hosted mode, dev). */
  Absent = 'absent',
  /** Signature verified and now is before `expiresAt`. */
  Valid = 'valid',
  /** Past `expiresAt`, still inside the grace window — full function. */
  Grace = 'grace',
  /** Past `expiresAt` + `graceDays` — mutating API requests are refused. */
  Expired = 'expired',
}

/** Public status shape — never includes the signature. */
export interface LicenseStatus {
  state: LicenseState;
  customer?: string;
  expiresAt?: string;
  graceDays?: number;
}

const MS_PER_DAY = 86_400_000;

/**
 * Map a verified payload onto a state at instant `now`.
 *
 * `expiresAt` is a date string, so it resolves to UTC midnight at the START of
 * that day: a license with `expiresAt: 2027-08-27` leaves `valid` the moment
 * 2027-08-27 begins in UTC. Grace runs `graceDays` further from there.
 */
export function resolveLicenseState(payload: LicensePayload, now: Date): LicenseState {
  const expiresAtMs = Date.parse(payload.expiresAt);
  if (now.getTime() < expiresAtMs) return LicenseState.Valid;
  const graceEndsMs = expiresAtMs + (payload.graceDays ?? 0) * MS_PER_DAY;
  return now.getTime() < graceEndsMs ? LicenseState.Grace : LicenseState.Expired;
}

export function toLicenseStatus(payload: LicensePayload, state: LicenseState): LicenseStatus {
  return {
    state,
    customer: payload.customer,
    expiresAt: payload.expiresAt,
    ...(payload.graceDays === undefined ? {} : { graceDays: payload.graceDays }),
  };
}
