import { describe, it, expect, vi } from 'vitest';
import { LicenseState } from './license-state.js';
import { LicenseController } from './license.controller.js';
import type { LicenseService } from './license.service.js';

describe('LicenseController', () => {
  it('returns only the state — no customer, expiry, grace or signature', () => {
    const status = {
      state: LicenseState.Grace,
      customer: 'acme-corp',
      expiresAt: '2027-08-27',
      graceDays: 30,
    };
    const controller = new LicenseController({ getStatus: vi.fn(() => status) } as unknown as LicenseService);

    const result = controller.getLicense();

    // This route is unauthenticated: commercial details must not leak from it.
    expect(result).toEqual({ state: LicenseState.Grace });
    expect(Object.keys(result)).toEqual(['state']);
  });

  it('reports absent when no license is configured', () => {
    const controller = new LicenseController({
      getStatus: vi.fn(() => ({ state: LicenseState.Absent })),
    } as unknown as LicenseService);

    expect(controller.getLicense()).toEqual({ state: LicenseState.Absent });
  });
});
