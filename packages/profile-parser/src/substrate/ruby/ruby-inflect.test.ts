import { describe, expect, it } from 'vitest';
import { classify, pluralize, singularize, snakeCase } from './ruby-inflect.js';

describe('snakeCase', () => {
  it('lowercases PascalCase to snake_case', () => {
    expect(snakeCase('UserProfile')).toBe('user_profile');
    expect(snakeCase('Company')).toBe('company');
  });

  it('handles consecutive capitals (acronyms), best-effort', () => {
    expect(snakeCase('HTTPServer')).toBe('http_server');
    expect(snakeCase('APIKey')).toBe('api_key');
  });

  it('strips leading underscores it would otherwise emit', () => {
    expect(snakeCase('User')).toBe('user');
  });

  it('passes through already snake_case input', () => {
    expect(snakeCase('user_profile')).toBe('user_profile');
  });
});

describe('pluralize', () => {
  it('y after consonant -> ies', () => {
    expect(pluralize('company')).toBe('companies');
  });

  it('y after vowel -> ys', () => {
    expect(pluralize('holiday')).toBe('holidays');
  });

  it('s/x/z/ch/sh -> es', () => {
    expect(pluralize('address')).toBe('addresses');
    expect(pluralize('box')).toBe('boxes');
    expect(pluralize('branch')).toBe('branches');
    expect(pluralize('dish')).toBe('dishes');
  });

  it('default -> +s', () => {
    expect(pluralize('user')).toBe('users');
  });

  it('only the final word of a snake_case identifier is pluralized', () => {
    expect(pluralize('user_profile')).toBe('user_profiles');
    expect(pluralize('time_entry')).toBe('time_entries');
  });

  it('applies the regular rule to a word that names an Object.prototype member', () => {
    // The irregulars table used to be a plain object, so `constructor` came back as a Function.
    expect(pluralize('constructor')).toBe('constructors');
    expect(singularize('constructors')).toBe('constructor');
  });
});

describe('singularize', () => {
  it('ies -> y', () => {
    expect(singularize('companies')).toBe('company');
  });

  it('es after sibilant -> drop es', () => {
    expect(singularize('addresses')).toBe('address');
    expect(singularize('boxes')).toBe('box');
    expect(singularize('branches')).toBe('branch');
  });

  it('plain s -> drop s', () => {
    expect(singularize('employees')).toBe('employee');
    expect(singularize('users')).toBe('user');
  });

  it('leaves a non-plural word unchanged', () => {
    expect(singularize('company')).toBe('company');
  });

  it('singularizes only the final word of a snake_case identifier', () => {
    expect(singularize('user_profiles')).toBe('user_profile');
  });
});

describe('classify', () => {
  it('singularizes then PascalCases', () => {
    expect(classify('user_profiles')).toBe('UserProfile');
    expect(classify('employees')).toBe('Employee');
    expect(classify('companies')).toBe('Company');
  });

  it('handles an already-singular table name', () => {
    expect(classify('company')).toBe('Company');
  });
});

describe('irregular plurals (B3.1)', () => {
  it('pluralizes common irregulars', () => {
    expect(pluralize('person')).toBe('people');
    expect(pluralize('child')).toBe('children');
    expect(pluralize('man')).toBe('men');
    // only the final word of a compound is inflected
    expect(pluralize('admin_person')).toBe('admin_people');
  });

  it('singularizes common irregulars', () => {
    expect(singularize('people')).toBe('person');
    expect(singularize('children')).toBe('child');
    expect(singularize('men')).toBe('man');
    expect(singularize('admin_people')).toBe('admin_person');
  });

  it('classifies an irregular table name to its model constant', () => {
    expect(classify('people')).toBe('Person');
    expect(classify('children')).toBe('Child');
  });

  it('still handles regular words (regression)', () => {
    expect(pluralize('company')).toBe('companies');
    expect(singularize('companies')).toBe('company');
    expect(classify('user_profiles')).toBe('UserProfile');
  });
});
