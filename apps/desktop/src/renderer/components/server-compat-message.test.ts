import { describe, it, expect } from 'vitest';
import { ServerCompatState } from '../../shared/ipc-types';
import { compatBannerMessage } from './server-compat-message';

describe('compatBannerMessage', () => {
  it('names the server version when the server is too old', () => {
    expect(
      compatBannerMessage({ state: ServerCompatState.ServerTooOld, serverVersion: '1.0.2', clientVersion: '1.1.0' }),
    ).toBe('Your Coredoc server (v1.0.2) is older than this app supports — ask your admin to upgrade the server.');
  });

  it('omits the version when the server predates the meta endpoint', () => {
    expect(
      compatBannerMessage({ state: ServerCompatState.ServerTooOld, serverVersion: null, clientVersion: '1.1.0' }),
    ).toBe('Your Coredoc server is older than this app supports — ask your admin to upgrade the server.');
  });

  it('tells the user to update the app when the client is too old', () => {
    expect(
      compatBannerMessage({ state: ServerCompatState.ClientTooOld, serverVersion: '3.0.0', clientVersion: '1.1.0' }),
    ).toBe('This app is older than your server supports — update the app.');
  });

  it('says nothing when the versions are compatible', () => {
    expect(
      compatBannerMessage({ state: ServerCompatState.Compatible, serverVersion: '1.1.0', clientVersion: '1.1.0' }),
    ).toBeNull();
  });
});
