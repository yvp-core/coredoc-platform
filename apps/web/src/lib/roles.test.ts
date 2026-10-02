import { describe, expect, it } from 'vitest';
import { hasAdminAccess, hasIntentAccess } from './roles';

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
});
