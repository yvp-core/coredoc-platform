/**
 * Tree-release conservation over a WHOLE `parseRubyRepo` run.
 *
 * web-tree-sitter never GCs trees and caps its heap at 2GB, so every `parseRuby`
 * MUST be paired with a `releaseParsedTree` in a `finally`. `ruby-cst.test.ts` pins
 * the choke point itself; this pins the property that matters for the substrate as a
 * whole — a FUTURE `parseRuby` call site added anywhere under `substrate/ruby/`
 * without a release makes this fail, which no per-extractor test can catch.
 *
 * Seam: `parseRuby` gets its parser from the `TreeSitterLoader` singleton, so wrapping
 * `getParser` counts every tree the run creates and every `delete` it performs — no
 * extractor is named here, and a new one is covered the day it is written.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StableIdGenerator } from '@coredoc/core';
import { TreeSitterLoader } from '../../tree-sitter/tree-sitter-loader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractRubyEntities } from './ruby-entities.js';
import { parseRubyRepo } from './ruby-parser.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__/structure-app');

/**
 * Count trees created and deleted for the duration of `run`, by wrapping the parser
 * the Ruby CST helpers ask the loader for. Returns the two counters plus the high-water
 * mark of LIVE trees (`created - released`), which is the number the 2GB cap actually
 * constrains — conservation alone cannot see a pass that holds every file's tree at once.
 */
async function countTrees(run: () => Promise<void>): Promise<{ created: number; released: number; peakLive: number }> {
  const loader = TreeSitterLoader.getInstance();
  const realGetParser = loader.getParser.bind(loader);
  let created = 0;
  let released = 0;
  let peakLive = 0;
  // The loader memoises one Parser per grammar, so the same instance comes back on every call.
  // Patch it once and unpatch it after the run: re-wrapping would nest the counters, and leaving
  // the shadow in place would leak this run's counting into every later test in the process.
  const patched = new Set<object>();

  vi.spyOn(loader, 'getParser').mockImplementation(async (lang) => {
    const parser = await realGetParser(lang);
    if (patched.has(parser)) return parser;
    patched.add(parser);
    const realParse = parser.parse.bind(parser);
    // `parse` is non-writable on the parser prototype, so shadow it with an own
    // property instead of assigning.
    Object.defineProperty(parser, 'parse', {
      configurable: true,
      // biome-ignore lint/suspicious/noExplicitAny: web-tree-sitter types are opaque here
      value: (...args: any[]) => {
        const tree = realParse(...args);
        if (!tree) return tree;
        created++;
        peakLive = Math.max(peakLive, created - released);
        const realDelete = tree.delete.bind(tree);
        Object.defineProperty(tree, 'delete', {
          configurable: true,
          value: () => {
            released++;
            realDelete();
          },
        });
        return tree;
      },
    });
    return parser;
  });

  try {
    await run();
  } finally {
    for (const parser of patched) Reflect.deleteProperty(parser, 'parse');
  }
  return { created, released, peakLive };
}

describe('ruby substrate tree release', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('releases every tree it parses across a full parseRubyRepo run', async () => {
    const { created, released } = await countTrees(async () => {
      await parseRubyRepo(FIXTURE, 'structure-app', { repoKey: 'structure-app' });
    });

    // The fixture must actually exercise the parser, or conservation is vacuous.
    expect(created).toBeGreaterThan(0);
    expect(released).toBe(created);
  }, 60_000);

  // Conservation is not enough: a pass that parses every file and only frees the trees at the end
  // conserves perfectly while holding N trees live, which is what the 2GB cap kills (the Ruby
  // entity lane did exactly that across its two passes). The bound that matters is the HIGH-WATER
  // mark — one tree at a time, freed before the next parse.
  it('never holds more than one tree live at a time (peak liveness, not just conservation)', async () => {
    const { created, peakLive } = await countTrees(async () => {
      await parseRubyRepo(FIXTURE, 'structure-app', { repoKey: 'structure-app' });
    });

    expect(created).toBeGreaterThan(1); // several files, or the bound is trivially met
    expect(peakLive).toBe(1);
  }, 60_000);

  // The entity lane is the pass that regressed: its Pass B read each model's `classNode` after the
  // Pass-A loop had ended, so every `app/models/**` tree stayed resident. It is only reached with an
  // entities profile, and only bites with MORE THAN ONE model file — the repo-wide run above cannot
  // see it on a single-model fixture.
  it('holds one model tree at a time across the entity lane two passes', async () => {
    const idGen = new StableIdGenerator('/repo', 'repo');
    const modelFiles = ['Alpha', 'Beta', 'Gamma'].map((name) => ({
      relPath: `app/models/${name.toLowerCase()}.rb`,
      source: `class ${name} < ApplicationRecord\n  has_many :widgets\nend\n`,
    }));

    let entityCount = 0;
    const { created, released, peakLive } = await countTrees(async () => {
      const res = await extractRubyEntities(modelFiles, new Map(), {
        idGen,
        baseClasses: ['ApplicationRecord'],
        orm: 'activerecord',
      });
      entityCount = res.entities.length;
    });

    // Pass B must still produce every model — releasing early must not cost output.
    expect(entityCount).toBe(3);
    expect(created).toBe(3);
    expect(released).toBe(3);
    expect(peakLive).toBe(1);
  }, 60_000);
});
