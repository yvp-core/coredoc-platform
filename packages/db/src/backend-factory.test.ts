import { describe, expect, it, vi } from 'vitest';
import { registerExitHandlers } from './backend-factory.js';

describe('registerExitHandlers', () => {
  it('registers one-shot signal handlers before re-sending the signal', async () => {
    const handlers = new Map<string, () => unknown>();
    const onceSpy = vi.spyOn(process, 'once').mockImplementation(((
      event: string | symbol,
      listener: (...args: unknown[]) => unknown,
    ) => {
      handlers.set(String(event), listener);
      return process;
    }) as typeof process.once);
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

    registerExitHandlers();

    expect(onceSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(onceSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(onceSpy).toHaveBeenCalledWith('beforeExit', expect.any(Function));

    await handlers.get('SIGINT')?.();
    expect(killSpy).toHaveBeenCalledOnce();
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGINT');

    onceSpy.mockRestore();
    killSpy.mockRestore();
  });
});
