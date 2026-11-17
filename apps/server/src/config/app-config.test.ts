import { describe, expect, it } from 'vitest';
import { AppConfigError, loadAppConfig } from './app-config.js';

/** A valid API-role environment, to be narrowed per case. */
const API_ENV: NodeJS.ProcessEnv = {
  OAUTH_JWT_SECRET: 'test-only-secret-that-is-at-least-32-characters',
};

describe('loadAppConfig — requiredness', () => {
  it('names the missing variable when the api role has no OAUTH_JWT_SECRET', () => {
    expect(() => loadAppConfig({}, 'api')).toThrow(AppConfigError);
    expect(() => loadAppConfig({}, 'api')).toThrow(/OAUTH_JWT_SECRET/);
  });

  it('names the variable when it is present but too short for the signer', () => {
    expect(() => loadAppConfig({ OAUTH_JWT_SECRET: 'short' }, 'api')).toThrow(
      /OAUTH_JWT_SECRET: must be at least 32 characters/,
    );
  });

  it('reports one line per bad variable', () => {
    try {
      loadAppConfig({}, 'api');
      expect.unreachable('expected a config error');
    } catch (error) {
      expect(error).toBeInstanceOf(AppConfigError);
      const lines = (error as AppConfigError).lines;
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^OAUTH_JWT_SECRET: /);
    }
  });
});

describe('loadAppConfig — role refinement', () => {
  it('boots a worker with none of the web-auth group set', () => {
    const config = loadAppConfig({}, 'worker');
    expect(config.role).toBe('worker');
    expect(config.auth.jwtSecret).toBe('');
  });

  it('applies the api requirements to the default all role', () => {
    expect(() => loadAppConfig({}, 'all')).toThrow(/OAUTH_JWT_SECRET/);
    expect(loadAppConfig(API_ENV, 'all').role).toBe('all');
  });

  it('takes the role from PROCESS_ROLE when the caller does not pass one', () => {
    expect(loadAppConfig({ PROCESS_ROLE: 'worker' }).role).toBe('worker');
    expect(() => loadAppConfig({ PROCESS_ROLE: 'api' })).toThrow(/OAUTH_JWT_SECRET/);
    expect(() => loadAppConfig({ PROCESS_ROLE: 'nonsense' })).toThrow(/PROCESS_ROLE/);
  });
});

describe('loadAppConfig — storage defaults keep their former literals', () => {
  const storage = loadAppConfig({}, 'worker').storage;

  it('R2_BUCKET defaults to the literal from r2-storage.service.ts', () => {
    expect(storage.r2.bucket).toBe('coredoc-parsers');
    expect(loadAppConfig({ R2_BUCKET: 'other' }, 'worker').storage.r2.bucket).toBe('other');
  });

  it('R2_REGION defaults to the literal from r2-storage.service.ts', () => {
    expect(storage.r2.region).toBe('auto');
    expect(loadAppConfig({ R2_REGION: 'us-east1' }, 'worker').storage.r2.region).toBe('us-east1');
  });

  it('COREDOC_DB_BACKEND defaults to the empty string', () => {
    expect(storage.dbBackend).toBe('');
  });

  it('leaves every optional storage variable unset rather than inventing a value', () => {
    expect(storage.r2.endpoint).toBeUndefined();
    expect(storage.r2.accessKeyId).toBeUndefined();
    expect(storage.r2.secretAccessKey).toBeUndefined();
    expect(storage.graphFile.cacheDir).toBeUndefined();
    expect(storage.graphSnapshot.buildRoot).toBeUndefined();
    expect(storage.fileSnapshotSyncTimeoutMs).toBeUndefined();
  });
});

describe('loadAppConfig — exact-literal flags', () => {
  const flag = (value: string | undefined) =>
    loadAppConfig(value === undefined ? {} : { COREDOC_ALLOW_CYPHER: value }, 'worker').storage.allowCypher;

  it.each([undefined, '', 'TRUE', ' true ', '1', 'yes', 'anything'])('is off for %j', (value) => {
    expect(flag(value)).toBe(false);
  });

  it('is on only for the literal "true"', () => {
    expect(flag('true')).toBe(true);
  });

  it('R2_FORCE_PATH_STYLE is on only for the literal "true"', () => {
    expect(loadAppConfig({ R2_FORCE_PATH_STYLE: 'TRUE' }, 'worker').storage.r2.forcePathStyle).toBe(false);
    expect(loadAppConfig({ R2_FORCE_PATH_STYLE: 'true' }, 'worker').storage.r2.forcePathStyle).toBe(true);
  });
});

