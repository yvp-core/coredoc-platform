import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  featureImplementationPlanCase,
  scorePrimaryFeaturePlan,
  type FeaturePlanPrimaryEvidence,
  type FeaturePlanPrimaryVerifier,
} from './feature-implementation-plan.js';
import type { StructuredFact, Target } from '../harness/types.js';

const ACCESS_SHA = '1111111111111111111111111111111111111111';
const TRACE_SHA = '2222222222222222222222222222222222222222';
const ACCESS_DIR = 'apps/console/src/access';

function fact(
  repoKey: string,
  gitSha: string,
  file: string,
  semantics: Omit<StructuredFact, 'repoKey' | 'gitSha' | 'file'>,
  semanticGroups: string[][],
): FeaturePlanPrimaryEvidence {
  return { repoKey, gitSha, file, ...semantics, semanticGroups };
}

interface Fixture {
  name: string;
  verifier: FeaturePlanPrimaryVerifier;
}

// Synthetic verifiers shaped like registered primary cells: a per-role access
// scope feature (with a repo-key path prefix) and a correlation-ID propagation
// feature (whose repo key is also a top-level directory).
const accessScope: Fixture = {
  name: 'acme-console-access-scope',
  verifier: {
    required: [
      fact(
        'acme-console',
        ACCESS_SHA,
        `${ACCESS_DIR}/JitDbAccess.types.ts`,
        {
          qualifiedSymbol: 'JitRoleGrantDraft',
          effect: 'required boolean enabling optional per-role preview-branch scope',
        },
        [['required', 'boolean'], ['per-role', 'per role'], ['preview'], ['scope', 'branchesOnly']],
      ),
      fact(
        'acme-console',
        ACCESS_SHA,
        `${ACCESS_DIR}/JitDbAccess.utils.ts`,
        { qualifiedSymbol: 'createEmptyGrant', effect: 'new grants default to all databases' },
        [['default'], ['all databases', 'all project databases']],
      ),
      fact(
        'acme-console',
        ACCESS_SHA,
        `${ACCESS_DIR}/JitDbAccess.utils.ts`,
        { qualifiedSymbol: 'mapJitMembersToUserRules', relation: 'maps branches_only to branchesOnly' },
        [['branches_only'], ['branchesOnly'], ['maps', 'map', 'deserialize', 'read back']],
      ),
      fact(
        'acme-console',
        ACCESS_SHA,
        `${ACCESS_DIR}/JitDbAccess.utils.ts`,
        {
          qualifiedSymbol: 'serializeDraftRolesForGrantMutation',
          relation: 'serializes branchesOnly to branches_only',
        },
        [['branchesOnly'], ['branches_only'], ['serializes', 'serialize', 'payload']],
      ),
      fact(
        'acme-console',
        ACCESS_SHA,
        `${ACCESS_DIR}/JitDbAccessRoleGrantFields.tsx`,
        {
          qualifiedSymbol: 'JitDbAccessRoleGrantFields',
          useKind: 'per-role preview-branches-only control',
        },
        [['per-role', 'per role'], ['preview'], ['control', 'selector', 'option']],
      ),
      fact(
        'acme-console',
        ACCESS_SHA,
        `${ACCESS_DIR}/JitDbAccessRuleSheet.tsx`,
        { qualifiedSymbol: 'handleSaveRule', relation: 'serializes and submits role grants' },
        [['serializes', 'serialize', 'serializer'], ['submits', 'submit', 'mutation']],
      ),
      fact(
        'acme-console',
        ACCESS_SHA,
        'apps/console/src/data/jit-db-access-grant-mutation.ts',
        {
          qualifiedSymbol: 'grantJitDbAccess',
          method: 'PUT',
          path: '/v1/projects/{ref}/database/jit',
        },
        [],
      ),
      fact(
        'acme-console',
        ACCESS_SHA,
        `${ACCESS_DIR}/JitDbAccessConfiguration.tsx`,
        {
          qualifiedSymbol: 'JitDbAccessConfiguration',
          effect: 'main project owns branch rule management',
        },
        [
          ['main project', 'parent project'],
          ['owns', 'owner', 'redirect'],
          ['branch'],
          ['management', 'manage', 'editing'],
        ],
      ),
      fact(
        'acme-console',
        ACCESS_SHA,
        `${ACCESS_DIR}/JitDbAccess.utils.test.ts`,
        {
          effect: 'serialization coverage for preview-branch scope with expiry and CIDR restrictions',
        },
        [['serialization', 'serialize'], ['branchesOnly'], ['branches_only'], ['expiry'], ['CIDR']],
      ),
    ],
    acceptedFiles: [
      'apps/console/src/preview/useFeaturePreviews.ts',
      'apps/console/src/ui/FeaturePreviewBadge.tsx',
    ],
    unsafeClaims: [
      {
        label: 'one global branchesOnly flag for the whole rule',
        semanticGroups: [['branchesOnly'], ['global', 'rule-wide', 'whole rule', 'single rule']],
      },
      {
        label: 'legacy or new grants default to preview-only',
        semanticGroups: [['default'], ['preview-only', 'preview only']],
      },
      {
        label: 'branch-local rule management',
        semanticGroups: [['branch'], ['local'], ['management', 'manage', 'edit']],
      },
      {
        label: 'drops expiry or CIDR restrictions',
        semanticGroups: [['drop', 'remove', 'omit'], ['expiry'], ['CIDR', 'network']],
        safeNegations: [
          'do not drop expiry or cidr',
          'do not drop expiry/cidr',
          'without dropping expiry or cidr',
          'preserve expiry and cidr',
        ],
      },
      {
        label: 'UI-only change without serialization or API propagation',
        semanticGroups: [['UI-only', 'UI only'], ['without', 'omit'], ['serialization', 'API']],
      },
    ],
  },
};

