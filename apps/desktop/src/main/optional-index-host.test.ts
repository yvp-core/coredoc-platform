import { expect, it, vi } from 'vitest';
import { prepareDesktopOptionalIndex } from './optional-index-host.js';
import { prepareDesktopCompilerIndex, type CompilerHostOptions } from './compiler-index-host.js';
vi.mock('./compiler-index-host.js', () => ({ prepareDesktopCompilerIndex: vi.fn(async () => ({ basic: true })) }));

it.each([
  'ruby',
  'python',
  'go',
  'rust',
])('only forwards the validated %s request to the consented compiler host', async (language) => {
  const options = {} as CompilerHostOptions;
  await expect(
    prepareDesktopOptionalIndex({ language, fallback: true, command: 'untrusted', repoRoot: '/untrusted' }, options),
  ).resolves.toEqual({ basic: true });
  expect(prepareDesktopCompilerIndex).toHaveBeenLastCalledWith(
    { language, fallback: true },
    options,
    expect.objectContaining({ childScript: expect.stringContaining('sdk-optional-index-child.js') }),
  );
  if (language === 'rust')
    expect(vi.mocked(prepareDesktopCompilerIndex).mock.calls.at(-1)?.[2].notice).toContain('build scripts');
});
it('rejects unsupported languages and invalid fallback policies before consent or spawning', async () => {
  vi.mocked(prepareDesktopCompilerIndex).mockClear();
  for (const request of [{ language: 'shell', fallback: true }, { language: 'ruby', fallback: 'yes' }, null])
    await expect(prepareDesktopOptionalIndex(request, {} as CompilerHostOptions)).rejects.toThrow(/Invalid optional/);
  expect(prepareDesktopCompilerIndex).not.toHaveBeenCalled();
});
