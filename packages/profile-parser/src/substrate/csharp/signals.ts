import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CSharpProfile } from '../../types/csharp-profile.js';
import { preprocess } from './preprocess.js';
import type { ScoreContext, SourceSignals } from '../../scoring/score-core.js';
import type { SignalHit } from '../../scoring/cluster-report.js';

/** Coarse .NET source signals must survive an omitted framework rule. */
export function csharpSourceSignals(ctx: ScoreContext): SourceSignals {
  const profile = ctx.profile as CSharpProfile;
  const http: SignalHit[] = [];
  const entities: SignalHit[] = [];
  const externalCalls: SignalHit[] = [];
  for (const file of ctx.sourceFiles) {
    let source: string;
    try {
      source = preprocess(readFileSync(join(ctx.repoRoot, file), 'utf8'), profile.substrate.defines ?? []);
    } catch {
      // The parser retains a blocking file diagnostic. Scoring must still report
      // coverage for the remaining files rather than lose the entire report.
      continue;
    }
    // These are source hints, not extraction rules or resolved calls. In particular,
    // arbitrary attributes are not evidence that a method is an HTTP endpoint.
    const lines = source.split('\n');
    const clients = new Set(
      [...source.matchAll(/\b(?:HttpClient|IHttpClientFactory)\s+(\w+)/g)].map((match) => match[1]),
    );
    const httpBefore = http.length;
    let controller: SignalHit | undefined;
    for (const [index, text] of lines.entries()) {
      const hit = { file, line: index + 1, text: text.trim() };
      const verbs = [
        ...text.matchAll(/\[\s*(?:[\w.]+\.)?Http(?:Get|Post|Put|Patch|Delete|Head|Options)(?:Attribute)?\b/g),
      ];
      const mappings = [...text.matchAll(/\.\s*Map(?:Get|Post|Put|Patch|Delete|Methods)\s*\(/g)];
      for (const _match of [...verbs, ...mappings]) http.push(hit);
      if (/\bclass\s+\w+Controller\b/.test(text)) controller ??= hit;
      for (const _match of text.matchAll(/\b(?:DbSet|Set)\s*<\s*[\w.]+\s*>\s+\w+\s*\{/g)) entities.push(hit);
      for (const match of text.matchAll(
        /\b(\w+)\s*\.\s*(?:Get(?:String|Stream|ByteArray|FromJson)?Async|Post(?:AsJson)?Async|Put(?:AsJson)?Async|PatchAsync|DeleteAsync|SendAsync|CreateClient)\s*(?:<[^>]+>)?\s*\(/g,
      )) {
        if (clients.has(match[1])) externalCalls.push(hit);
      }
    }
    if (http.length === httpBefore && controller) http.push(controller);
  }
  return {
    http: http.length,
    entities: entities.length,
    externalCalls: externalCalls.length,
    dbOperationsNote: 'No independent DB-operation denominator; scored against emitted entities.',
    hits: { http, entities, externalCalls },
  };
}
