import { describe, expect, it } from 'vitest';
import { finalRemoteRejection } from './turn-git.js';

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
