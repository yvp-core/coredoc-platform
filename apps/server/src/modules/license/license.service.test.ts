import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LicenseState } from './license-state.js';
import { LicenseFileError, LicenseService, type LicenseServiceOptions } from './license.service.js';

const TOOL = fileURLToPath(new URL('../../../scripts/license-tool.mjs', import.meta.url));
const FIXTURE_PRIVATE_KEY = fileURLToPath(new URL('./test-fixtures/test-license-private.pem', import.meta.url));
const FIXTURE_PUBLIC_KEY = readFileSync(
  fileURLToPath(new URL('./test-fixtures/test-license-public.pem', import.meta.url)),
  'utf8',
);

const workDir = mkdtempSync(join(tmpdir(), 'coredoc-license-service-'));
let validLicense: string;

function issue(name: string, args: string[]): string {
  const out = join(workDir, name);
  execFileSync(process.execPath, [TOOL, 'issue', '--key', FIXTURE_PRIVATE_KEY, '--out', out, ...args], {
    encoding: 'utf8',
  });
  return out;
}

/** Fixed clock — expiry is driven by the injected `now`, never by wall time. */
function at(iso: string): () => Date {
  return () => new Date(iso);
}

function makeService(options: LicenseServiceOptions = {}): LicenseService {
  return new LicenseService({ publicKeyPem: FIXTURE_PUBLIC_KEY, ...options });
}

beforeAll(() => {
  validLicense = issue('license.json', ['--customer', 'acme-corp', '--expires', '2027-08-27', '--grace-days', '30']);
});

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.COREDOC_LICENSE_FILE;
});

describe('LicenseService — absent (hosted mode and every existing install)', () => {
  it('reports absent and never becomes expired when COREDOC_LICENSE_FILE is unset', () => {
    delete process.env.COREDOC_LICENSE_FILE;
    const service = makeService();

    service.onModuleInit();

    expect(service.getStatus()).toEqual({ state: LicenseState.Absent });
    expect(service.isExpired()).toBe(false);
    service.onModuleDestroy();
  });

  it('treats an empty COREDOC_LICENSE_FILE as unset rather than reading the file ""', () => {
    process.env.COREDOC_LICENSE_FILE = '   ';
    const service = new LicenseService({ publicKeyPem: FIXTURE_PUBLIC_KEY });

    service.onModuleInit();

    expect(service.getStatus().state).toBe(LicenseState.Absent);
    service.onModuleDestroy();
  });

  it('reads the path from COREDOC_LICENSE_FILE when no explicit option is given', () => {
    process.env.COREDOC_LICENSE_FILE = validLicense;
    const service = new LicenseService({ publicKeyPem: FIXTURE_PUBLIC_KEY, now: at('2027-01-01T00:00:00Z') });

    service.onModuleInit();

    expect(service.getStatus()).toEqual({
      state: LicenseState.Valid,
      customer: 'acme-corp',
      expiresAt: '2027-08-27',
      graceDays: 30,
    });
    service.onModuleDestroy();
  });
});

describe('LicenseService — states', () => {
  it.each([
    ['2027-01-01T00:00:00Z', LicenseState.Valid],
    // expiresAt is UTC midnight at the START of the day, so the day itself is grace.
    ['2027-08-27T00:00:01Z', LicenseState.Grace],
    ['2027-09-25T00:00:00Z', LicenseState.Grace],
    ['2027-09-26T00:00:01Z', LicenseState.Expired],
  ])('at %s the license is %s', (now, expected) => {
    const service = makeService({ filePath: validLicense, now: at(now) });

    service.onModuleInit();

    expect(service.getStatus().state).toBe(expected);
    expect(service.isExpired()).toBe(expected === LicenseState.Expired);
    service.onModuleDestroy();
  });

  it('never enters grace when the license carries no graceDays', () => {
    const file = issue('no-grace.json', ['--customer', 'acme-corp', '--expires', '2027-08-27']);
    const service = makeService({ filePath: file, now: at('2027-08-27T00:00:01Z') });

    service.onModuleInit();

    expect(service.getStatus().state).toBe(LicenseState.Expired);
    service.onModuleDestroy();
  });
});

