/**
 * The one lexical matcher behind `get_intent_context`'s `query` and
 * `intent_read`'s `search`, so both select the same items for the same words.
 * Ranking stays with each caller.
 *
 * A word matches an item (aliased `i`) when it is a substring of its title,
 * statement, body or rationale. A `ref:<value>` word instead names one of the
 * item's source refs exactly (case-insensitively, as words are lowercased).
 * Every word must match; only when no item matches them all does the answer
 * fall back to items matching any word, and it says so (`matched: 'any'`).
 */
import { Prisma } from '../../generated/prisma/client.js';
import { likePattern } from './intent-context.select.js';

export enum IntentLexicalMatch {
  All = 'all',
  Any = 'any',
}

const REF_PREFIX = 'ref:';

function wordPredicate(word: string): Prisma.Sql {
  if (word.startsWith(REF_PREFIX) && word.length > REF_PREFIX.length) {
    return Prisma.sql`EXISTS (
      SELECT 1 FROM intent_item_sources s
      WHERE s.workspace_id = i.workspace_id AND s.item_id = i.id AND lower(s.ref) = ${word.slice(REF_PREFIX.length)}
    )`;
  }
  // `title` and `statement` ride the pg_trgm GIN indexes (migration 20260901102000);
  // body and rationale are in the same disjunction unindexed.
  const pattern = likePattern(word);
  return Prisma.sql`(i.title ILIKE ${pattern} OR i.statement ILIKE ${pattern}
    OR COALESCE(i.rationale, '') ILIKE ${pattern}
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(i.body) = 'array' THEN i.body ELSE '[]'::jsonb END) b
      WHERE b ILIKE ${pattern}
    ))`;
}

/** The predicate an item must satisfy under `match`. */
export function lexicalPredicate(words: readonly string[], match: IntentLexicalMatch): Prisma.Sql {
  return Prisma.sql`(${Prisma.join(words.map(wordPredicate), match === IntentLexicalMatch.All ? ' AND ' : ' OR ')})`;
}

/** How many of `words` an item matches, for ranking an any-word answer. */
export function lexicalHits(words: readonly string[]): Prisma.Sql {
  return Prisma.join(
    words.map((word) => Prisma.sql`(CASE WHEN ${wordPredicate(word)} THEN 1 ELSE 0 END)`),
    ' + ',
  );
}

/**
 * Run `select` with every word required, and when that finds nothing (and the
 * query has more than one word), again with any word. `allowFallback: false`
 * keeps a later page from re-answering an exhausted all-word match.
 */
export async function matchLexically<T>(
  words: readonly string[],
  select: (predicate: Prisma.Sql, match: IntentLexicalMatch) => Promise<T[]>,
  allowFallback = true,
): Promise<{ rows: T[]; matched: IntentLexicalMatch }> {
  const rows = await select(lexicalPredicate(words, IntentLexicalMatch.All), IntentLexicalMatch.All);
  if (rows.length > 0 || words.length < 2 || !allowFallback) return { rows, matched: IntentLexicalMatch.All };
  return {
    rows: await select(lexicalPredicate(words, IntentLexicalMatch.Any), IntentLexicalMatch.Any),
    matched: IntentLexicalMatch.Any,
  };
}
