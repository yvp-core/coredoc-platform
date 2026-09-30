import { describe, it, expect } from 'vitest';
import {
  TokenPermission,
  CI_TOKEN_PERMISSIONS,
  INTENT_AGENT_TOKEN_PERMISSIONS,
  TELEMETRY_TOKEN_PERMISSIONS,
  WILDCARD_EXEMPT_PERMISSIONS,
  isExactTelemetryPurpose,
  isWildcardExemptPermission,
} from './token-permissions.js';

describe('CI_TOKEN_PERMISSIONS', () => {
  it('grants graph publishing plus the two automatic intent writes', () => {
    expect(CI_TOKEN_PERMISSIONS).toEqual([
      TokenPermission.ParserRead,
      TokenPermission.ParserWrite,
      TokenPermission.ResultRead,
      TokenPermission.ResultWrite,
      TokenPermission.RepoPush,
      TokenPermission.IntentRelease,
      TokenPermission.IntentBindings,
    ]);
  });

  it('never grants high-privilege control-plane permissions to CI tokens', () => {
    // Regression guard: token-management and workspace-management routes are gated by
    // these permissions. If CI_TOKEN_PERMISSIONS ever reverted to
    // `Object.values(TokenPermission)`, a leaked CI token could mint tokens or perform
    // workspace administration. These must stay excluded.
    expect(CI_TOKEN_PERMISSIONS).not.toContain(TokenPermission.TokenManage);
    expect(CI_TOKEN_PERMISSIONS).not.toContain(TokenPermission.WorkspaceManage);
    expect(CI_TOKEN_PERMISSIONS).not.toContain('token:manage');
    expect(CI_TOKEN_PERMISSIONS).not.toContain('workspace:manage');
  });

  describe('TelemetryWrite permission', () => {
    it('has correct enum value', () => {
      expect(TokenPermission.TelemetryWrite).toBe('telemetry:write');
    });

    it('is excluded from CI_TOKEN_PERMISSIONS', () => {
      expect(CI_TOKEN_PERMISSIONS).not.toContain(TokenPermission.TelemetryWrite);
    });

    it('recognizes only the exact telemetry-purpose permission set', () => {
      expect(isExactTelemetryPurpose([TokenPermission.TelemetryWrite])).toBe(true);
      expect(isExactTelemetryPurpose([])).toBe(false);
      expect(isExactTelemetryPurpose([TokenPermission.TelemetryWrite, TokenPermission.ResultRead])).toBe(false);
      expect(isExactTelemetryPurpose([TokenPermission.TelemetryWrite, TokenPermission.TelemetryWrite])).toBe(false);
      expect(isExactTelemetryPurpose(undefined)).toBe(false);
    });
  });

  describe('GraphRead permission', () => {
    it('has correct enum value', () => {
      expect(TokenPermission.GraphRead).toBe('graph:read');
    });

    it('is excluded from CI_TOKEN_PERMISSIONS (opt-in only)', () => {
      // The B1-3 REST graph endpoints are a new data-plane surface, but
      // opt-in-only by design: existing CI tokens must not silently gain
      // graph-read access when this permission is introduced.
      expect(CI_TOKEN_PERMISSIONS).not.toContain(TokenPermission.GraphRead);
      expect(CI_TOKEN_PERMISSIONS).not.toContain('graph:read');
    });

    it('is excluded from TELEMETRY_TOKEN_PERMISSIONS', () => {
      expect(TELEMETRY_TOKEN_PERMISSIONS).not.toContain(TokenPermission.GraphRead);
    });
  });

  describe('intent permissions', () => {
    it('have the wire values the intent contract and archive use', () => {
      expect(TokenPermission.IntentRead).toBe('intent:read');
      expect(TokenPermission.IntentPropose).toBe('intent:propose');
    });

    it('never enter CI token defaults — a CI credential is not a product-authority one', () => {
      for (const permission of [TokenPermission.IntentRead, TokenPermission.IntentPropose]) {
        expect(CI_TOKEN_PERMISSIONS).not.toContain(permission);
        expect(CI_TOKEN_PERMISSIONS as string[]).not.toContain(permission as string);
      }
    });

    it('never enter telemetry token defaults', () => {
      expect(TELEMETRY_TOKEN_PERMISSIONS).not.toContain(TokenPermission.IntentRead);
      expect(TELEMETRY_TOKEN_PERMISSIONS).not.toContain(TokenPermission.IntentPropose);
    });

    it('grant an intent-agent token read + propose and nothing else', () => {
      // No review/tree/anchor permission exists to add: those need a user
      // session, so the machine-reachable surface is exactly these two.
      expect(INTENT_AGENT_TOKEN_PERMISSIONS).toEqual([TokenPermission.IntentRead, TokenPermission.IntentPropose]);
    });

    it('are exempt from wildcard expansion', () => {
      expect(WILDCARD_EXEMPT_PERMISSIONS).toEqual([
        TokenPermission.IntentRead,
        TokenPermission.IntentPropose,
        TokenPermission.IntentRelease,
        TokenPermission.IntentBindings,
      ]);
      expect(isWildcardExemptPermission(TokenPermission.IntentRead)).toBe(true);
      expect(isWildcardExemptPermission(TokenPermission.IntentPropose)).toBe(true);
      // A legacy grant-all token must never be able to assert production state.
      expect(isWildcardExemptPermission(TokenPermission.IntentRelease)).toBe(true);
      // Nor to write anchors into the overlay from a pipeline.
      expect(isWildcardExemptPermission(TokenPermission.IntentBindings)).toBe(true);
    });

    it('grants automatic intent writes to CI, but not telemetry or intent-agent', () => {
      for (const permission of [TokenPermission.IntentRelease, TokenPermission.IntentBindings]) {
        expect(CI_TOKEN_PERMISSIONS).toContain(permission);
        expect(TELEMETRY_TOKEN_PERMISSIONS).not.toContain(permission);
        expect(INTENT_AGENT_TOKEN_PERMISSIONS).not.toContain(permission);
      }
    });

    it('leave every pre-existing permission inside wildcard expansion', () => {
      // Narrowing `*` further would silently break tokens in the field; the
      // exemption exists only for scopes introduced after `*` was granted.
      for (const permission of [
        TokenPermission.ParserRead,
        TokenPermission.ParserWrite,
        TokenPermission.ResultRead,
        TokenPermission.ResultWrite,
        TokenPermission.RepoPush,
        TokenPermission.TokenManage,
        TokenPermission.WorkspaceManage,
        TokenPermission.TelemetryWrite,
        TokenPermission.GraphRead,
      ]) {
        expect(isWildcardExemptPermission(permission)).toBe(false);
      }
    });
  });
});
