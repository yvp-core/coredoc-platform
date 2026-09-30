/**
 * Degradation vocabulary — the tables that turn a graph-plane failure into
 * something a caller can act on (§6.3).
 */

import { describe, expect, it } from 'vitest';
import { WorkspaceFileCacheError } from '../../../database/workspace-file-cache.service.js';
import { WorkspaceGraphContextError } from '../../../mcp/workspace-mcp-context.service.js';
import { IntentGraphUnavailableCode } from './derivation-contract.js';
import { graphRemediation, graphUnavailableCode, isProgrammingError } from './graph-degradation.js';

describe('graphUnavailableCode', () => {
  it('maps every context-resolver refusal', () => {
    expect(graphUnavailableCode(new WorkspaceGraphContextError('WORKSPACE_NOT_FOUND', ''))).toBe(
      IntentGraphUnavailableCode.WorkspaceNotFound,
    );
    expect(graphUnavailableCode(new WorkspaceGraphContextError('DATABASE_UNAVAILABLE', ''))).toBe(
      IntentGraphUnavailableCode.LegacyDatabaseUnavailable,
    );
    expect(graphUnavailableCode(new WorkspaceGraphContextError('UNSUPPORTED_ENGINE', ''))).toBe(
      IntentGraphUnavailableCode.UnsupportedEngine,
    );
  });

  it('maps every file-cache failure', () => {
    expect(graphUnavailableCode(new WorkspaceFileCacheError('INTEGRITY', ''))).toBe(
      IntentGraphUnavailableCode.GraphIntegrityFailed,
    );
    expect(graphUnavailableCode(new WorkspaceFileCacheError('CACHE_CAPACITY', ''))).toBe(
      IntentGraphUnavailableCode.GraphCacheCapacity,
    );
  });

  it('returns undefined for anything else, so a bug stays a bug', () => {
    expect(graphUnavailableCode(new Error('null is not a function'))).toBeUndefined();
    expect(graphUnavailableCode('not even an error')).toBeUndefined();
    expect(graphUnavailableCode(undefined)).toBeUndefined();
  });
});

describe('isProgrammingError', () => {
  it('recognises the native classes only a bug produces', () => {
    expect(isProgrammingError(new TypeError('x is not a function'))).toBe(true);
    expect(isProgrammingError(new ReferenceError('x is not defined'))).toBe(true);
    expect(isProgrammingError(new RangeError('invalid array length'))).toBe(true);
  });

  it('leaves a graph-plane failure to degrade', () => {
    // A backend reports its failures as plain Errors or its own types; those
    // are the ones §6.3 turns into a degradation the caller can act on.
    expect(isProgrammingError(new Error('kuzu: relation scan failed'))).toBe(false);
    expect(isProgrammingError(new WorkspaceFileCacheError('INTEGRITY', ''))).toBe(false);
    expect(isProgrammingError('not even an error')).toBe(false);
  });
});

describe('graphRemediation', () => {
  it('has an actionable line for every code', () => {
    for (const code of Object.values(IntentGraphUnavailableCode)) {
      const remediation = graphRemediation(code);
      expect(remediation.length).toBeGreaterThan(0);
      // A remediation tells the reader what to DO; a bare restatement of the
      // failure is the thing this assertion exists to keep out.
      expect(remediation).toMatch(/retry|republish|publish|restore|migrate|upgrade|configure|confirm/i);
    }
  });
});
