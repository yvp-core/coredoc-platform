import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readValidIntentFixtureJson, readValidIntentFixtureText } from './__fixtures__/load.js';
import { intentPathsForRepo } from './paths.js';
import { IntentValidationCode, validateIntentFile } from './schema.js';
import {
  MAX_INTENT_FILE_BYTES,
  IntentOverlayStatus,
  IntentValidationFailedError,
  readIntentFile,
  serializeIntentFile,
  writeIntentFile,
} from './storage.js';
import { IntentAuthority, IntentKind, IntentSourceKind, type IntentFileV2 } from './types.js';

function validFixture(): IntentFileV2 {
  const result = validateIntentFile(readValidIntentFixtureJson());
  if (!result.ok) throw new Error('fixture is not valid');
  return result.file;
}

let repoRoot: string;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coredoc-intent-'));
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('readIntentFile — distinct overlay states', () => {
  it('reports not_configured for an absent file and never creates it', () => {
    const paths = intentPathsForRepo(repoRoot);
    const result = readIntentFile(paths.intentJson);
    expect(result.status).toBe(IntentOverlayStatus.NotConfigured);
    expect(fs.existsSync(paths.intentJson)).toBe(false);
    expect(fs.existsSync(paths.dir)).toBe(false);
  });

  it('reports invalid with an actionable message for unparseable JSON, without partial load', () => {
    const paths = intentPathsForRepo(repoRoot);
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.intentJson, '{ "schemaVersion": 1, ');
    const result = readIntentFile(paths.intentJson);
    expect(result.status).toBe(IntentOverlayStatus.Invalid);
    if (result.status !== IntentOverlayStatus.Invalid) throw new Error('unreachable');
    expect(result.errors[0]?.code).toBe(IntentValidationCode.Malformed);
    expect(result).not.toHaveProperty('file');
  });

  it('reports invalid with JSON paths for a semantically broken file', () => {
    const paths = intentPathsForRepo(repoRoot);
    const raw = readValidIntentFixtureJson();
    (raw.relations as Record<string, unknown>[])[0] = { from: 'GHOST', type: 'contains', to: 'UC-1' };
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.intentJson, JSON.stringify(raw));
    const result = readIntentFile(paths.intentJson);
    if (result.status !== IntentOverlayStatus.Invalid) throw new Error('expected invalid');
    expect(result.message).toContain('relations[0].from');
  });

  it('reports ready with the parsed model for a valid file', () => {
    const paths = intentPathsForRepo(repoRoot);
    writeIntentFile(paths.intentJson, validFixture());
    const result = readIntentFile(paths.intentJson);
    if (result.status !== IntentOverlayStatus.Ready) throw new Error('expected ready');
    expect(result.file.items).toHaveLength(6);
    expect(result.path).toBe(paths.intentJson);
  });
});

describe('serializeIntentFile — deterministic bytes', () => {
  it('re-serialising an unchanged model is byte-identical', () => {
    const file = validFixture();
    expect(serializeIntentFile(file)).toBe(serializeIntentFile(file));
  });

  it('is independent of key insertion order in the loaded model', () => {
    const file = validFixture();
    const reordered = JSON.parse(
      JSON.stringify({
        relations: file.relations,
        items: file.items,
        domains: file.domains,
        projectId: file.projectId,
        schemaVersion: 2,
      }),
    ) as IntentFileV2;
    expect(serializeIntentFile(reordered)).toBe(serializeIntentFile(file));
  });

  it('produces identical bytes across a write → read → write cycle on disk', () => {
    // The checked-in fixture is authored JSON (Biome formats it); what must be
    // stable is the writer's own output, so a reparse/recapture yields no diff.
    const paths = intentPathsForRepo(repoRoot);
    writeIntentFile(paths.intentJson, validFixture());
    const firstWrite = fs.readFileSync(paths.intentJson, 'utf-8');
    const reread = readIntentFile(paths.intentJson);
    if (reread.status !== IntentOverlayStatus.Ready) throw new Error('expected ready');
    writeIntentFile(paths.intentJson, reread.file);
    expect(fs.readFileSync(paths.intentJson, 'utf-8')).toBe(firstWrite);
    expect(JSON.parse(firstWrite)).toEqual(JSON.parse(readValidIntentFixtureText()));
  });

  it('preserves array order (flow steps are ordered data, not a set)', () => {
    const file = validFixture();
    const serialized = serializeIntentFile(file);
    expect(serialized.indexOf('"s1"')).toBeLessThan(serialized.indexOf('"s2"'));
    expect(serialized.endsWith('\n')).toBe(true);
  });

  it('round-trips through the validator without drift', () => {
    const file = validFixture();
    const reparsed = validateIntentFile(JSON.parse(serializeIntentFile(file)));
    if (!reparsed.ok) throw new Error('round-trip lost validity');
    expect(serializeIntentFile(reparsed.file)).toBe(serializeIntentFile(file));
  });
});

