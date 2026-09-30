import { describe, expect, it } from 'vitest';
import { bareStringMethodName } from './tree-sitter-scip.js';

/**
 * `methodNameArg` primitive — reads a dynamic-dispatch SDK method NAME from a
 * POSITIONAL string-literal argument, e.g. the `"listCompanyBookings"` in
 * `this.performApiRequest("listCompanyBookings", [args])` (sample-integrations-api's
 * repository layer). Unlike `bareStringVerb`, the captured value is an arbitrary SDK
 * method name (NOT validated against HTTP verbs). It must stay conservative: a
 * non-literal arg (variable / member / interpolated template) yields undefined so the
 * call is honestly unresolved rather than capturing an identifier that is not a name.
 */
describe('bareStringMethodName (methodNameArg positional SDK method name)', () => {
  it('reads the method name from a single/double/backtick string literal', () => {
    expect(bareStringMethodName('"listCompanyBookings"')).toBe('listCompanyBookings');
    expect(bareStringMethodName("'createCustomReport'")).toBe('createCustomReport');
    expect(bareStringMethodName('`getCustomReport`')).toBe('getCustomReport');
    expect(bareStringMethodName(' "syncRequestAttachments" ')).toBe('syncRequestAttachments');
    expect(bareStringMethodName('"_privateMethod$"')).toBe('_privateMethod$');
  });

  it('returns undefined for a non-literal arg (the dynamic `method` variable case)', () => {
    // daily-summaries-repository.js:116 — `this.performApiRequest(method, …)`. arg[0] is
    // a variable, not a literal; capturing it would store an identifier, not a method.
    expect(bareStringMethodName('method')).toBeUndefined();
    expect(bareStringMethodName('opts.method')).toBeUndefined();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: raw source text of an interpolated template-literal arg, asserted as a non-literal input
    expect(bareStringMethodName('`${verb}`')).toBeUndefined();
    expect(bareStringMethodName('this.method')).toBeUndefined();
  });

  it('returns undefined for a non-identifier literal (array/object/path arg)', () => {
    expect(bareStringMethodName('[companyUuid]')).toBeUndefined();
    expect(bareStringMethodName('{ defaultResponse: [] }')).toBeUndefined();
    expect(bareStringMethodName('"/v2/management/bookings"')).toBeUndefined();
  });

  it('returns undefined for an absent or empty arg', () => {
    expect(bareStringMethodName(undefined)).toBeUndefined();
    expect(bareStringMethodName('')).toBeUndefined();
  });
});
