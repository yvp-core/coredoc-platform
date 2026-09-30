import { beforeEach, expect, it, vi } from 'vitest';
import { checkCSharpPrerequisites } from './scip-run.js';
const { findCSharpTool } = vi.hoisted(() => ({ findCSharpTool: vi.fn() }));
vi.mock('./scip-tool.js', () => ({ findCSharpTool }));
beforeEach(() => vi.resetAllMocks());
it('reports missing tools as a user-readable reason and accepts installed tools', () => {
  findCSharpTool.mockImplementationOnce(() => {
    throw new Error('C# enhanced analysis requires a compatible .NET SDK on PATH.');
  });
  expect(checkCSharpPrerequisites('/repo')).toContain('.NET SDK on PATH');
  findCSharpTool.mockReturnValue({ supportsDefines: true });
  expect(checkCSharpPrerequisites('/repo', ['FEATURE'])).toBeUndefined();
});
it('does not advertise enhanced for defines unsupported by the installed indexer', () => {
  findCSharpTool.mockReturnValue({ supportsDefines: false });
  expect(checkCSharpPrerequisites('/repo', ['FEATURE'])).toContain('defines');
  expect(checkCSharpPrerequisites('/repo')).toBeUndefined();
});
