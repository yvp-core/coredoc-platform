import { describe, expect, it } from 'vitest';
import { selectCiToken } from './TeamMcpCiCdStep';

describe('TeamMcpCiCdStep CI token selection', () => {
  it('selects the CI token with automatic intent writes when a telemetry token is listed first', () => {
    const telemetry = {
      id: 'telemetry-token',
      name: 'otel:fixture',
      tokenPrefix: 'cdt_tel',
      permissions: ['telemetry:write'],
      lastUsedAt: null,
      createdAt: '2026-08-16T10:00:00.000Z',
    };
    const ci = {
      id: 'ci-token',
      name: 'ci',
      tokenPrefix: 'cdt_ci',
      permissions: [
        'result:write',
        'repo:push',
        'parser:read',
        'result:read',
        'parser:write',
        'intent:release',
        'intent:bindings',
      ],
      lastUsedAt: null,
      createdAt: '2026-08-16T10:01:00.000Z',
    };

    expect(selectCiToken([telemetry, ci])).toBe(ci);
  });
});
