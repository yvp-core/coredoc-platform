/**
 * SQLite Operations Repository
 *
 * Tracks CLI operation history (parse, summarize, push, etc.) per
 * (projectId, repoName).
 */

import { randomBytes } from 'crypto';
import type {
  IDatabaseDriver,
  IOperationsRepository,
  OperationType,
  OperationRecord,
  OperationSummary,
} from '../types.js';

const OPERATION_TO_SUMMARY_KEY: Record<string, keyof Omit<OperationSummary, 'projectId' | 'repoName'>> = {
  parse: 'lastParsed',
  summarize: 'lastSummarized',
  push: 'lastPushed',
  generate: 'lastGenerated',
  docs: 'lastDocs',
};

function generateOperationId(): string {
  const ts = Date.now();
  const rand = randomBytes(4).toString('hex');
  return `op-${ts}-${rand}`;
}

function rowToRecord(row: Record<string, unknown>): OperationRecord {
  return {
    id: row.id as string,
    projectId: (row.project_id as string) ?? '',
    repoName: row.repo_name as string,
    operation: row.operation as OperationType,
    status: row.status as OperationRecord['status'],
    startedAt: row.started_at as number,
    completedAt: row.completed_at as number | undefined,
    durationMs: row.duration_ms as number | undefined,
    metadata: JSON.parse((row.metadata as string) || '{}'),
  };
}

export class SqliteOperationsRepository implements IOperationsRepository {
  constructor(private driver: IDatabaseDriver) {}

  async startOperation(
    projectId: string,
    repoName: string,
    operation: OperationType,
    metadata: Record<string, unknown> = {},
  ): Promise<string> {
    const id = generateOperationId();
    const now = Date.now();

    await this.driver.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO operations (id, project_id, repo_name, operation, status, started_at, metadata)
         VALUES (@id, @projectId, @repoName, @operation, 'started', @startedAt, @metadata)`,
        {
          id,
          projectId,
          repoName,
          operation,
          startedAt: now,
          metadata: JSON.stringify(metadata),
        },
      );
    });

    return id;
  }

  async completeOperation(id: string, metadata: Record<string, unknown> = {}): Promise<void> {
    await this.driver.withWriteTransaction(async (tx) => {
      const rows = await tx.run<{ metadata: string; started_at: number }>(
        `SELECT metadata, started_at FROM operations WHERE id = @id`,
        { id },
      );
      if (rows.length === 0) return;

      const existing = JSON.parse(rows[0].metadata || '{}');
      const merged = { ...existing, ...metadata };
      const now = Date.now();
      const durationMs = now - rows[0].started_at;

      await tx.run(
        `UPDATE operations SET status = 'completed', completed_at = @completedAt, duration_ms = @durationMs, metadata = @metadata WHERE id = @id`,
        {
          id,
          completedAt: now,
          durationMs,
          metadata: JSON.stringify(merged),
        },
      );
    });
  }

  async failOperation(id: string, error: string, metadata: Record<string, unknown> = {}): Promise<void> {
    await this.driver.withWriteTransaction(async (tx) => {
      const rows = await tx.run<{ metadata: string; started_at: number }>(
        `SELECT metadata, started_at FROM operations WHERE id = @id`,
        { id },
      );
      if (rows.length === 0) return;

      const existing = JSON.parse(rows[0].metadata || '{}');
      const merged = { ...existing, ...metadata, error };
      const now = Date.now();
      const durationMs = now - rows[0].started_at;

      await tx.run(
        `UPDATE operations SET status = 'failed', completed_at = @completedAt, duration_ms = @durationMs, metadata = @metadata WHERE id = @id`,
        {
          id,
          completedAt: now,
          durationMs,
          metadata: JSON.stringify(merged),
        },
      );
    });
  }

  async getOperationSummary(projectId: string, repoName: string): Promise<OperationSummary> {
    const summary: OperationSummary = { projectId, repoName };

    const rows = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<Record<string, unknown>>(
        `SELECT o.*
         FROM operations o
         INNER JOIN (
           SELECT operation, MAX(started_at) as max_started
           FROM operations
           WHERE project_id = @projectId AND repo_name = @repoName AND status = 'completed'
           GROUP BY operation
         ) latest ON o.operation = latest.operation AND o.started_at = latest.max_started
         WHERE o.project_id = @projectId AND o.repo_name = @repoName AND o.status = 'completed'`,
        { projectId, repoName },
      );
    });

    for (const row of rows) {
      const record = rowToRecord(row);
      const key = OPERATION_TO_SUMMARY_KEY[record.operation];
      if (key) {
        (summary as unknown as Record<string, unknown>)[key] = record;
      }
    }

    return summary;
  }

  async getOperationHistory(
    projectId: string,
    repoName: string,
    operation?: OperationType,
    limit: number = 50,
  ): Promise<OperationRecord[]> {
    return this.driver.withReadTransaction(async (tx) => {
      const query = operation
        ? `SELECT * FROM operations WHERE project_id = @projectId AND repo_name = @repoName AND operation = @operation ORDER BY started_at DESC LIMIT @limit`
        : `SELECT * FROM operations WHERE project_id = @projectId AND repo_name = @repoName ORDER BY started_at DESC LIMIT @limit`;

      const params: Record<string, unknown> = { projectId, repoName, limit };
      if (operation) params.operation = operation;

      const rows = await tx.run<Record<string, unknown>>(query, params);
      return rows.map(rowToRecord);
    });
  }

  async getLatestOperation(
    projectId: string,
    repoName: string,
    operation: OperationType,
  ): Promise<OperationRecord | null> {
    return this.driver.withReadTransaction(async (tx) => {
      const rows = await tx.run<Record<string, unknown>>(
        `SELECT * FROM operations WHERE project_id = @projectId AND repo_name = @repoName AND operation = @operation AND status = 'completed' ORDER BY started_at DESC LIMIT 1`,
        { projectId, repoName, operation },
      );
      return rows.length > 0 ? rowToRecord(rows[0]) : null;
    });
  }

  async getAllOperationSummaries(): Promise<OperationSummary[]> {
    const refs = await this.driver.withReadTransaction(async (tx) => {
      const rows = await tx.run<{ project_id: string; repo_name: string }>(
        `SELECT DISTINCT project_id, repo_name FROM operations ORDER BY project_id, repo_name`,
      );
      return rows.map((r) => ({ projectId: r.project_id ?? '', repoName: r.repo_name }));
    });

    const summaries: OperationSummary[] = [];
    for (const { projectId, repoName } of refs) {
      summaries.push(await this.getOperationSummary(projectId, repoName));
    }
    return summaries;
  }
}
