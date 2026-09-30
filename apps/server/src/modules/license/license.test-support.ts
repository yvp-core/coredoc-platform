/**
 * Builds REAL LicenseService instances in a chosen state, for the consumers
 * that live outside this module (the delivery sync cron, the job-claim path).
 *
 * Not a stub on purpose: those consumers must react to the state the service
 * derives from a signed payload and a clock, so a test that hand-waves
 * `isExpired: () => true` would pass even if the state mapping regressed.
 * Signed with the committed test-fixtures keypair — never the production key.
 *
 * Named *.test-support.ts so vitest does not collect it as a suite and tsc
 * does not emit it into dist (see tsconfig exclude).
 */

import { sign as cryptoSign, createPrivateKey } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalizeLicensePayload } from './license-format.mjs';
import { LicenseState } from './license-state.js';
import { LicenseService } from './license.service.js';

const FIXTURE_PRIVATE_KEY = createPrivateKey(
  readFileSync(fileURLToPath(new URL('./test-fixtures/test-license-private.pem', import.meta.url)), 'utf8'),
);
const FIXTURE_PUBLIC_KEY = readFileSync(
  fileURLToPath(new URL('./test-fixtures/test-license-public.pem', import.meta.url)),
  'utf8',
);

const NOW = '2027-01-01T00:00:00Z';
/** expiresAt relative to NOW, chosen so each state is the only possible one. */
const EXPIRES_AT: Record<Exclude<LicenseState, LicenseState.Absent>, string> = {
  [LicenseState.Valid]: '2027-06-01',
  [LicenseState.Grace]: '2026-12-25',
  [LicenseState.Expired]: '2026-01-01',
};

function writeLicense(expiresAt: string): string {
  const payload = { customer: 'acme-corp', issuedAt: '2025-01-01', expiresAt, graceDays: 30 };
  const signature = cryptoSign(null, Buffer.from(canonicalizeLicensePayload(payload), 'utf8'), FIXTURE_PRIVATE_KEY);
  const file = join(mkdtempSync(join(tmpdir(), 'coredoc-license-support-')), 'license.json');
  writeFileSync(file, JSON.stringify({ payload, signature: signature.toString('base64') }));
  return file;
}

/** Booted LicenseService reporting `state`. Caller owns onModuleDestroy(). */
export function licenseServiceIn(state: LicenseState): LicenseService {
  const service = new LicenseService({
    publicKeyPem: FIXTURE_PUBLIC_KEY,
    now: () => new Date(NOW),
    ...(state === LicenseState.Absent ? {} : { filePath: writeLicense(EXPIRES_AT[state]) }),
  });
  service.onModuleInit();
  if (service.getStatus().state !== state) {
    throw new Error(`license test support built ${service.getStatus().state}, expected ${state}`);
  }
  return service;
}
