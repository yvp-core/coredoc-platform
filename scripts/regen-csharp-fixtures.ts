/** Regenerate offline compiler evidence using the pinned, explicitly installed release. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedCSharpTool, prepareCSharpIndex } from '../packages/profile-parser/src/substrate/csharp/scip-run.js';
import { listCSharpWorkspaceFiles } from '../packages/profile-parser/src/substrate/csharp/workspace.js';

const root = fileURLToPath(new URL('../packages/profile-parser/src/substrate/csharp/__fixtures__/', import.meta.url));
const tool = installedCSharpTool(root);
if (!tool) {
  throw new Error('Run coredoc tools install csharp first. Regeneration requires the pinned release and .NET SDK 10.');
}
process.env.COREDOC_SCIP_DOTNET = tool;
const outputs: string[] = [];
const work = mkdtempSync(join(tmpdir(), 'coredoc-csharp-fixture-regen-'));
try {
  for (const name of readdirSync(root).sort()) {
    const directory = join(root, name);
    const output = join(directory, 'scip.json');
    if (!existsSync(output)) continue;
    const projects = listCSharpWorkspaceFiles(directory)
      .filter((file) => file.endsWith('.csproj'))
      .sort();
    const { index, manifest } = await prepareCSharpIndex(directory, projects, join(work, name));
    const documents = index.documents
      .filter((document) => Object.hasOwn(manifest.sourceHashes, document.relativePath))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    if (!documents.length) throw new Error(`No source documents for ${name}.`);
    writeFileSync(output, `${JSON.stringify({ projectRoot: 'file:///fixture', documents }, null, 2)}\n`);
    outputs.push(output);
    const receivers = join(directory, 'receiver-types.json');
    // Other fixtures deliberately exercise stock SCIP without supplemental receiver facts.
    if (existsSync(receivers)) {
      const facts = manifest.receiverTypes;
      if (!facts?.length) throw new Error(`No receiver evidence for ${name}.`);
      facts.sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start || a.end - b.end);
      writeFileSync(receivers, `${JSON.stringify(facts, null, 2)}\n`);
      outputs.push(receivers);
    }
    console.log(`${name}: ${documents.length} compiler source documents regenerated`);
  }
  execFileSync('pnpm', ['exec', 'biome', 'format', '--write', ...outputs], { stdio: 'inherit' });
} finally {
  rmSync(work, { recursive: true, force: true });
}