describe('loadAppConfig — auth defaults keep their former literals', () => {
  const auth = loadAppConfig({}, 'worker').auth;

  it('OAUTH_ACCESS_TTL / OAUTH_REFRESH_TTL default to the oauth.module.ts literals', () => {
    expect(auth.accessTtl).toBe('1d');
    expect(auth.refreshTtl).toBe('30d');
  });

  it('GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET and WEB_ORIGINS default to the empty string', () => {
    expect(auth.githubClientId).toBe('');
    expect(auth.githubClientSecret).toBe('');
    expect(auth.webOrigins).toBe('');
  });

  it('leaves SERVER_URL unset so server-url.ts still owns its http://localhost:3000 fallback', () => {
    expect(auth.serverUrl).toBeUndefined();
    expect(auth.mcpServerUrl).toBeUndefined();
  });

  it('keeps SERVER_ENCRYPTION_KEY optional — an absent key degrades, it does not fail boot', () => {
    expect(auth.serverEncryptionKey).toBeUndefined();
    expect(() => loadAppConfig(API_ENV, 'api')).not.toThrow();
  });

  it('normalizes OAUTH_UPSTREAM once, and reads the on-prem empty value as unset', () => {
    // An on-prem `OAUTH_UPSTREAM=` yields '' from dotenv/compose; resolveUpstream
    // reads an empty upstream as github, which is what keeps that install booting.
    expect(loadAppConfig({ OAUTH_UPSTREAM: '' }, 'worker').auth.upstream).toBe('');
    expect(loadAppConfig({ OAUTH_UPSTREAM: '  WorkOS ' }, 'worker').auth.upstream).toBe('workos');
  });

  it('leaves the WorkOS credentials raw for the sites that trim and name them', () => {
    const workos = loadAppConfig({ WORKOS_CLIENT_ID: '  id  ' }, 'worker').auth.workos;
    expect(workos.clientId).toBe('  id  ');
    expect(workos.authkitDomain).toBeUndefined();
  });
});

describe('loadAppConfig — workers, retention and connectors stay raw', () => {
  it('hands the retention kill-switches through untouched, so libs/retention.ts keeps deciding', () => {
    const retention = loadAppConfig(
      {
        MCP_METRICS_RETENTION_ENABLED: '0',
        CAPTURE_FINE_RETENTION_ENABLED: ' true ',
        INTENT_MUTATION_RETENTION_ENABLED: 'FALSE',
        DELIVERY_SYNC_ENABLED: 'false',
        DELIVERY_RAW_RETENTION_DAYS: '0',
      },
      'worker',
    ).workers.retention;
    // No trim, no case-fold, no coercion — see libs/retention.ts.
    expect(retention.mcpMetricsEnabled).toBe('0');
    expect(retention.captureFineEnabled).toBe(' true ');
    expect(retention.intentMutationEnabled).toBe('FALSE');
    expect(retention.deliverySyncEnabled).toBe('false');
    expect(retention.deliveryRawDays).toBe('0');
  });

  it('keeps PUSH_WORKER_ENABLED a raw string so only the literal "false" stops the worker', () => {
    expect(loadAppConfig({ PUSH_WORKER_ENABLED: 'FALSE' }, 'worker').workers.pushWorkerEnabled).toBe('FALSE');
    expect(loadAppConfig({}, 'worker').workers.pushWorkerEnabled).toBeUndefined();
  });

  it('leaves the connector tokens unset rather than empty strings', () => {
    const connectors = loadAppConfig({}, 'worker').connectors;
    expect(connectors.githubToken).toBeUndefined();
    expect(connectors.gitlabToken).toBeUndefined();
  });
});

