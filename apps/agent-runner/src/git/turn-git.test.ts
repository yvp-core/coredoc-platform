import { describe, expect, it } from 'vitest';
import { commitSubject, finalRemoteRejection } from './turn-git.js';

const porcelain = (reason: string) =>
  `To https://github.com/example-org/orders-api.git\n!\tHEAD:refs/heads/coredoc/PROJ-1\t[remote rejected] (${reason})\nDone\n`;

describe('finalRemoteRejection', () => {
  it('leaves a GitHub 500 to the retry, and fails on any other remote rejection', () => {
    expect(finalRemoteRejection(porcelain('Internal Server Error'))).toBeNull();
    expect(finalRemoteRejection(porcelain('pre-receive hook declined'))).toBe(
      '[remote rejected] (pre-receive hook declined)',
    );
    expect(finalRemoteRejection('fatal: unable to access: Could not resolve host')).toBeNull();
  });
});

describe('commitSubject', () => {
  it.each([
    ['Orders\n export', 'PROJ-1: Orders export'],
    ['PROJ-1: Orders export', 'PROJ-1: Orders export'],
    ['PROJ-1', 'PROJ-1'],
    ['PROJ-10 follows', 'PROJ-1: PROJ-10 follows'],
  ])('%j is prefixed with the issue key once', (title, subject) => {
    expect(commitSubject('PROJ-1', title)).toBe(subject);
  });
});
