import { describe, it, expect } from 'vitest';
import { slugifyProjectName, assignProjectId } from './project-id.js';

describe('slugifyProjectName', () => {
  it('lowercases and replaces spaces with dashes', () => {
    expect(slugifyProjectName('My Project')).toBe('my-project');
  });

  it('strips diacritics and special characters', () => {
    expect(slugifyProjectName('Café — déjà vu!')).toBe('cafe-deja-vu');
  });

  it('collapses multiple separators', () => {
    expect(slugifyProjectName('a__b  c')).toBe('a-b-c');
  });

  it('trims leading/trailing dashes', () => {
    expect(slugifyProjectName('--hello--')).toBe('hello');
  });

  it('falls back to "project" for an empty result', () => {
    expect(slugifyProjectName('!!!')).toBe('project');
    expect(slugifyProjectName('')).toBe('project');
  });
});

describe('assignProjectId', () => {
  it('returns the slugified name when no collisions', () => {
    expect(assignProjectId('My Project', new Set())).toBe('my-project');
  });

  it('appends -2, -3, ... when colliding with existing ids', () => {
    const taken = new Set(['my-project']);
    expect(assignProjectId('My Project', taken)).toBe('my-project-2');
    taken.add('my-project-2');
    expect(assignProjectId('My Project', taken)).toBe('my-project-3');
  });

  it('handles case-insensitive collisions', () => {
    const taken = new Set(['test']);
    expect(assignProjectId('Test', taken)).toBe('test-2');
  });
});
