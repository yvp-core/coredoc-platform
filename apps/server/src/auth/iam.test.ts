import { describe, expect, it } from 'vitest';
import { can } from './iam.js';

const onWorkspace = (role: string) => ({ role, resourceType: 'workspace', resourceId: 'ws-1' });
const onRepo = (role: string, key: string) => ({ role, resourceType: 'repo', resourceId: key });
const open = { type: 'repo', id: 'api', restricted: false } as const;
const closed = { type: 'repo', id: 'calc', restricted: true } as const;

describe('can', () => {
  it('lets a workspace binding reach an open repo but not a restricted one', () => {
    expect(can([onWorkspace('member')], 'graph.read', open)).toBe(true);
    expect(can([onWorkspace('member')], 'graph.read', closed)).toBe(false);
  });

  it('lets a binding on the restricted repo itself reach it, and only it', () => {
    const grants = [onWorkspace('member'), onRepo('member', 'calc')];
    expect(can(grants, 'graph.read', closed)).toBe(true);
    expect(can([onRepo('member', 'other')], 'graph.read', closed)).toBe(false);
  });

  it('lets workspace managers read a restricted repo', () => {
    expect(can([onWorkspace('admin')], 'graph.read', closed)).toBe(true);
  });

  it('never turns a role on a repo into rights on the workspace', () => {
    expect(can([onRepo('admin', 'calc')], 'workspace.manage', { type: 'workspace' })).toBe(false);
  });

  it('keeps support out of every repo except one it is bound to', () => {
    expect(can([onWorkspace('support')], 'workspace.read', { type: 'workspace' })).toBe(true);
    expect(can([onWorkspace('support')], 'graph.read', open)).toBe(false);
    expect(can([onWorkspace('support'), onRepo('member', 'api')], 'graph.read', open)).toBe(true);
  });

  it('allows nothing to a role it does not know', () => {
    expect(can([onWorkspace('intern')], 'workspace.read', { type: 'workspace' })).toBe(false);
  });
});
