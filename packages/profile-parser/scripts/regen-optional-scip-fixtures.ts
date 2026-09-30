/** Requires explicitly installed language tools; never installs them or edits a client repo. */
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { IndexSchema } from '@scip-code/scip';
import { copyOptionalScip, loadOptionalScip } from '../src/facts/scip/source-manifest.js';
import { runScipPython } from '../src/substrate/python/scip-run.js';
import { runScipRust } from '../src/substrate/rust/scip-run.js';
import { runScipGo } from '../src/substrate/go/scip-run.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const runners = { python: runScipPython, rust: runScipRust, go: runScipGo };
for (const language of process.argv.length > 2 ? process.argv.slice(2) : Object.keys(runners)) {
  if (!(language in runners)) throw new Error(`Unknown language: ${language}`);
  const fixture = join(repo, 'src/substrate', language, '__fixtures__/scip');
  const work = mkdtempSync(join(tmpdir(), 'regen-scip-'));
  try {
    const source = join(work, 'source');
    cpSync(fixture, source, { recursive: true, filter: (path) => basename(path) !== 'index.scip.base64' });
    const result = await runners[language as keyof typeof runners](source, {
      outDir: join(work, 'output'),
      onLog: console.log,
    });
    const artifact = ('scip' in result ? result.scip : undefined) ?? result.scipPath;
    if (!result.ok || !artifact) throw new Error(result.degradeReason);
    const rawIndex = join(work, 'index.scip');
    copyOptionalScip(artifact, rawIndex);
    const index = fromBinary(IndexSchema, readFileSync(rawIndex));
    if (index.metadata) index.metadata.projectRoot = 'file:///source';
    const bytes = Buffer.from(toBinary(IndexSchema, index));
    writeFileSync(join(fixture, 'index.scip.base64'), `${bytes.toString('base64')}\n`);
    const manifest = {
      indexSha256: createHash('sha256').update(bytes).digest('hex'),
      sources: loadOptionalScip(artifact).sourceHashes,
    };
    writeFileSync(join(fixture, 'index.scip.sources.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Updated ${language} compiler fixture.`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