const correlation: Fixture = {
  name: 'acme-correlation-ids',
  verifier: {
    required: [
      fact('acme', TRACE_SHA, 'services/mcp/src/mcp.ts', {
        qualifiedSymbol: 'MCP.api',
        relation: 'constructs the cached ApiClient with both correlation IDs',
      }, [['cached', 'cache'], ['ApiClient'], ['session'], ['conversation']]),
      fact('acme', TRACE_SHA, 'services/mcp/src/mcp.ts', {
        qualifiedSymbol: 'MCP.setName',
        relation: 'refreshes rotateCachedApiTokenAndTraces',
      }, [['rotateCachedApiTokenAndTraces', 'cached'], ['refreshes', 'refresh', 'rotate', 'update', 'copy']]),
      fact('acme', TRACE_SHA, 'services/mcp/src/mcp.ts', {
        qualifiedSymbol: 'MCP.updateProps',
        relation: 'refreshes rotateCachedApiTokenAndTraces',
      }, [['rotateCachedApiTokenAndTraces', 'cached'], ['refreshes', 'refresh', 'rotate', 'update', 'copy']]),
      fact('acme', TRACE_SHA, 'services/mcp/src/api/client.ts', {
        qualifiedSymbol: 'ApiClient.fetch',
        effect: 'conditionally forwards both correlation headers for every backend request',
      }, [['session'], ['conversation'], ['header', 'headers'], ['forward', 'forwards', 'send', 'add']]),
      fact('acme', TRACE_SHA, 'acme/middleware.py', {
        effect: 'reads and sanitizes both MCP correlation headers',
      }, [['both', 'session'], ['correlation', 'conversation'], ['header', 'headers'], ['sanitizes', 'sanitize']]),
      fact('acme', TRACE_SHA, 'acme/middleware.py', {
        relation: 'binds sanitized IDs to structlog and OpenTelemetry',
      }, [['sanitized', 'sanitize'], ['structlog'], ['OpenTelemetry', 'span']]),
      fact('acme', TRACE_SHA, 'services/mcp/tests/unit/mcp-api-caching.test.ts', {
        effect: 'warm reused server receives later IDs without undefined overwrite',
      }, [['warm', 'reused'], ['later', 'undefined', 'absent'], ['same', 'cached', 'preserve', 'preserves']]),
      fact('acme', TRACE_SHA, 'services/mcp/tests/unit/api-client.test.ts', {
        effect: 'covers both, session-only, and neither correlation header',
      }, [['session'], ['conversation', 'both'], ['header', 'headers'], ['omit', 'omission', 'absent', 'neither', 'session-only']]),
      fact('acme', TRACE_SHA, 'acme/test/test_middleware.py', {
        effect: 'covers both, individual, and absent header context/span binding',
      }, [['both'], ['individual', 'one at a time'], ['absent', 'neither'], ['context'], ['span']]),
      fact('acme', TRACE_SHA, 'services/mcp/ARCHITECTURE.md', {
        effect: 'documents lifecycle and untrusted-correlation-metadata boundary',
      }, [['lifecycle'], ['untrusted', 'trust'], ['correlation'], ['boundary', 'metadata']]),
    ],
    acceptedFiles: ['services/mcp/src/api/client.ts', 'acme/middleware.py'],
    unsafeClaims: [
      {
        label: 'replace the cached ApiClient instance',
        semanticGroups: [['replace'], ['cached'], ['ApiClient']],
        safeNegations: [
          'do not replace the cached apiclient',
          'do not replace cached apiclient',
          'without replacing the cached apiclient',
        ],
      },
      {
        label: 'construction-only correlation IDs',
        semanticGroups: [['construction-only', 'only at construction', 'initialize only'], ['correlation', 'IDs']],
      },
      {
        label: 'overwrite real IDs with undefined',
        semanticGroups: [['overwrite', 'replace'], ['real', 'existing'], ['undefined']],
      },
      {
        label: 'bind unsanitized client IDs to telemetry',
        semanticGroups: [['unsanitized', 'raw'], ['client'], ['telemetry', 'span', 'log']],
      },
      {
        label: 'treat correlation IDs as authentication',
        semanticGroups: [['correlation'], ['authentication', 'authorization', 'auth credential']],
        safeNegations: [
          'ids are not auth',
          'identifiers are not auth',
          'do not treat correlation ids as auth',
        ],
      },
      {
        label: 'claim W3C traceparent propagation',
        semanticGroups: [['W3C', 'traceparent'], ['propagation', 'forward']],
        safeNegations: [
          'do not claim or forward',
          'do not claim/forward',
          'without claiming traceparent propagation',
        ],
      },
      {
        label: 'event-only or log-only partial propagation',
        semanticGroups: [['event-only', 'log-only', 'events only', 'logs only'], ['propagation', 'forward']],
      },
    ],
  },
};

