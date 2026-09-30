/**
 * Offline license verification.
 *
 * On-prem customers (banks, regulated shops) reject phone-home licensing, so
 * enforcement is fully offline: an Ed25519-signed file is mounted into the
 * container and pointed at by COREDOC_LICENSE_FILE. Nothing is ever sent
 * anywhere, and expiry degrades the deployment (see LicenseGuard) instead of
 * bricking it.
 *
 * Absent env var ⇒ LicenseState.Absent ⇒ zero enforcement. That is the hosted
 * deployment and every existing install: this module must be invisible there.
 */

import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { miscConfigFromEnv } from '../../config/app-config.js';
import { LICENSE_PUBLIC_KEY_PEM, type LicensePayload, parseAndVerifyLicense } from './license-format.mjs';
import { LicenseState, type LicenseStatus, resolveLicenseState, toLicenseStatus } from './license-state.js';

export const LICENSE_OPTIONS = Symbol('LICENSE_OPTIONS');

export interface LicenseServiceOptions {
  /** Overrides COREDOC_LICENSE_FILE. */
  filePath?: string;
  /** Overrides the public key baked into the image. */
  publicKeyPem?: string;
  /** Injectable clock — tests drive expiry without waiting for it. */
  now?: () => Date;
  /** Re-verification period. Hourly by default. */
  refreshIntervalMs?: number;
}

const DEFAULT_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const GRACE_WARN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Thrown at boot when a license file is configured but not usable. */
export class LicenseFileError extends Error {
  constructor(filePath: string, reason: string) {
    super(`License file ${filePath} is not usable: ${reason}`);
    this.name = 'LicenseFileError';
  }
}

@Injectable()
export class LicenseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LicenseService.name);
  private readonly filePath: string | undefined;
  private readonly publicKeyPem: string;
  private readonly now: () => Date;
  private readonly refreshIntervalMs: number;
  private status: LicenseStatus = { state: LicenseState.Absent };
  /**
   * Last payload whose signature verified, kept separately from `status`: the
   * status is time-derived and must keep ageing even when the file becomes
   * unreadable (see refresh).
   */
  private verifiedPayload: LicensePayload | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastGraceWarnMs = 0;

  constructor(@Optional() @Inject(LICENSE_OPTIONS) options: LicenseServiceOptions = {}) {
    const configuredPath = options.filePath ?? miscConfigFromEnv().licenseFile;
    // An empty/whitespace value is treated as unset: Helm renders the env var
    // only when a secret is configured, but a hand-written deployment that sets
    // COREDOC_LICENSE_FILE="" means "no license", not "read the file ''".
    this.filePath = configuredPath?.trim() ? configuredPath.trim() : undefined;
    this.publicKeyPem = options.publicKeyPem ?? LICENSE_PUBLIC_KEY_PEM;
    this.now = options.now ?? (() => new Date());
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  }

  onModuleInit(): void {
    // Deliberately NOT wrapped: a present-but-bad license file is an error
    // state, not "run without a license", so it fails the boot.
    this.reload();
    if (!this.filePath) {
      this.logger.log('No COREDOC_LICENSE_FILE configured — license enforcement is off.');
      return;
    }
    this.logger.log(
      `License loaded from ${this.filePath}: customer=${this.status.customer} expiresAt=${this.status.expiresAt} state=${this.status.state}`,
    );
    this.warnIfDegraded();
    // Re-verify periodically so an expiry is noticed without a restart.
    this.timer = setInterval(() => this.refresh(), this.refreshIntervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStatus(): LicenseStatus {
    return this.status;
  }

  isExpired(): boolean {
    return this.status.state === LicenseState.Expired;
  }

  /**
   * Re-read and re-verify the file. Used by the periodic timer and by tests.
   *
   * Intentional fallback: unlike boot, a failure here keeps the last
   * cryptographically VERIFIED payload and only logs. The file is verified once
   * at boot; if it later disappears (secret remount, node eviction) or is
   * tampered with, taking a running deployment down would be a worse outcome
   * than continuing on the entitlement it already proved — and a restart still
   * fails fast.
   *
   * What is NOT retained is the time-derived state: expiry is recomputed from
   * the retained payload on every refresh. Freezing `valid` on the last
   * successful read would turn "make the secret unreadable" into an unbounded
   * license extension.
   */
  refresh(): void {
    try {
      this.reload();
      this.warnIfDegraded();
    } catch (error) {
      this.recomputeFromVerifiedPayload();
      this.logger.error(`License re-verification failed, state=${this.status.state}: ${describe(error)}`);
      this.warnIfDegraded();
    }
  }

  /** Re-age the last verified payload against the clock (see refresh). */
  private recomputeFromVerifiedPayload(): void {
    if (!this.verifiedPayload) return;
    this.status = toLicenseStatus(this.verifiedPayload, resolveLicenseState(this.verifiedPayload, this.now()));
  }

  private reload(): void {
    if (!this.filePath) {
      this.status = { state: LicenseState.Absent };
      return;
    }
    let contents: string;
    try {
      contents = readFileSync(this.filePath, 'utf8');
    } catch (error) {
      throw new LicenseFileError(this.filePath, describe(error));
    }
    let payload: ReturnType<typeof parseAndVerifyLicense>;
    try {
      payload = parseAndVerifyLicense(contents, this.publicKeyPem);
    } catch (error) {
      throw new LicenseFileError(this.filePath, describe(error));
    }
    this.verifiedPayload = payload;
    this.status = toLicenseStatus(payload, resolveLicenseState(payload, this.now()));
  }

  /** Grace/expiry warnings, rate-limited to one per day (the timer is hourly). */
  private warnIfDegraded(): void {
    if (this.status.state !== LicenseState.Grace && this.status.state !== LicenseState.Expired) return;
    const nowMs = this.now().getTime();
    if (this.lastGraceWarnMs !== 0 && nowMs - this.lastGraceWarnMs < GRACE_WARN_INTERVAL_MS) return;
    this.lastGraceWarnMs = nowMs;
    this.logger.warn(
      this.status.state === LicenseState.Grace
        ? `Coredoc license for ${this.status.customer} expired on ${this.status.expiresAt} and is inside its ${this.status.graceDays ?? 0}-day grace window — renew it to avoid write rejections.`
        : `Coredoc license for ${this.status.customer} expired on ${this.status.expiresAt} and its grace window has ended — mutating API requests are being rejected.`,
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