describe('writeIntentFile — validated, atomic, non-destructive on rejection', () => {
  it('creates the .coredoc directory and writes a canonical file', () => {
    const paths = intentPathsForRepo(repoRoot);
    writeIntentFile(paths.intentJson, validFixture());
    expect(fs.readFileSync(paths.intentJson, 'utf-8')).toBe(serializeIntentFile(validFixture()));
  });

  it('refuses an invalid model and leaves the previous valid file intact', () => {
    const paths = intentPathsForRepo(repoRoot);
    writeIntentFile(paths.intentJson, validFixture());
    const before = fs.readFileSync(paths.intentJson, 'utf-8');

    const broken = validFixture();
    broken.items[1] = { ...broken.items[1], id: broken.items[0].id };

    expect(() => writeIntentFile(paths.intentJson, broken)).toThrow(IntentValidationFailedError);
    expect(fs.readFileSync(paths.intentJson, 'utf-8')).toBe(before);
    expect(fs.readdirSync(paths.dir)).toEqual(['intent.json']);
  });

  it('carries the validation errors on the thrown error', () => {
    const paths = intentPathsForRepo(repoRoot);
    const broken = validFixture();
    broken.projectId = 'sample-project';
    try {
      writeIntentFile(paths.intentJson, broken, { expectedProjectId: 'another-project' });
      throw new Error('expected a validation failure');
    } catch (error) {
      expect(error).toBeInstanceOf(IntentValidationFailedError);
      expect((error as IntentValidationFailedError).errors[0]?.code).toBe(IntentValidationCode.ProjectMismatch);
    }
    expect(fs.existsSync(paths.intentJson)).toBe(false);
  });

  it('leaves no temporary file behind after a successful write', () => {
    const paths = intentPathsForRepo(repoRoot);
    writeIntentFile(paths.intentJson, validFixture());
    writeIntentFile(paths.intentJson, validFixture());
    expect(fs.readdirSync(paths.dir)).toEqual(['intent.json']);
  });

  it('refuses a schema-valid model whose serialized form exceeds the size cap', () => {
    const pad = 'x'.repeat(2000);
    const items = Array.from({ length: 500 }, (_, i) => ({
      id: `cap-${i}`,
      domain: 'ordering',
      kind: IntentKind.Capability as const,
      title: `Capability ${i}`,
      statement: pad,
      authority: IntentAuthority.Candidate,
      payload: { outcome: pad, beneficiary: pad, boundary: pad },
      sources: Array.from({ length: 10 }, (_, j) => ({
        kind: IntentSourceKind.Spec,
        ref: `spec/${'r'.repeat(490)}`,
        localId: `CAP-${i}-S-${j}`,
      })),
    }));
    const fat: IntentFileV2 = {
      schemaVersion: 2,
      projectId: 'sample-project',
      domains: [{ id: 'ordering', title: 'Ordering' }],
      items,
      relations: [],
    };
    // Guards: the model itself passes validation, and its serialized form is over the read cap —
    // without the write-side check this would produce a file the reader then rejects.
    expect(validateIntentFile(fat).ok).toBe(true);
    expect(Buffer.byteLength(serializeIntentFile(fat), 'utf-8')).toBeGreaterThan(MAX_INTENT_FILE_BYTES);

    const paths = intentPathsForRepo(repoRoot);
    expect(() => writeIntentFile(paths.intentJson, fat)).toThrow(IntentValidationFailedError);
    expect(fs.existsSync(paths.intentJson)).toBe(false);
    expect(fs.existsSync(paths.dir) ? fs.readdirSync(paths.dir) : []).toHaveLength(0);
  });
});

describe('readIntentFile — untrusted input is bounded and contained', () => {
  it('refuses a file above the size cap without parsing it', () => {
    const paths = intentPathsForRepo(repoRoot);
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.intentJson, '{}');
    fs.truncateSync(paths.intentJson, MAX_INTENT_FILE_BYTES + 1);

    const result = readIntentFile(paths.intentJson);

    if (result.status !== IntentOverlayStatus.Invalid) throw new Error('expected invalid');
    expect(result.errors[0]?.code).toBe(IntentValidationCode.Malformed);
    expect(result.errors[0]?.message).toContain('limit');
  });

  it('refuses a directory at the overlay path instead of throwing', () => {
    const paths = intentPathsForRepo(repoRoot);
    fs.mkdirSync(paths.intentJson, { recursive: true });

    const result = readIntentFile(paths.intentJson);

    if (result.status !== IntentOverlayStatus.Invalid) throw new Error('expected invalid');
    expect(result.errors[0]?.message).toBe('not a regular file');
  });

  it('refuses an overlay symlinked outside the containment root', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'coredoc-intent-outside-'));
    const target = path.join(outside, 'secret.json');
    fs.writeFileSync(target, serializeIntentFile(validFixture()));
    const paths = intentPathsForRepo(repoRoot);
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.symlinkSync(target, paths.intentJson);

    try {
      const contained = readIntentFile(paths.intentJson, { containmentRoot: repoRoot });
      if (contained.status !== IntentOverlayStatus.Invalid) throw new Error('expected invalid');
      expect(contained.errors[0]?.message).toBe('path escapes repository');

      // Without a containment root the check is skipped (callers opt in).
      expect(readIntentFile(paths.intentJson).status).toBe(IntentOverlayStatus.Ready);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('never echoes file bytes in a JSON parse failure', () => {
    const paths = intentPathsForRepo(repoRoot);
    fs.mkdirSync(paths.dir, { recursive: true });
    // Short enough that Node would quote it whole in its own parse error.
    fs.writeFileSync(paths.intentJson, 'LEAKME bad');

    const result = readIntentFile(paths.intentJson);

    if (result.status !== IntentOverlayStatus.Invalid) throw new Error('expected invalid');
    expect(result.errors[0]?.code).toBe(IntentValidationCode.Malformed);
    expect(result.errors[0]?.message).not.toContain('LEAKME');
    expect(result.message).not.toContain('LEAKME');
  });
});

describe('writeIntentFile — a failed write leaves no temp file', () => {
  it('removes the temp file and rethrows when the rename fails', () => {
    const paths = intentPathsForRepo(repoRoot);
    // A non-empty directory occupying the destination makes rename fail for real.
    fs.mkdirSync(paths.intentJson, { recursive: true });
    fs.writeFileSync(path.join(paths.intentJson, 'occupied'), 'x');

    expect(() => writeIntentFile(paths.intentJson, validFixture())).toThrow();

    expect(fs.readdirSync(paths.dir).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });
});