function canonicalLine(fact: FeaturePlanPrimaryEvidence): string {
  const semantics = [
    fact.qualifiedSymbol ? `\`${fact.qualifiedSymbol}\`` : undefined,
    fact.relation,
    fact.method && fact.path ? `${fact.method} ${fact.path}` : undefined,
    fact.effect,
    fact.useKind,
    ...fact.semanticGroups.map((alternatives) => alternatives[0]),
  ].filter(Boolean);
  return `- \`${fact.file}\` — ${semantics.join(' — ')}`;
}

function canonicalResponse(registration: Fixture): string {
  return registration.verifier.required.map(canonicalLine).join('\n');
}

function existingFiles(extra: readonly string[] = []): (path: string) => boolean {
  const known = new Set([
    ...accessScope.verifier.required.map((fact) => fact.file.toLowerCase()),
    ...accessScope.verifier.acceptedFiles.map((path) => path.toLowerCase()),
    ...extra.map((path) => path.toLowerCase()),
  ]);
  return (path) => known.has(path.toLowerCase());
}

describe('feature-plan primary verifier', () => {
  it.each([accessScope, correlation])('scores the canonical $name evidence at 100', (registration) => {
    const response = canonicalResponse(registration);
    const allKnown = new Set([
      ...registration.verifier.required.map((fact) => fact.file.toLowerCase()),
      ...registration.verifier.acceptedFiles.map((path) => path.toLowerCase()),
    ]);
    const result = scorePrimaryFeaturePlan(registration.verifier, response, (path) =>
      allKnown.has(path.toLowerCase()),
    );
    expect(result.details.missingRequired).toEqual([]);
    expect(result.details.fabricatedPaths).toEqual([]);
    expect(result.details.matchedUnsafeClaims).toEqual([]);
    expect(result.score).toBe(100);
  });

  it.each([
    [
      accessScope,
      [
        '- `apps/console/src/access/JitDbAccess.types.ts` — `JitRoleGrantDraft` — add a required branchesOnly boolean per role so preview scope remains optional.',
        '- `apps/console/src/access/JitDbAccess.utils.ts` — `createEmptyGrant` — keep the default at all project databases.',
        '- `apps/console/src/access/JitDbAccess.utils.ts` — `mapJitMembersToUserRules` — deserialize branches_only into branchesOnly during read back.',
        '- `apps/console/src/access/JitDbAccess.utils.ts` — `serializeDraftRolesForGrantMutation` — serialize branchesOnly into the branches_only payload.',
        '- `apps/console/src/access/JitDbAccessRoleGrantFields.tsx` — `JitDbAccessRoleGrantFields` — add a per role preview selector.',
        '- `apps/console/src/access/JitDbAccessRuleSheet.tsx` — `handleSaveRule` — run the serializer and then submit the mutation.',
        '- `apps/console/src/data/jit-db-access-grant-mutation.ts` — `grantJitDbAccess` — PUT /v1/projects/{ref}/database/jit.',
        '- `apps/console/src/access/JitDbAccessConfiguration.tsx` — `JitDbAccessConfiguration` — redirect branch editing because the parent project owns rule management.',
        '- `apps/console/src/access/JitDbAccess.utils.test.ts` — cover branchesOnly to branches_only serialization while preserving expiry and CIDR restrictions.',
      ].join('\n'),
    ],
    [
      correlation,
      [
        '- `services/mcp/src/mcp.ts` — `MCP.api` — cache the ApiClient with session and conversation identifiers.',
        '- `services/mcp/src/mcp.ts` — `MCP.setName` — update rotateCachedApiTokenAndTraces after the name changes.',
        '- `services/mcp/src/mcp.ts` — `MCP.updateProps` — refresh rotateCachedApiTokenAndTraces after props change.',
        '- `services/mcp/src/api/client.ts` — `ApiClient.fetch` — send the session and conversation header on all backend requests.',
        '- `acme/middleware.py` — sanitize both MCP correlation headers before use.',
        '- `acme/middleware.py` — bind the sanitized identifiers to structlog and the OpenTelemetry span.',
        '- `services/mcp/tests/unit/mcp-api-caching.test.ts` — prove the warm reused flow preserves later IDs instead of an undefined overwrite.',
        '- `services/mcp/tests/unit/api-client.test.ts` — cover both, session-only, and neither header.',
        '- `acme/test/test_middleware.py` — cover both IDs, individual headers, and absent headers in request context and span binding.',
        '- `services/mcp/ARCHITECTURE.md` — document the lifecycle and untrusted correlation metadata boundary.',
      ].join('\n'),
    ],
  ] as const)('credits natural paraphrases for $0.name', (registration, response) => {
    const known = new Set([
      ...registration.verifier.required.map((fact) => fact.file.toLowerCase()),
      ...registration.verifier.acceptedFiles.map((path) => path.toLowerCase()),
    ]);
    const result = scorePrimaryFeaturePlan(registration.verifier, response, (path) =>
      known.has(path.toLowerCase()),
    );
    expect(result.details.missingRequired).toEqual([]);
    expect(result.details.fabricatedPaths).toEqual([]);
    expect(result.details.matchedUnsafeClaims).toEqual([]);
    expect(result.score).toBe(100);
  });

  it('scores empty evidence at zero and a missing required unit below canonical', () => {
    expect(scorePrimaryFeaturePlan(accessScope.verifier, '', existingFiles()).score).toBe(0);
    const lines = canonicalResponse(accessScope).split('\n');
    const missing = scorePrimaryFeaturePlan(
      accessScope.verifier,
      lines.slice(1).join('\n'),
      existingFiles(),
    );
    expect(missing.score).toBeGreaterThan(0);
    expect(missing.score).toBeLessThan(100);
    expect(missing.details.missingRequired).toHaveLength(1);
  });

  it.each(['do not', 'never', 'must not'])(
    'does not credit a fully %s-negated canonical response',
    (negation) => {
      const response = canonicalResponse(accessScope)
        .split('\n')
        .map((line) => line.replace(' — ', ` — ${negation} implement `))
        .join('\n');
      const result = scorePrimaryFeaturePlan(accessScope.verifier, response, existingFiles());
      expect(result.score).toBe(0);
      expect(result.details.requiredHits).toBe(0);
    },
  );

  it('keeps a correct existing extra neutral but penalizes a fabricated path', () => {
    const canonical = canonicalResponse(accessScope);
    expect(
      scorePrimaryFeaturePlan(
        accessScope.verifier,
        `${canonical}\n- \`README.md\` — update the operator note.`,
        existingFiles(['README.md']),
      ).score,
    ).toBe(100);
    const fabricated = scorePrimaryFeaturePlan(
      accessScope.verifier,
      `${canonical}\n- \`apps/console/fabricated-preview-scope.ts\` — invented helper.`,
      existingFiles(),
    );
    expect(fabricated.score).toBeLessThan(100);
    expect(fabricated.details.fabricatedPaths).toEqual([
      'apps/console/fabricated-preview-scope.ts',
    ]);
  });

  it('preserves exact citation case when checking a real supporting extra', () => {
    const checked: string[] = [];
    const result = scorePrimaryFeaturePlan(
      accessScope.verifier,
      `${canonicalResponse(accessScope)}\n- \`README.md\` — update the operator note.`,
      (path) => {
        checked.push(path);
        return path === 'README.md';
      },
    );
    expect(checked).toEqual(['README.md']);
    expect(result.details.fabricatedPaths).toEqual([]);
    expect(result.score).toBe(100);
  });

  it('does not credit a same-name symbol in the wrong repo/file or with the wrong relation', () => {
    const [, ...rest] = canonicalResponse(accessScope).split('\n');
    const required = accessScope.verifier.required[0]!;
    const wrongFile = `${rest.join('\n')}\n- \`${accessScope.verifier.required[1]!.file}\` — \`${required.qualifiedSymbol}\` — ${required.effect}`;
    const wrongRepo = `${rest.join('\n')}\n- \`other-repo/${required.file}\` — \`${required.qualifiedSymbol}\` — ${required.effect}`;
    const wrongRelation = `- \`${required.file}\` — \`${required.qualifiedSymbol}\` — stores an unrelated global setting`;

    expect(scorePrimaryFeaturePlan(accessScope.verifier, wrongFile, existingFiles()).score).toBeLessThan(100);
    expect(scorePrimaryFeaturePlan(accessScope.verifier, wrongRepo, existingFiles()).score).toBeLessThan(100);
    expect(
      scorePrimaryFeaturePlan(
        accessScope.verifier,
        [wrongRelation, ...rest].join('\n'),
        existingFiles(),
      ).score,
    ).toBeLessThan(100);
  });

  it('accepts the exact registered repo prefix without accepting another repo prefix', () => {
    const prefixed = canonicalResponse(accessScope).replaceAll('`apps/', '`acme-console/apps/');
    expect(scorePrimaryFeaturePlan(accessScope.verifier, prefixed, existingFiles()).score).toBe(100);
  });

  it('penalizes an unsafe implementation claim even alongside canonical evidence', () => {
    const response = `${canonicalResponse(accessScope)}\n\nA single rule-wide branchesOnly setting is enough.`;
    const result = scorePrimaryFeaturePlan(accessScope.verifier, response, existingFiles());
    expect(result.score).toBeLessThan(100);
    expect(result.details.matchedUnsafeClaims).toEqual([
      'one global branchesOnly flag for the whole rule',
    ]);
  });

  it('requires every unsafe semantic group in the same line', () => {
    const response = `${canonicalResponse(correlation)}\nReplace the client during rotation.\nThe cached ApiClient remains shared.`;
    const result = scorePrimaryFeaturePlan(correlation.verifier, response, existingFiles());
    expect(result.score).toBe(100);
    expect(result.details.matchedUnsafeClaims).toEqual([]);
  });

  it.each([
    [
      accessScope,
      'Do not drop expiry or CIDR restrictions.',
    ],
    [
      correlation,
      [
        'Do not replace the cached ApiClient.',
        'Correlation IDs are not auth.',
        'Do not claim or forward W3C traceparent propagation.',
      ].join('\n'),
    ],
  ] as const)('does not penalize explicit safe negations for $0.name', (registration, safeText) => {
    const known = new Set([
      ...registration.verifier.required.map((fact) => fact.file.toLowerCase()),
      ...registration.verifier.acceptedFiles.map((path) => path.toLowerCase()),
    ]);
    const result = scorePrimaryFeaturePlan(
      registration.verifier,
      `${canonicalResponse(registration)}\n${safeText}`,
      (path) => known.has(path.toLowerCase()),
    );
    expect(result.score).toBe(100);
    expect(result.details.matchedUnsafeClaims).toEqual([]);
  });

  it.each([
    [accessScope, 'Never omit expiry and CIDR restrictions.'],
    [
      correlation,
      [
        'Must not replace the cached ApiClient.',
        'Correlation IDs must not become an auth credential.',
        'Never forward W3C traceparent propagation.',
      ].join('\n'),
    ],
  ] as const)(
    'recognizes generic local negation for forbidden claims in $0.name',
    (registration, safeText) => {
      const known = new Set([
        ...registration.verifier.required.map((fact) => fact.file.toLowerCase()),
        ...registration.verifier.acceptedFiles.map((path) => path.toLowerCase()),
      ]);
      const result = scorePrimaryFeaturePlan(
        registration.verifier,
        `${canonicalResponse(registration)}\n${safeText}`,
        (path) => known.has(path.toLowerCase()),
      );
      expect(result.score).toBe(100);
      expect(result.details.matchedUnsafeClaims).toEqual([]);
    },
  );

  it('still penalizes an affirmative unsafe paraphrase on one line', () => {
    const response = `${canonicalResponse(correlation)}\nReplace the cached ApiClient with a new client after each update.`;
    const result = scorePrimaryFeaturePlan(correlation.verifier, response, existingFiles());
    expect(result.score).toBeLessThan(100);
    expect(result.details.matchedUnsafeClaims).toContain('replace the cached ApiClient instance');
  });

  it('binds an indented continuation line to the file citation in the same bullet', () => {
    const response = canonicalResponse(accessScope)
      .split('\n')
      .map((line) => line.replace(' — ', '\n  '))
      .join('\n');

    expect(scorePrimaryFeaturePlan(accessScope.verifier, response, existingFiles()).score).toBe(100);
  });

  it('accepts a unique expected basename without treating it as a fabricated root file', () => {
    const response = canonicalResponse(correlation).replace(
      /`([^`]+)`/g,
      (_match, path: string) => `\`${basename(path)}\``,
    );
    const result = scorePrimaryFeaturePlan(correlation.verifier, response, existingFiles());

    expect(result.score).toBe(100);
    expect(result.details.fabricatedPaths).toEqual([]);
  });

  it('does not penalize an explicitly proposed new test file', () => {
    const response = `${canonicalResponse(accessScope)}\n- \`apps/console/components/NewPreviewScope.test.tsx\` — new file following the adjacent component-test convention.`;
    const result = scorePrimaryFeaturePlan(accessScope.verifier, response, existingFiles());

    expect(result.score).toBe(100);
    expect(result.details.fabricatedPaths).toEqual([]);
  });

  it('does not match unsafe substrings or a new field on the cached client config', () => {
    const response = [
      canonicalResponse(correlation),
      'Expiry and CIDR remain preserved even when the new property is omittable.',
      'Add new correlation fields to the cached ApiClient config; keep the instance in place.',
    ].join('\n');
    const result = scorePrimaryFeaturePlan(correlation.verifier, response, existingFiles());

    expect(result.score).toBe(100);
    expect(result.details.matchedUnsafeClaims).toEqual([]);
  });

  it('credits behaviorally equivalent correlation plans without the helper name', () => {
    const response = [
      '- `services/mcp/src/mcp.ts` — `MCP.api()` constructs the cached `ApiClient` with `mcpSessionId` and `mcpConversationId`; `MCP.setName()` and `MCP.updateProps()` update those correlation IDs on the same cached config.',
      '- `services/mcp/src/api/client.ts` — `ApiClient.fetch()` forwards session and conversation headers when configured.',
      '- `acme/middleware.py` — sanitize the session and conversation headers before binding them to structlog and the OpenTelemetry span.',
      '- `services/mcp/tests/unit/mcp-api-caching.test.ts` — cover a warm server where both IDs are absent initially and later update the same cached client.',
      '- `services/mcp/tests/unit/api-client.test.ts` — cover session and conversation headers plus omission when absent.',
      '- `services/mcp/ARCHITECTURE.md` — document the lifecycle and trust boundary: correlation metadata is not auth.',
    ].join('\n');
    const result = scorePrimaryFeaturePlan(correlation.verifier, response, existingFiles());

    expect(result.details.requiredHits).toBeGreaterThanOrEqual(8);
    expect(result.details.matchedUnsafeClaims).toEqual([]);
  });
});

describe('feature implementation prompt', () => {
  it('uses optional target-specific plan sections without exposing expected files', () => {
    const prompt = featureImplementationPlanCase.buildPrompt(
      { name: 'rails-monolith' } as Target,
      {
        feature: 'Improve Rails extraction depth.',
        expectedFiles: ['hidden/truth.rb'],
        planSections: ['Routes and controllers', 'Models and callbacks'],
      },
    );
    expect(prompt).toContain('1. Routes and controllers');
    expect(prompt).toContain('2. Models and callbacks');
    expect(prompt).not.toContain('hidden/truth.rb');
  });
});
