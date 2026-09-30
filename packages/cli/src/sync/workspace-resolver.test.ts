import { describe, expect, it, vi } from 'vitest';
import { resolveWorkspace, WorkspaceConflictError } from './workspace-resolver.js';
import { SlugTakenError, WorkspaceNotFoundError } from './workspace-api.js';

const stubApi = (
  over: Partial<{
    createWorkspace: ReturnType<typeof vi.fn>;
    getWorkspace: ReturnType<typeof vi.fn>;
  }> = {},
) => ({
  createWorkspace: over.createWorkspace ?? vi.fn(async () => ({ id: 'ws_new', name: 'n', slug: 's' })),
  getWorkspace: over.getWorkspace ?? vi.fn(async () => ({ id: 'ws_x' })),
});

const baseProject = { id: 'p1', name: 'Project One', repos: [] } as {
  id: string;
  name: string;
  repos: unknown[];
  cloud?: { enabled: boolean; workspaceId?: string };
};

describe('resolveWorkspace', () => {
  it('case (a): flag conflicts with stored, no --rebind → throws WorkspaceConflictError', async () => {
    const project = { ...baseProject, cloud: { enabled: true, workspaceId: 'ws_stored' } };
    const api = stubApi();
    await expect(resolveWorkspace({ project, flag: 'ws_other', rebind: false }, api)).rejects.toBeInstanceOf(
      WorkspaceConflictError,
    );
    expect(api.getWorkspace).not.toHaveBeenCalled();
  });

  it("case (a) with --rebind → returns flag id, action 'rebind'", async () => {
    const project = { ...baseProject, cloud: { enabled: true, workspaceId: 'ws_stored' } };
    const api = stubApi();
    const res = await resolveWorkspace({ project, flag: 'ws_other', rebind: true }, api);
    expect(res).toEqual({ workspaceId: 'ws_other', action: 'rebind' });
    expect(api.getWorkspace).toHaveBeenCalledWith('ws_other');
  });

  it("case (b): flag only → 'use-flag'", async () => {
    const api = stubApi();
    const res = await resolveWorkspace({ project: baseProject, flag: 'ws_flag', rebind: false }, api);
    expect(res).toEqual({ workspaceId: 'ws_flag', action: 'use-flag' });
  });

  it("case (c): stored only → 'use-stored'", async () => {
    const project = { ...baseProject, cloud: { enabled: true, workspaceId: 'ws_stored' } };
    const api = stubApi();
    const res = await resolveWorkspace({ project, flag: undefined, rebind: false }, api);
    expect(res).toEqual({ workspaceId: 'ws_stored', action: 'use-stored' });
  });

  it('case (d): neither → creates workspace with project name+id', async () => {
    const api = stubApi();
    const res = await resolveWorkspace({ project: baseProject, flag: undefined, rebind: false }, api);
    expect(api.createWorkspace).toHaveBeenCalledWith({ name: 'Project One', slug: 'p1' });
    expect(res).toEqual({ workspaceId: 'ws_new', action: 'create' });
  });

  it('case (d) with --name/--slug overrides → uses overrides', async () => {
    const api = stubApi();
    await resolveWorkspace(
      { project: baseProject, flag: undefined, rebind: false, nameOverride: 'Custom', slugOverride: 'custom' },
      api,
    );
    expect(api.createWorkspace).toHaveBeenCalledWith({ name: 'Custom', slug: 'custom' });
  });

  it('case (d) slug collision → SlugTakenError surfaces unchanged', async () => {
    const api = stubApi({
      createWorkspace: vi.fn(async () => {
        throw new SlugTakenError('p1');
      }),
    });
    await expect(
      resolveWorkspace({ project: baseProject, flag: undefined, rebind: false }, api),
    ).rejects.toBeInstanceOf(SlugTakenError);
  });

  it('post-resolution probe failure surfaces (404)', async () => {
    const api = stubApi({
      getWorkspace: vi.fn(async () => {
        throw new WorkspaceNotFoundError('ws_flag');
      }),
    });
    await expect(
      resolveWorkspace({ project: baseProject, flag: 'ws_flag', rebind: false }, api),
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });

  it("dryRun + no stored + no flag → 'would-create' WITHOUT calling createWorkspace or getWorkspace", async () => {
    const api = stubApi();
    const res = await resolveWorkspace({ project: baseProject, flag: undefined, rebind: false, dryRun: true }, api);
    expect(res.action).toBe('would-create');
    expect(res.wouldCreate).toEqual({ name: 'Project One', slug: 'p1' });
    expect(res.workspaceId).toContain('would-create');
    expect(api.createWorkspace).not.toHaveBeenCalled();
    expect(api.getWorkspace).not.toHaveBeenCalled();
  });

  it('dryRun + stored → use-stored WITHOUT probe (no getWorkspace call)', async () => {
    const project = { ...baseProject, cloud: { enabled: true, workspaceId: 'ws_stored' } };
    const api = stubApi();
    const res = await resolveWorkspace({ project, flag: undefined, rebind: false, dryRun: true }, api);
    expect(res).toEqual({ workspaceId: 'ws_stored', action: 'use-stored' });
    expect(api.getWorkspace).not.toHaveBeenCalled();
  });
});
