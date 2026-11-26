import { describe, expect, it } from 'vitest';
import { canOpenConsultantView, hasAdminAccess, hasIntentAccess, isConsultant } from './roles';

describe('role gates', () => {
  it('gives the product role the intent controls but not admin ones', () => {
    expect(hasIntentAccess('product')).toBe(true);
    expect(hasAdminAccess('product')).toBe(false);
  });

  it('keeps admins and owners on both, and members on neither', () => {
    for (const role of ['admin', 'owner']) {
      expect(hasIntentAccess(role)).toBe(true);
      expect(hasAdminAccess(role)).toBe(true);
    }
    expect(hasIntentAccess('member')).toBe(false);
    expect(hasAdminAccess('member')).toBe(false);
  });

  it('opens the consultant view to consultants and to admins previewing it, never to members', () => {
    expect(isConsultant('consultant')).toBe(true);
    expect(canOpenConsultantView('consultant')).toBe(true);
    expect(hasAdminAccess('consultant')).toBe(false);
    expect(hasIntentAccess('consultant')).toBe(false);
    for (const role of ['admin', 'owner']) {
      expect(isConsultant(role)).toBe(false);
      expect(canOpenConsultantView(role)).toBe(true);
    }
    for (const role of ['member', 'product', 'support']) {
      expect(canOpenConsultantView(role)).toBe(false);
    }
  });
});
