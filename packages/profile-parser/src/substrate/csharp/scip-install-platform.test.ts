import { afterEach, expect, it, vi } from 'vitest';
import { installCSharpTool } from './scip-install.js';
const { exists } = vi.hoisted(() => ({ exists: vi.fn() }));
vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()), existsSync: exists }));
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.clearAllMocks();
});
it('refuses Windows before downloading or inspecting a source repository', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  await expect(installCSharpTool()).rejects.toThrow('Use basic analysis here');
  expect(exists).not.toHaveBeenCalled();
});
it('refuses the Alpine channel before downloading', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  exists.mockImplementation((path) => path === '/etc/alpine-release');
  await expect(installCSharpTool()).rejects.toThrow('Alpine CLI image supports C# basic');
});
