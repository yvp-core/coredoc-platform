import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IpcChannels } from '../shared/ipc-types';
import { registerSettingsHandlers } from './settings-manager';

const fixtureDirs: string[] = [];

afterEach(() => {
  for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('settings IPC', () => {
  it('returns masked settings and applies validated updates without returning a secret', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'coredoc-settings-ipc-'));
    fixtureDirs.push(dir);
    const envPath = path.join(dir, '.env');
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle(channel: string, handler: (...args: unknown[]) => unknown) {
        handlers.set(channel, handler);
      },
    };

    registerSettingsHandlers(ipcMain as never, () => envPath);

    const update = handlers.get(IpcChannels.SETTINGS_UPDATE_HARNESS);
    const get = handlers.get(IpcChannels.SETTINGS_GET_HARNESS);
    expect(update).toBeDefined();
    expect(get).toBeDefined();

    expect(
      await update?.(
        {},
        {
          provider: 'codex',
          authMode: 'api-token',
          credential: { provider: 'codex', value: 'codex-secret-12345678' },
        },
      ),
    ).toEqual({ success: true });
    expect(await get?.({})).toEqual({
      provider: 'codex',
      authMode: 'api-token',
      credentials: {
        'claude-code': { isSet: false },
        codex: { isSet: true, maskedValue: '••••••••12345678' },
      },
    });
  });
});
