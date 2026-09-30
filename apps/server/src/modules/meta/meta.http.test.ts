import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ROOT_ROUTES } from '../../libs/spa-serving.js';
import { MetaModule } from './meta.module.js';
import { MIN_CLIENT_VERSION, SERVER_VERSION } from './server-version.js';
import { versionHeaderMiddleware } from './version-header.middleware.js';

/**
 * HTTP-level proof of the handshake contract clients depend on: the route is
 * reachable unauthenticated under the global prefix, and the version header is
 * on responses that never reach a controller. Mirrors bootstrap's arrangement
 * (version middleware first, then setGlobalPrefix with ROOT_ROUTES excluded).
 */
describe('GET /api/v1/meta', () => {
  let app: NestExpressApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [MetaModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.use(versionHeaderMiddleware(SERVER_VERSION));
    app.setGlobalPrefix('/api/v1', { exclude: ROOT_ROUTES });
    await app.listen(0, '127.0.0.1');
    const { port } = (app.getHttpServer() as Server).address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    (app.getHttpServer() as Server).closeAllConnections();
    await app.close();
  });

  it('serves the version handshake without authentication', async () => {
    const response = await fetch(`${baseUrl}/api/v1/meta`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: SERVER_VERSION, minClientVersion: MIN_CLIENT_VERSION });
    expect(response.headers.get('x-coredoc-version')).toBe(SERVER_VERSION);
  });

  it('stamps the version header on responses that never reach a controller', async () => {
    const response = await fetch(`${baseUrl}/api/v1/does-not-exist`);

    expect(response.status).toBe(404);
    expect(response.headers.get('x-coredoc-version')).toBe(SERVER_VERSION);
  });
});
