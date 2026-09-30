import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyzeRunDir } from './analyze-mcp.js';

// CLI: tsx harness/analyze.ts <run-dir>
// Re-analyzes an existing eval run dir produced by run.ts. Writes
// `mcp-gaps.jsonl` and appends the "MCP gap signals" section to REPORT.md
// (replacing any prior section so reruns are idempotent).
const SECTION_HEADER = '## MCP gap signals';

function stripExistingSection(md: string): string {
  const idx = md.indexOf(SECTION_HEADER);
  if (idx === -1) return md;
  return md.slice(0, idx).replace(/\s+$/, '\n');
}

function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: tsx harness/analyze.ts <run-dir>');
    process.exit(2);
  }
  const runDir = resolve(target);
  if (!existsSync(runDir)) {
    console.error(`run dir not found: ${runDir}`);
    process.exit(2);
  }
  const result = analyzeRunDir(runDir);
  const reportPath = resolve(runDir, 'REPORT.md');
  if (existsSync(reportPath)) {
    const current = readFileSync(reportPath, 'utf8');
    const stripped = stripExistingSection(current);
    writeFileSync(reportPath, stripped);
    appendFileSync(reportPath, `${result.reportSection.join('\n')}\n`);
  }
  console.log(`MCP gaps: ${result.records.length} flagged`);
  console.log(`  jsonl:  ${result.jsonlPath}`);
  if (existsSync(reportPath)) console.log(`  report: ${reportPath} (section refreshed)`);
}

main();