describe('loadAppConfig — INTENT_ROLES (temporary intent rollout)', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['blank entries only', ' , ,'],
  ])("keeps today's behaviour when %s: no rollout list", (_name, value) => {
    const env: NodeJS.ProcessEnv = value === undefined ? {} : { INTENT_ROLES: value };
    expect(loadAppConfig(env, 'worker').intent).toEqual({});
  });

  it('parses a comma-separated list, trimming entries and dropping blanks and repeats', () => {
    const intent = loadAppConfig({ INTENT_ROLES: ' owner, admin ,,product,admin' }, 'worker').intent;
    expect(intent.rolloutRoles).toEqual(['owner', 'admin', 'product']);
  });

  it('accepts every workspace member role', () => {
    const intent = loadAppConfig({ INTENT_ROLES: 'owner,admin,product,member' }, 'worker').intent;
    expect(intent.rolloutRoles).toEqual(['owner', 'admin', 'product', 'member']);
  });

  it('fails fast on an unknown role, naming the variable and the offending entries', () => {
    try {
      loadAppConfig({ ...API_ENV, INTENT_ROLES: 'owner,developer,Admin' }, 'api');
      expect.unreachable('expected a config error');
    } catch (error) {
      expect(error).toBeInstanceOf(AppConfigError);
      const lines = (error as AppConfigError).lines;
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^INTENT_ROLES: unknown workspace role 'developer', 'Admin'; /);
      expect(lines[0]).toContain('owner, admin, member, product');
    }
  });

  it('fails fast for the worker role too — a bad value is a bad value in every process', () => {
    expect(() => loadAppConfig({ INTENT_ROLES: 'developers' }, 'worker')).toThrow(AppConfigError);
  });
});

describe('loadAppConfig — Google for agent runs', () => {
  const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nMIItest\n-----END PRIVATE KEY-----\n';
  const KEY = JSON.stringify({
    type: 'service_account',
    client_email: 'agent@example.iam.gserviceaccount.com',
    private_key: PRIVATE_KEY,
  });
  const GOOGLE_ENV = {
    AGENT_GOOGLE_SERVICE_ACCOUNT_KEY: KEY,
    AGENT_GOOGLE_SHARED_DRIVE_ID: 'drive-0001',
    AGENT_GOOGLE_WORKSPACE_ID: 'ws-1',
  };

  it('is off with none of the three variables and on with all of them', () => {
    expect(loadAppConfig({}, 'worker').connectors.agentGoogle).toBeUndefined();
    expect(loadAppConfig({ ...API_ENV, ...GOOGLE_ENV }, 'api').connectors.agentGoogle).toEqual({
      serviceAccount: { clientEmail: 'agent@example.iam.gserviceaccount.com', privateKey: PRIVATE_KEY },
      sharedDriveId: 'drive-0001',
      workspaceId: 'ws-1',
    });
  });

  it.each([
    ['only the key', { AGENT_GOOGLE_SERVICE_ACCOUNT_KEY: KEY }, ['SHARED_DRIVE_ID', 'WORKSPACE_ID']],
    ['no workspace', { ...GOOGLE_ENV, AGENT_GOOGLE_WORKSPACE_ID: undefined }, ['WORKSPACE_ID']],
    ['a blank drive id', { ...GOOGLE_ENV, AGENT_GOOGLE_SHARED_DRIVE_ID: ' ' }, ['SHARED_DRIVE_ID']],
    ['no key', { ...GOOGLE_ENV, AGENT_GOOGLE_SERVICE_ACCOUNT_KEY: undefined }, ['SERVICE_ACCOUNT_KEY']],
    [
      'a key that is not JSON',
      { ...GOOGLE_ENV, AGENT_GOOGLE_SERVICE_ACCOUNT_KEY: PRIVATE_KEY },
      ['SERVICE_ACCOUNT_KEY'],
    ],
    [
      'a key without a private key',
      { ...GOOGLE_ENV, AGENT_GOOGLE_SERVICE_ACCOUNT_KEY: JSON.stringify({ client_email: 'agent@example.com' }) },
      ['SERVICE_ACCOUNT_KEY'],
    ],
    [
      'an OAuth client file instead of a service account key',
      { ...GOOGLE_ENV, AGENT_GOOGLE_SERVICE_ACCOUNT_KEY: JSON.stringify({ web: { client_id: 'x' } }) },
      ['SERVICE_ACCOUNT_KEY'],
    ],
  ])('refuses %s in every role, naming the variable and never the key', (_case, env, named) => {
    for (const role of ['api', 'worker'] as const) {
      try {
        loadAppConfig({ ...API_ENV, ...env }, role);
        expect.unreachable('expected a config error');
      } catch (error) {
        expect(error).toBeInstanceOf(AppConfigError);
        const { lines, message } = error as AppConfigError;
        expect(lines.map((line) => line.split(':')[0])).toEqual(named.map((name) => `AGENT_GOOGLE_${name}`));
        expect(message).not.toContain('MIItest');
      }
    }
  });
});

describe('loadAppConfig — purity', () => {
  it('does not write anything back into the environment it was handed', () => {
    const env: NodeJS.ProcessEnv = { ...API_ENV };
    const before = JSON.stringify(env);
    loadAppConfig(env, 'api');
    expect(JSON.stringify(env)).toBe(before);
  });
});
