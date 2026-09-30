import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteDriver } from './driver.js';
import { SqliteOperationsRepository } from './operations-repository.js';

let tmp: string;
let driver: SqliteDriver;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ops-repo-'));
  driver = new SqliteDriver(`file:${join(tmp, 'test.db')}`);
  await driver.initialize();
});

afterEach(async () => {
  await driver.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('SqliteOperationsRepository', () => {
  it('isolates operations across projects with the same repo name', async () => {
    const repo = new SqliteOperationsRepository(driver);

    const id1 = await repo.startOperation('alpha', 'svc-a', 'parse');
    await repo.completeOperation(id1, { files: 100 });

    const id2 = await repo.startOperation('beta', 'svc-a', 'parse');
    await repo.completeOperation(id2, { files: 200 });

    const alphaSummary = await repo.getOperationSummary('alpha', 'svc-a');
    const betaSummary = await repo.getOperationSummary('beta', 'svc-a');

    expect(alphaSummary.lastParsed?.metadata).toMatchObject({ files: 100 });
    expect(betaSummary.lastParsed?.metadata).toMatchObject({ files: 200 });
    expect(alphaSummary.lastParsed?.id).not.toBe(betaSummary.lastParsed?.id);
  });
});
