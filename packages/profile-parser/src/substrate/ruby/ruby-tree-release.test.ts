/**
 * Tree-release conservation over a WHOLE Ruby provider parse.
 *
 * web-tree-sitter never GCs trees and caps its heap at 2GB, so every Ruby parse
 * MUST be paired with a `releaseParsedTree` in a `finally`. `ruby-cst.test.ts` pins
 * the choke point itself; this pins the property that matters for the substrate as a
 * whole — a FUTURE Ruby parse site added anywhere under `substrate/ruby/`
 * without a release makes this fail, which no per-extractor test can catch.
 *
 * Seam: `parseSource` gets its parser from the `TreeSitterLoader` singleton, so wrapping
 * `getParser` counts every tree the run creates and every `delete` it performs — no
 * extractor is named here, and a new one is covered the day it is written.
 */
import { rubyProvider } from '../../providers/ruby.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StableIdGenerator } from '@coredoc/core';
import { countTrees } from '../../tree-sitter/__fixtures__/count-trees.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RubyProfile } from '../../types/ruby-profile.js';
import { extractRubyEntities } from './ruby-entities.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__/structure-app');
const PROFILE: RubyProfile = { parserId: 'ruby-test', substrate: { language: 'ruby', include: [] } };

describe('ruby substrate tree release', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('releases every tree it parses across a full Ruby provider parse', async () => {
    const { created, released } = await countTrees(async () => {
      await rubyProvider.parse(PROFILE, { repoRoot: FIXTURE, repoName: 'structure-app', repoKey: 'structure-app' });
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
      await rubyProvider.parse(PROFILE, { repoRoot: FIXTURE, repoName: 'structure-app', repoKey: 'structure-app' });
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
