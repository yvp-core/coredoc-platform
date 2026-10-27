/**
 * Abstract base entities own no table: MikroORM's `@Entity({ abstract: true })` and TypeORM's
 * `@Entity()` on an `abstract class` exist only to share columns. They are not emitted as entities,
 * and each concrete subclass carries the columns it inherits from them.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ParsedRepo } from '@coredoc/core/types';
import type { ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const profile = (orm: 'mikro-orm' | 'typeorm', fieldDecorators: string[], pk: string): ExtractionProfile =>
  ({
    parserId: 'test-abstract-entities',
    substrate: { language: 'ts', include: ['**/*.ts'], exclude: ['**/node_modules/**'] },
    entities: [
      {
        orm,
        detect: { via: 'class-decorator', name: 'Entity' },
        tableName: { fallback: 'snake_case' },
        fields: { decorators: fieldDecorators, pk },
        relations: { decorators: {}, target: { arg: 0, as: 'arrow-target' } },
      },
    ],
  }) as ExtractionProfile;

const parse = async (p: ExtractionProfile, files: Record<string, string>): Promise<ParsedRepo> => {
  dir = mkdtempSync(join(tmpdir(), 'pp-abstract-entities-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
  return (await runProfile(p, dir, 'abstract-entities')).repo;
};

const fieldNames = (repo: ParsedRepo, entity: string) =>
  repo.entities
    .find((e) => e.name === entity)
    ?.fields.map((f) => f.name)
    .sort();

describe('abstract base entities', () => {
  it('skips a MikroORM `abstract: true` base; the subclass keeps its inherited fields', async () => {
    const repo = await parse(profile('mikro-orm', ['Property', 'PrimaryKey'], 'PrimaryKey'), {
      'base.entity.ts': `import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ abstract: true })
export abstract class AcmeBase {
  @PrimaryKey() id!: string;
  @Property() createdAt = new Date();
}
`,
      'widget.entity.ts': `import { Entity, Property } from '@mikro-orm/core';
import { AcmeBase } from './base.entity';

@Entity()
export class Widget extends AcmeBase {
  @Property() label!: string;
}
`,
    });

    expect(repo.entities.map((e) => e.name)).toEqual(['Widget']);
    expect(fieldNames(repo, 'Widget')).toEqual(['createdAt', 'id', 'label']);
    expect(repo.entities[0].fields.find((f) => f.name === 'id')?.isPrimaryKey).toBe(true);
  });

  it('skips a TypeORM `@Entity()` on an abstract class through a multi-level chain', async () => {
    const repo = await parse(profile('typeorm', ['Column', 'PrimaryGeneratedColumn'], 'PrimaryGeneratedColumn'), {
      'entities.ts': `import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
export abstract class Root {
  @PrimaryGeneratedColumn() id!: number;
}

@Entity()
export abstract class Audited extends Root {
  @Column() updatedAt!: Date;
}

@Entity()
export class Grant extends Audited {
  @Column() title!: string;
}
`,
    });

    expect(repo.entities.map((e) => e.name)).toEqual(['Grant']);
    expect(fieldNames(repo, 'Grant')).toEqual(['id', 'title', 'updatedAt']);
  });

  it('keeps an abstract single-table-inheritance root, which owns the table', async () => {
    const typeorm = await parse(profile('typeorm', ['Column', 'PrimaryGeneratedColumn'], 'PrimaryGeneratedColumn'), {
      'entities.ts': `import { ChildEntity, Column, Entity, PrimaryGeneratedColumn, TableInheritance } from 'typeorm';

@Entity()
@TableInheritance({ column: { type: 'varchar', name: 'kind' } })
export abstract class Widget {
  @PrimaryGeneratedColumn() id!: number;
}

@ChildEntity()
export class Gadget extends Widget {
  @Column() size!: number;
}
`,
    });
    expect(typeorm.entities.map((e) => e.name)).toEqual(['Widget']);

    const mikro = await parse(profile('mikro-orm', ['Property', 'PrimaryKey'], 'PrimaryKey'), {
      'entities.ts': `import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ abstract: true, discriminatorColumn: 'kind', discriminatorMap: { gadget: 'Gadget' } })
export abstract class Widget {
  @PrimaryKey() id!: string;
}

@Entity()
export class Gadget extends Widget {
  @Property() size!: number;
}
`,
    });
    expect(mikro.entities.map((e) => e.name).sort()).toEqual(['Gadget', 'Widget']);
  });

  it('still emits a concrete entity whose body merely mentions "abstract"', async () => {
    const repo = await parse(profile('typeorm', ['Column', 'PrimaryGeneratedColumn'], 'PrimaryGeneratedColumn'), {
      'article.entity.ts': `import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
export class Article {
  @PrimaryGeneratedColumn() id!: number;
  @Column() abstract!: string;
}
`,
    });

    expect(repo.entities.map((e) => e.name)).toEqual(['Article']);
  });
});
