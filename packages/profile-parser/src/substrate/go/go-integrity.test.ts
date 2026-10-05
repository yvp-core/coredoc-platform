/**
 * Referential integrity of the Go substrate.
 *
 * On a real sqlc + huma service the validator measured 129 dangling `functions.classId` (methods
 * declared in a sibling file of their struct, and methods on non-struct named types) and 8 dangling
 * `entities.fileId` (DDL entities pointing at `.sql` migrations never emitted as FileNodes), while
 * every db-op stayed unlinked because the SQL named its tables schema-qualified.
 *
 * This fixture reproduces each shape in miniature and asserts a CLEAN, linked graph.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ParsedRepo } from '@coredoc/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkReferentialIntegrity } from '../../integrity/referential-integrity.js';
import { goProvider } from '../../providers/go.js';
import type { GoProfile } from '../../types.js';

const SQL_PATH = 'db/migrations/0001_summaries.sql';

const FILES: Record<string, string> = {
  'go.mod': 'module github.com/acme/calc\n\ngo 1.22\n',

  // The struct lives in consumer.go; a second file of the package adds a method to it.
  'internal/consumer/consumer.go': `package consumer

type Consumer struct{ n int }

func (c *Consumer) Ping() int { return c.n }
`,
  'internal/consumer/dlq.go': `package consumer

func (c *Consumer) sendToDLQ() bool { return true }
`,

  // A method on a NON-struct named type: there is no ClassNode for it to point at.
  'cmd/tool/main.go': `package main

import "strings"

type repeated []string

func (r *repeated) String() string { return strings.Join(*r, ",") }

func main() {}
`,

  // Schema-qualified DDL and SQL — the migrations directory holds no .go file of its own.
  [SQL_PATH]: 'CREATE SCHEMA IF NOT EXISTS calc;\n\nCREATE TABLE calc.daily_summaries (\n  id UUID PRIMARY KEY\n);\n',
  'internal/store/store.go': `package store

import "context"

type Store struct{ db DB }

type DB interface {
	Exec(ctx context.Context, sql string) error
}

func (s *Store) Complete(ctx context.Context) error {
	return s.db.Exec(ctx, "UPDATE calc.daily_summaries SET id = id")
}
`,
};

const PROFILE: GoProfile = {
  parserId: 'integrity',
  repoType: 'backend',
  substrate: { language: 'go', include: ['**/*.go'] },
};

describe('go substrate — referential integrity', () => {
  let root: string;
  let repo: ParsedRepo;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'go-integrity-'));
    for (const [rel, src] of Object.entries(FILES)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, src);
    }
    repo = await goProvider.parse(PROFILE, { repoRoot: root, repoName: 'integrity' });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('reports no dangling references', () => {
    expect(checkReferentialIntegrity(repo).violations).toEqual([]);
  });

  it('points a sibling-file method at the ClassNode minted from the struct`s own file', () => {
    const dlq = repo.functions.find((f) => f.name === 'sendToDLQ');
    const consumer = repo.classes.find((c) => c.name === 'Consumer');
    expect(dlq?.classId).toBe(consumer?.id);
    expect(consumer?.location.filePath).toBe('internal/consumer/consumer.go');
  });

  it('leaves classId unset on a method of a non-struct named type', () => {
    const str = repo.functions.find((f) => f.name === 'String');
    expect(str?.kind).toBe('method');
    expect(str?.classId).toBeUndefined();
  });

  it('emits a FileNode, inside a Package, for the .sql migration its entity points at', () => {
    const sql = repo.files.find((f) => f.path === SQL_PATH);
    expect(sql?.language).toBe('sql');
    expect(repo.packages.map((p) => p.id)).toContain(sql?.packageId);
    expect(repo.entities.find((e) => e.tableName === 'daily_summaries')?.fileId).toBe(sql?.id);
  });

  it('links a schema-qualified db-op to the unqualified DDL entity', () => {
    const entity = repo.entities.find((e) => e.tableName === 'daily_summaries');
    const op = repo.dbOperations.find((o) => o.operation === 'update');
    expect(op?.entityId).toBe(entity?.id);
    expect(op?.entityName).toBe('daily_summaries');
  });
});
