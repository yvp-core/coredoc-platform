import { describe, expect, it, vi } from 'vitest';
import { ParsersController } from './parsers.controller.js';

/** A parser archive holds a repo's extraction profile and parser sources, so it follows the repo. */
function makeController() {
  const parsers = {
    listParsers: vi.fn().mockResolvedValue([{ repoName: 'api' }, { repoName: 'calc' }]),
    downloadParser: vi.fn().mockResolvedValue(Buffer.from('archive')),
    getParserMeta: vi.fn().mockResolvedValue({ sha256: 'abc' }),
  };
  const controlPlane = {
    listRepos: async () => [
      { repoKey: 'k-api', repoName: 'api', restricted: false },
      { repoKey: 'k-calc', repoName: 'calc', restricted: true },
    ],
    listRepoGrants: async () => [],
  };
  return { controller: new ParsersController(parsers as never, controlPlane as never), parsers };
}
const MEMBER = { userId: 'u1', role: 'member' };
const ADMIN = { userId: 'u2', role: 'admin' };
const response = () => ({ set: vi.fn(), send: vi.fn() });

describe('ParsersController', () => {
  it('keeps the parser of a restricted repo from a member with no binding on it', async () => {
    const { controller, parsers } = makeController();
    expect(await controller.listParsers('ws-1', MEMBER)).toEqual([{ repoName: 'api' }]);
    expect(await controller.getParserMeta('ws-1', 'calc', MEMBER)).toEqual({ found: false });
    await expect(controller.downloadParser('ws-1', 'calc', MEMBER, response() as never)).rejects.toMatchObject({
      status: 404,
    });
    expect(parsers.downloadParser).not.toHaveBeenCalled();
  });

  it('serves it to an admin, and an open repo to the member', async () => {
    const { controller } = makeController();
    const forAdmin = response();
    await controller.downloadParser('ws-1', 'calc', ADMIN, forAdmin as never);
    expect(forAdmin.send).toHaveBeenCalled();
    const forMember = response();
    await controller.downloadParser('ws-1', 'api', MEMBER, forMember as never);
    expect(forMember.send).toHaveBeenCalled();
  });
});
