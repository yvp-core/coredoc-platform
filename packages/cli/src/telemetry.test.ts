/**
 * Tests for the CLI telemetry shim (P0.7 + P1.T1).
 *
 * The shim is a thin adapter over `@coredoc/core/telemetry` — there is no local
 * PostHog client anymore. These tests assert each exported helper delegates to
 * the shared client with the right event + props. The core module keeps its
 * REAL `EventName`/`ErrorCode` (via importActual) while `track`/`trackError`/
 * `shutdownTelemetry`/reset are spied.
 *
 * P1.T1 adds the command funnel seam: `trackCommandCompleted` /
 * `trackCommandFailed` (the testable emit seam the self-executing `index.ts`
 * hooks call) and `classifyError` (error → `error_code` bucket). The shim emits
 * NO free-text error report: a crash message can carry un-redactable workspace /
 * repo / branch names, so `command_failed`'s `error_code` bucket is the only
 * failure signal shipped and there is no `trackError` forwarding to assert.
 * `index.ts` itself self-executes on import, so this shim is where the emit shape
 * is verified.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ErrorCode, EventName } from '@coredoc/core/telemetry';

const { trackSpy } = vi.hoisted(() => ({
  trackSpy: vi.fn(),
}));

vi.mock('@coredoc/core/telemetry', async (importActual) => {
  const actual = await importActual<typeof import('@coredoc/core/telemetry')>();
  return {
    ...actual,
    track: trackSpy,
  };
});

import {
  trackCommandCompleted,
  trackCommandFailed,
  trackProfileAuthored,
  classifyError,
  isTelemetryCommandPath,
  buildTelemetryShowText,
} from './telemetry.js';

describe('CLI telemetry shim', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('trackCommandCompleted', () => {
    it('emits CommandCompleted with the name-path command + duration_ms', () => {
      trackCommandCompleted('parser list', 1234);
      expect(trackSpy).toHaveBeenCalledWith(EventName.CommandCompleted, {
        command: 'parser list',
        duration_ms: 1234,
      });
    });
  });

  describe('trackCommandFailed', () => {
    it('emits CommandFailed with command + duration_ms + error_code', () => {
      trackCommandFailed('sync', 500, ErrorCode.NetworkError);
      expect(trackSpy).toHaveBeenCalledWith(EventName.CommandFailed, {
        command: 'sync',
        duration_ms: 500,
        error_code: ErrorCode.NetworkError,
      });
    });
  });

  describe('trackProfileAuthored', () => {
    it('emits ProfileAuthored { outcome: "pass" } when the score passes', () => {
      trackProfileAuthored(true);
      expect(trackSpy).toHaveBeenCalledWith(EventName.ProfileAuthored, { outcome: 'pass' });
    });

    it('emits ProfileAuthored { outcome: "fail" } when the score fails', () => {
      trackProfileAuthored(false);
      expect(trackSpy).toHaveBeenCalledWith(EventName.ProfileAuthored, { outcome: 'fail' });
    });
  });

  describe('classifyError', () => {
    it('buckets network-shaped errors as NetworkError', () => {
      expect(classifyError(new Error('fetch failed: ECONNREFUSED'))).toBe(ErrorCode.NetworkError);
      expect(classifyError(new Error('socket hang up'))).toBe(ErrorCode.NetworkError);
    });

    it('buckets auth-shaped errors as AuthFailed', () => {
      expect(classifyError(new Error('Request failed with status 401 Unauthorized'))).toBe(ErrorCode.AuthFailed);
      expect(classifyError(new Error('403 Forbidden'))).toBe(ErrorCode.AuthFailed);
      expect(classifyError(new Error('authentication required'))).toBe(ErrorCode.AuthFailed);
      expect(classifyError(new Error('user is not authorized'))).toBe(ErrorCode.AuthFailed);
    });

    it('does NOT bucket author-profile domain errors as AuthFailed (the `auth` substring trap)', () => {
      // The flagship workflow is `author-profile` / `profile score`; a word like
      // "author"/"authoring"/"authority" must not trip the auth classifier, or an
      // authoring failure is BOTH mislabeled AND (previously) had its diagnostic
      // dropped. The token is word-boundaried now, so these stay Unknown.
      expect(classifyError(new Error('Failed to author profile for repo'))).toBe(ErrorCode.Unknown);
      expect(classifyError(new Error('profile authoring loop did not converge'))).toBe(ErrorCode.Unknown);
      expect(classifyError(new Error('author-profile skill exited non-zero'))).toBe(ErrorCode.Unknown);
      expect(classifyError(new Error('lacks authority to write file'))).toBe(ErrorCode.Unknown);
    });

    it('defaults to Unknown for anything else, and tolerates non-Error values', () => {
      expect(classifyError(new Error('Repo not found for: samplerepo'))).toBe(ErrorCode.Unknown);
      expect(classifyError('boom')).toBe(ErrorCode.Unknown);
      expect(classifyError(undefined)).toBe(ErrorCode.Unknown);
    });
  });

  describe('isTelemetryCommandPath (B2 — reportCliError / postAction skip)', () => {
    it('is true for the bare telemetry command and every nested subcommand', () => {
      expect(isTelemetryCommandPath('telemetry')).toBe(true);
      expect(isTelemetryCommandPath('telemetry on')).toBe(true);
      expect(isTelemetryCommandPath('telemetry off')).toBe(true);
      expect(isTelemetryCommandPath('telemetry show')).toBe(true);
      expect(isTelemetryCommandPath('telemetry status')).toBe(true);
    });

    it('is false for non-telemetry commands, the crash default, and lookalikes', () => {
      expect(isTelemetryCommandPath('sync')).toBe(false);
      expect(isTelemetryCommandPath('parser list')).toBe(false);
      expect(isTelemetryCommandPath('unknown')).toBe(false); // reportCliError's default path
      expect(isTelemetryCommandPath('')).toBe(false);
      expect(isTelemetryCommandPath('telemetryfoo')).toBe(false); // prefix arm needs a trailing space
    });
  });

  describe('buildTelemetryShowText (B1 — honest disclosure)', () => {
    const text = buildTelemetryShowText('inst_abc123');

    it('enumerates the full event vocabulary, including events beyond command_*', () => {
      // The stale copy listed ONLY command_completed / command_failed. Assert the
      // product + pipeline funnel events the shared client actually emits are now
      // disclosed (derived from the EventName enum, so this can't drift back).
      expect(text).toContain(EventName.ParseCompleted);
      expect(text).toContain('parse_completed');
      expect(text).toContain('repo_added');
      expect(text).toContain('command_completed');
      expect(text).toContain('command_failed');
      expect(text).toContain('summarize_completed');
      expect(text).toContain('push_completed');
      expect(text).toContain('profile_authored');
    });

    it('every EventName value appears in the output', () => {
      for (const event of Object.values(EventName)) {
        expect(text).toContain(event);
      }
    });

    it('lists the REAL auto-carried BaseProps keys (with the install id inlined)', () => {
      for (const key of [
        'install_id',
        'session_id',
        'invocation_id',
        'surface',
        'repo_id',
        'cli_version',
        'engine_version',
        'platform',
        'schema_version',
      ]) {
        expect(text).toContain(key);
      }
      expect(text).toContain('inst_abc123');
    });

    it('does NOT claim the stale distinctId / $lib properties', () => {
      expect(text).not.toContain('$lib');
      expect(text).not.toContain('coredoc-cli');
      expect(text).not.toContain('distinctId');
    });

    it('keeps the "never sent" privacy guarantees', () => {
      expect(text).toContain('Source code');
      expect(text).toContain('File paths');
    });
  });
});
