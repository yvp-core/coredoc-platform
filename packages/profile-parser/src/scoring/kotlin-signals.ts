// =============================================================================
// Kotlin source signals for the coverage scorer — the denominators the Kotlin
// LanguageProvider supplies to the shared score-core. Modeled on swift-signals.ts
// (an Android app is a CONSUMER, not a server, so `http` is 0 → not_applicable → PASS)
// and on zig-signals.ts for the omitted `dbOperations` row.
//
// Both denominators are ANNOTATION/INHERITANCE LINE COUNTS read off the provider's own
// source set, which is exactly the observable the entity and egress lanes gate on:
//   - entities      — `@Entity`-style annotation lines (Room) or `: RealmObject`-style
//                     inheritance clauses (Realm), chosen by the profile's `orm`.
//   - externalCalls — Retrofit verb-annotation lines, one per declared endpoint.
// `queue`, `cli`, `grpc` and `graphql` are omitted: this substrate has no such surface, so
// those rows stay self-relative instead of scoring a false FAIL.
//
// `dbOperations` is deliberately OMITTED and disclosed through `dbOperationsNote`: a text scan
// can only count DAO/Realm CALL TEXT, while the numerator is op ROWS (several per DAO method,
// plus receiver-resolved Realm idioms a scan cannot see). Those units are not commensurable, so
// a ratio built from them would be a fabricated number.
// =============================================================================
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_REALM_BASE_CLASSES, DEFAULT_ROOM_ENTITY_ANNOTATIONS } from '../substrate/kotlin/kotlin-entities.js';
import { DEFAULT_VERB_ANNOTATIONS } from '../substrate/kotlin/kotlin-egress.js';
import type { KotlinProfile } from '../types/kotlin-profile.js';
import { escapeRegExp } from '../substrate/regex-util.js';
import type { SignalHit } from './cluster-report.js';
import type { ScoreContext, SourceSignals } from './score-core.js';

/** Basis disclosure for the `dbOperations` row, which has no commensurable denominator. */
const DB_OPERATIONS_NOTE = 'DAO and Realm op rows are not commensurable with a text count; db-ops score self-relative';

/** Lines matching `pattern`, as `{file, line, text}` hits (`file` repo-relative). */
function hitLines(repoRoot: string, sourceFiles: readonly string[], pattern: RegExp): SignalHit[] {
  const hits: SignalHit[] = [];
  for (const rel of sourceFiles) {
    let source: string;
    try {
      source = readFileSync(join(repoRoot, rel), 'utf-8');
    } catch {
      continue; // an unreadable file is a skipped file for the parser too
    }
    source.split('\n').forEach((text, index) => {
      if (pattern.test(text)) hits.push({ file: rel, line: index + 1, text: text.trim().slice(0, 200) });
    });
  }
  return hits;
}

/**
 * Kotlin source-signal denominators, read off the provider's own source set.
 * A Realm profile counts inheritance clauses (`class X : … RealmObject`); every other ORM
 * counts entity-annotation lines (`@Entity`), which is what the Room lane matches on.
 */
export function kotlinSourceSignals(ctx: ScoreContext): SourceSignals {
  const profile = ctx.profile as KotlinProfile;
  const entityConfig = profile.entities;

  const entityPattern =
    entityConfig?.orm === 'realm'
      ? new RegExp(
          `\\bclass\\s+\\w+[^{]*:[^{]*\\b(${(entityConfig.baseClasses ?? DEFAULT_REALM_BASE_CLASSES)
            .map(escapeRegExp)
            .join('|')})\\b`,
        )
      : new RegExp(
          `@(${(entityConfig?.annotations ?? DEFAULT_ROOM_ENTITY_ANNOTATIONS).map(escapeRegExp).join('|')})\\b`,
        );
  const verbPattern = new RegExp(
    `@(${(profile.egress?.verbAnnotations ?? DEFAULT_VERB_ANNOTATIONS).map(escapeRegExp).join('|')})\\b`,
  );

  const entityHits = hitLines(ctx.repoRoot, ctx.sourceFiles, entityPattern);
  const egressHits = hitLines(ctx.repoRoot, ctx.sourceFiles, verbPattern);

  return {
    // A mobile client exposes no HTTP entrypoints: the row scores not_applicable → PASS.
    http: 0,
    entities: entityHits.length,
    externalCalls: egressHits.length,
    dbOperationsNote: DB_OPERATIONS_NOTE,
    hits: { entities: entityHits, externalCalls: egressHits },
  };
}