describe('LicenseService — invalid file fails the boot', () => {
  it('names the file and the reason when the payload was tampered with', () => {
    const document = JSON.parse(readFileSync(validLicense, 'utf8'));
    const tampered = join(workDir, 'tampered.json');
    writeFileSync(
      tampered,
      JSON.stringify({ payload: { ...document.payload, expiresAt: '2099-01-01' }, signature: document.signature }),
    );
    const service = makeService({ filePath: tampered, now: at('2027-01-01T00:00:00Z') });

    expect(() => service.onModuleInit()).toThrow(LicenseFileError);
    expect(() => service.onModuleInit()).toThrow(new RegExp(`${tampered}.*signature does not match`, 's'));
  });

  it('names the file and the reason when it is missing', () => {
    const missing = join(workDir, 'nope.json');
    const service = makeService({ filePath: missing });

    expect(() => service.onModuleInit()).toThrow(new RegExp(`${missing}.*ENOENT`, 's'));
  });

  it('names the file and the reason when it is not valid JSON', () => {
    const garbage = join(workDir, 'garbage.json');
    writeFileSync(garbage, 'not a license');
    const service = makeService({ filePath: garbage });

    expect(() => service.onModuleInit()).toThrow(/not valid JSON/);
  });
});

describe('LicenseService — periodic re-verification', () => {
  it('notices expiry on the interval without a restart', () => {
    vi.useFakeTimers();
    try {
      let now = new Date('2027-09-25T00:00:00Z');
      const service = makeService({ filePath: validLicense, now: () => now, refreshIntervalMs: 1000 });
      service.onModuleInit();
      expect(service.getStatus().state).toBe(LicenseState.Grace);

      now = new Date('2027-09-27T00:00:00Z');
      vi.advanceTimersByTime(1000);

      expect(service.getStatus().state).toBe(LicenseState.Expired);
      service.onModuleDestroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the last known good state (and logs) when a later re-verification fails', () => {
    const disappearing = join(workDir, 'disappearing.json');
    writeFileSync(disappearing, readFileSync(validLicense, 'utf8'));
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = makeService({ filePath: disappearing, now: at('2027-01-01T00:00:00Z') });
    service.onModuleInit();
    expect(service.getStatus().state).toBe(LicenseState.Valid);

    rmSync(disappearing);
    service.refresh();

    // Boot fails fast on a bad file; a running deployment does not get bricked
    // by a secret remount — it keeps the state it already proved.
    expect(service.getStatus().state).toBe(LicenseState.Valid);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('License re-verification failed'));
    service.onModuleDestroy();
  });

  it('keeps ageing the retained payload when the file stays unreadable', () => {
    // A license that can no longer be re-read must still EXPIRE. Retaining the
    // last verified payload but recomputing the state from the clock is what
    // stops "delete the secret" from being an unbounded license extension.
    const disappearing = join(workDir, 'disappearing-ageing.json');
    writeFileSync(disappearing, readFileSync(validLicense, 'utf8'));
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    let now = new Date('2027-01-01T00:00:00Z');
    const service = makeService({ filePath: disappearing, now: () => now });
    service.onModuleInit();
    expect(service.getStatus().state).toBe(LicenseState.Valid);

    rmSync(disappearing);

    now = new Date('2027-09-01T00:00:00Z');
    service.refresh();
    expect(service.getStatus()).toMatchObject({ state: LicenseState.Grace, customer: 'acme-corp' });

    now = new Date('2027-10-01T00:00:00Z');
    service.refresh();
    expect(service.getStatus().state).toBe(LicenseState.Expired);
    expect(service.isExpired()).toBe(true);
    service.onModuleDestroy();
  });

  it('warns at most once a day while in grace', () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    let now = new Date('2027-08-28T00:00:00Z');
    const service = makeService({ filePath: validLicense, now: () => now });
    service.onModuleInit();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    now = new Date('2027-08-28T06:00:00Z');
    service.refresh();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    now = new Date('2027-08-29T06:00:00Z');
    service.refresh();
    expect(warnSpy).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
  });
});
