/**
 * Read-only Cypher enforcement — the SECURITY BOUNDARY for every native-Cypher
 * surface (the explorer power-user box, the REST `/graph/cypher` endpoint, and
 * the `run_cypher_query` MCP tool) across both dialects (Neo4j, Ladybug/Kùzu).
 *
 * This static gate IS the boundary; it is deny-by-default and enforced by TWO
 * gates that must both pass:
 *
 *   (a) POSITIVE ALLOWLIST on the statement-leading keyword. After scrubbing and
 *       confirming a single statement, the first significant token must be one of
 *       {MATCH, OPTIONAL, WITH, UNWIND, RETURN}. Everything else is rejected by
 *       construction — EXPORT, COPY, ATTACH, USE, INSTALL, CHECKPOINT, ANALYZE,
 *       CREATE, MERGE, IMPORT, SHOW, CALL, and every *future* statement type,
 *       because a statement type is announced by its leading keyword. A deny-list
 *       of "known bad" keywords cannot make that guarantee.
 *
 *   (b) EMBEDDED-KEYWORD DENY union (belt-and-suspenders) for mutating/side-effect
 *       clauses that appear MID-query behind a legal leading token — `MATCH (n)
 *       SET n.x = 1`, `MATCH (n) DETACH DELETE n`, `... FOREACH(... CREATE ...)`,
 *       `... CALL db.x()`. Whole-word matching, with explicit LOAD_EXTENSION /
 *       CREATE_MACRO entries (underscore is a word char, so `\bLOAD\b` misses
 *       LOAD_EXTENSION). Projection ALIASES are masked before this scan (see
 *       `maskProjectionAliases`) so `RETURN e.name AS call` is not misread as a
 *       `CALL` clause.
 *
 * A caller-supplied `EXPLAIN`/`PROFILE` prefix and any multi-statement query are
 * rejected too.
 *
 * The DB-level read transaction / read-only handle and Neo4j's `EXPLAIN`
 * queryType classification are DEFENSE-IN-DEPTH routing that run *below* this
 * gate — they are NOT the boundary. This gate is.
 *
 * SCRUBBING: comments, quoted spans, and parameter names are removed by ONE
 * single-pass, left-to-right scanner (`scrubCypher`), never by sequential regex passes. An
 * adversarial review proved sequential passes DESYNC: a `//` inside a string
 * literal is eaten as a comment by the line-comment pass, and a `'` inside a
 * `"…"` literal opens a phantom literal because the single-quote pass runs
 * first — either one can swallow a following `; EXPORT DATABASE '/tmp/pwn'`,
 * hiding an arbitrary filesystem write from the gate (fail-open, executed on a
 * real read-only handle). One scanner consuming `//`, `/* *\/`, `'…'`, `"…"` and
 * `` `…` `` in source order cannot desync: whichever opener appears first wins,
 * and a nested opener is just data. Escaping follows Cypher/Kùzu: backslash
 * escapes inside single/double-quoted strings; a backtick inside a quoted
 * identifier is DOUBLED (``), not backslash-escaped.
 */

export type CypherDialect = 'neo4j' | 'ladybug';

/**
 * Statement-leading keywords that may begin a read-only Cypher statement — the
 * positive allowlist (gate a). Deliberately excludes `CALL`: there is no
 * procedure surface at all, not even read-only `CALL { … }` subqueries.
 */
const ALLOWED_LEADING_KEYWORDS = ['MATCH', 'OPTIONAL', 'WITH', 'UNWIND', 'RETURN'] as const;

/**
 * Mutation / side-effect / cross-db / admin keyword classes — the union across
 * Neo4j and Ladybug/Kùzu (gate b). Presence anywhere (as a whole word) rejects
 * the query. Multi-word forbidden forms (`LOAD CSV`, `COPY … TO`, `EXPORT
 * DATABASE`, `DETACH DELETE`) are covered by their leading keyword.
 */
const FORBIDDEN = [
  'CREATE',
  'MERGE',
  'DELETE',
  'DETACH',
  'SET',
  'REMOVE',
  'DROP',
  'FOREACH',
  'CALL', // no procedure surface at all (blocks apoc/dbms/db.* writes + reads)
  'LOAD', // LOAD CSV
  'INSERT',
  'USE', // Neo4j USE <db> — cross-database, classifies read-only under EXPLAIN
  'ATTACH', // Kùzu ATTACH — reads any other project/workspace graph file
  'COPY', // Kùzu COPY (…) TO — arbitrary filesystem write
  'EXPORT', // Kùzu EXPORT DATABASE — filesystem write
  'IMPORT',
  'INSTALL', // Kùzu extension install
  'LOAD_EXTENSION',
  'CREATE_MACRO',
  'CHECKPOINT', // Kùzu — forces a WAL checkpoint (write) on the database files
  'ANALYZE', // Kùzu — persists statistics
  'SHOW',
  'TERMINATE',
  'GRANT',
  'DENY',
  'REVOKE',
  'ALTER',
  'RENAME',
  'START',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
] as const;

/**
 * Property names that carry (or can be made to carry) repository source code.
 * `sourceCode` is the direct projection; `properties` is the NODE JSON blob a
 * `regexp_extract(n.properties, 'sourceCode":"([^"]*)')` can mine it out of.
 *
 * These are NODE-table fields. A relationship's `properties` column is a
 * different column on a different table (edge metadata — `{"operation":"read"}`
 * on OPERATES_ON, resolution provenance on RESOLVES_TO); it never holds source.
 * See {@link relationshipOnlyVariables} for how the two are told apart.
 */
const SOURCE_BEARING_FIELDS = ['sourceCode', 'properties'] as const;

/**
 * Upper bound on a query string, enforced at the single read-only entry point.
 *
 * Not a correctness rule — a bound on the work the scanners can be made to do
 * before any of them decides anything. 16 KB is far above any real read query.
 */
const MAX_CYPHER_QUERY_LENGTH = 16_384;

/**
 * Keywords after which a `[` opens a LIST LITERAL rather than indexing an operand.
 *
 * The bracket guard is fail-closed on the operand, not on spacing (see
 * {@link assertQueryDoesNotProjectSource}), so every legitimate list-literal
 * position has to be named here or a read filter stops parsing. `IN` covers
 * `WHERE n.id IN [1,2,3]`; the clause keywords cover a list built directly in a
 * projection (`RETURN [1,2]`, `WITH [1,2] AS xs`, `UNWIND [1,2] AS x`); the
 * boolean/comparison operators cover a list on the right of a predicate.
 *
 * A name NOT in this set is an operand, so `n [...]`, `x [...]` and `names[0]`
 * all stay rejected — which is the whole point.
 */
const LIST_LITERAL_KEYWORDS: ReadonlySet<string> = new Set([
  'IN',
  'RETURN',
  'WITH',
  'UNWIND',
  'WHERE',
  'AS',
  'AND',
  'OR',
  'XOR',
  'NOT',
  'CONTAINS',
  'SET',
  'WHEN',
  'THEN',
  'ELSE',
  'CASE',
  // `RETURN DISTINCT [n.type]` and `ORDER BY [n.type]` are ordinary source-free
  // queries. Both were rejected because the token immediately before the bracket
  // is the keyword, not the projection — over-rejection is the safe direction, but
  // it is still a lost allowance. Adding them cannot weaken the guard: a subscript
  // like `RETURN DISTINCT n[0]` is preceded by `n`, never by the keyword.
  'DISTINCT',
  'BY',
]);

/**
 * Punctuation after which a `[` opens a LIST LITERAL rather than subscripting.
 *
 * These are all positions where an EXPRESSION begins: after a separator, an
 * opening delimiter, an operator, or a map-entry colon. `-` also covers the
 * relationship pattern `-[r:CALLS]->`, which must not read as a subscript.
 *
 * Deliberately does NOT contain `]`, `}`, `)` or a quote terminator: those end a
 * value, so a `[` after one is CHAINED SUBSCRIPTING (`[n][0]`, `{x:n}['x']`,
 * `f(x)[0]`) — the bypass class this set exists to exclude.
 */
const LIST_LITERAL_PRECEDING_CHARS: ReadonlySet<string> = new Set([
  ',',
  '(',
  '[',
  '{',
  '=',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '^',
  '|',
  ':',
  '!',
]);

/**
 * Whether the `[` at `bracketIndex` opens a list literal rather than subscripting
 * whatever precedes it.
 *
 * FAIL-CLOSED BY CONSTRUCTION, and that inversion is the point. An earlier version
 * asked the opposite question — "does an identifier or `)` precede it?" — which
 * meant every receiver shape nobody thought to enumerate was silently permitted:
 * `[n][0]['sourceCode']` and `{x:n}['x']['sourceCode']` both reached a
 * source-bearing field, because a `]` and a `}` are not identifiers. Enumerating
 * receivers can only ever be as complete as the list; enumerating the positions
 * where a list literal is legal is a closed set, so anything unrecognised is
 * rejected instead of admitted.
 */
function opensListLiteral(scrubbed: string, bracketIndex: number): boolean {
  let i = bracketIndex - 1;
  while (i >= 0 && /\s/.test(scrubbed[i]!)) i -= 1;
  // A query may legitimately begin with a list expression.
  if (i < 0) return true;
  const ch = scrubbed[i]!;
  if (/[A-Za-z0-9_]/.test(ch)) {
    let start = i;
    while (start >= 0 && /[A-Za-z0-9_]/.test(scrubbed[start]!)) start -= 1;
    return LIST_LITERAL_KEYWORDS.has(scrubbed.slice(start + 1, i + 1).toUpperCase());
  }
  return LIST_LITERAL_PRECEDING_CHARS.has(ch);
}

/**
 * Field-specific, actionable rejection message: names the exact field the
 * query referenced (not just the class of fields that are off-limits), lists
 * the fields that ARE queryable, and points at the schema-reference tool
 * instead of leaving the agent with a bare refusal.
 */
function sourceProjectionMessage(field: string): string {
  return (
    `Source-in-graph is disabled: this deployment does not serve function/method source bodies, so a Cypher query ` +
    `cannot reference "${field}" (a source-bearing field). Project other fields instead — name, type, filePath, ` +
    'startLine, endLine, summary, repoId — or call the describe_db_schema tool for the full field-level schema.'
  );
}

/**
 * Rejection for `x.*`. A star projection is not a named field, so the
 * field-specific message above cannot describe it — and on Ladybug it expands
 * to EVERY node column (`properties`, `summary`, `embedding` included), which
 * is exactly the projection `n.properties` is rejected for. Names the safe
 * alternative rather than refusing bare.
 */
function starProjectionMessage(variable: string): string {
  return (
    `Source-in-graph is disabled: "${variable}.*" expands to every column of the node table, including ` +
    '"properties" (a source-bearing field). List the fields you need instead — ' +
    `${variable}.id, ${variable}.name, ${variable}.type, ${variable}.filePath, ${variable}.startLine, ` +
    `${variable}.endLine, ${variable}.summary, ${variable}.repoId — or call the describe_db_schema tool for the ` +
    'full field-level schema. A relationship variable (`-[r:TYPE]->`) may use `r.*` and `r.properties`: edge ' +
    'properties are operation metadata, not source.'
  );
}

function dynamicFieldAccessMessage(construct: string): string {
  return (
    `Source-in-graph is disabled: ${construct} can reach a source-bearing field without naming it, so the ` +
    'source-field guard cannot see it. Project the fields you need by name instead — id, name, type, filePath, ' +
    'startLine, endLine, summary, repoId — or call the describe_db_schema tool for the full field-level schema.'
  );
}

/**
 * Rejection for `x[…]`. The bracket rule is fail-closed and syntax-level: it cannot
 * tell `n['sourceCode']` / `n[k]` (property access it must block) from `names[0]`
 * (indexing a list projected in an earlier clause, which touches no property). Both
 * are rejected, so the message says so outright and names the way out — otherwise an
 * agent reads "bracket property access" about a query that accessed no property and
 * has nothing to act on.
 */
function bracketAccessMessage(): string {
  return (
    `${dynamicFieldAccessMessage('bracket property access (`node[...]`)')} This also blocks plain LIST indexing on ` +
    'a projected alias (`WITH collect(n.name) AS names RETURN names[0]`), which the syntax cannot be told apart ' +
    'from property access: use a list function instead (`RETURN head(names)`, `last(names)`, `size(names)`), or ' +
    'project the element you want in the same clause that builds the list.'
  );
}

/**
 * Variables that provably denote a RELATIONSHIP and never a node.
 *
 * Relationship `properties` is edge metadata (`{"operation":"read"}`), stored in
 * a separate column on a separate table from the node blob, and is legitimately
 * useful — blocking it taught agents that the whole `properties` vocabulary is
 * off-limits. So it is allowed, but ONLY when the binding is unambiguous:
 *
 * - A relationship binding is recognised by the pattern syntax that can express
 *   nothing else: `-[` … `]` followed by `-`/`>`. A list literal or a list
 *   comprehension (`[x IN xs | …]`, whose `x` CAN be a node) is not preceded by
 *   `-`, so it never contributes a name.
 * - Any identifier that also appears in node position — `(n`, and, conservatively,
 *   any `(identifier` including function arguments like `count(n)` — is removed
 *   again. A name used both ways, or rebound by `WITH r AS n`, therefore falls
 *   back to blocked.
 * - Any identifier that is the TARGET of a binder — `… AS r` (WITH / UNWIND /
 *   RETURN projection, in any clause of any UNION branch) or `r IN …` (list and
 *   pattern comprehensions, `reduce`) — is removed again. This is the reverse of
 *   the case above and the one an adversarial review actually exploited:
 *   `MATCH (a)-[r:CALLS]->(b) WITH a AS r RETURN r.properties` bound the NODE `a`
 *   to the trusted relationship name `r` and returned the node blob (verified
 *   live against Ladybug before this rule existed).
 *
 * CONSERVATISM (deliberate, in place of full scope tracking): the binder rule is
 * position-blind and whole-query. It does not ask which clause the binding is in,
 * whether it precedes or follows the property access, or whether the bound value
 * is a node — a single `AS r` / `r IN …` anywhere distrusts `r` everywhere. That
 * over-rejects a handful of legitimate shapes (`… RETURN r.properties AS r`,
 * `WHERE r IN $edges`), which only ever costs an allowance; it cannot leak.
 *
 * Fail-closed by construction: everything not proven to be a relationship is
 * treated as a node.
 */
function relationshipOnlyVariables(scrubbed: string): Set<string> {
  // A backtick-quoted identifier is erased to an empty placeholder by the
  // scrubber, so neither the node-position nor the binder rule can read the name
  // it binds (`WITH a AS \`r\`` would silently keep `r` trusted). No name is
  // provable in that query — prove nothing.
  if (scrubbed.includes('``')) return new Set<string>();

  const relationshipVariables = new Set<string>();
  // `[^\]\[]*` rather than `[^\]]*`: excluding `[` as well as `]` keeps the two
  // quantifiers from overlapping, so a string of unclosed `-[` cannot make the
  // engine try every split between them (measured quadratic before this: 20 KB of
  // `-[` took 325 ms). Semantics are unchanged — a relationship pattern never
  // contains a nested `[`.
  const relationshipPattern = /-\[\s*([A-Za-z_][A-Za-z0-9_]*)?[^\][]*\]\s*[-<>]/g;
  for (const match of scrubbed.matchAll(relationshipPattern)) {
    const name = match[1];
    if (name) relationshipVariables.add(name);
  }

  // Node position — `(n)`, `(n:Label)`, and every `(identifier` shape a
  // function call could also produce. Over-collecting here only ever REMOVES an
  // allowance.
  const nodeCandidatePattern = /\(\s*([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of scrubbed.matchAll(nodeCandidatePattern)) {
    const name = match[1];
    if (name) relationshipVariables.delete(name);
  }

  // Binder targets — `… AS r`, `UNWIND xs AS r`, `[x IN xs | …]`, `reduce(acc =
  // 0, x IN xs | …)`. Anything that can be bound to a name can be a NODE, so a
  // name that is ever a binder target stops being proof of a relationship.
  const binderTargetPattern = /\bAS\s+([A-Za-z_][A-Za-z0-9_]*)|\b([A-Za-z_][A-Za-z0-9_]*)\s+IN\b/gi;
  for (const match of scrubbed.matchAll(binderTargetPattern)) {
    const name = match[1] ?? match[2];
    if (name) relationshipVariables.delete(name);
  }

  return relationshipVariables;
}

/**
 * Single-pass, left-to-right scanner. Replaces comments with a space, quoted
 * spans (string literals, backtick identifiers) with an empty placeholder of the
 * same kind, and regular parameter names with `$`. Everything else is preserved —
 * crucially every TOP-LEVEL `;`, which is by construction the only kind of `;`
 * that survives.
 *
 * Throws on an unterminated comment or quoted span (fail closed: an unbalanced
 * quote is exactly the shape of a scrubber-desync attack).
 */
function scrubCypher(query: string): string {
  let out = '';
  let i = 0;
  const n = query.length;

  while (i < n) {
    const ch = query[i];
    const next = query[i + 1];

    // -- line comment ------------------------------------------------------
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < n && query[i] !== '\n') i++;
      out += ' ';
      continue;
    }

    // -- block comment -----------------------------------------------------
    if (ch === '/' && next === '*') {
      i += 2;
      let closed = false;
      while (i < n) {
        if (query[i] === '*' && query[i + 1] === '/') {
          i += 2;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) {
        throw new Error('Only read-only Cypher is allowed (unterminated block comment)');
      }
      out += ' ';
      continue;
    }

    // -- regular parameter identifier -------------------------------------
    // Parameter names are bindings, not executable tokens. Keep the `$` but
    // remove a valid identifier so `$set` cannot be mistaken for a SET clause.
    if (ch === '$' && next !== undefined && /[A-Za-z_]/.test(next)) {
      i += 2;
      while (i < n && /[A-Za-z0-9_]/.test(query[i])) i++;
      out += '$';
      continue;
    }

    // -- single / double quoted string literal (backslash escapes) ---------
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      let closed = false;
      while (i < n) {
        if (query[i] === '\\') {
          i += 2; // skip the escaped character, whatever it is
          continue;
        }
        if (query[i] === quote) {
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) {
        throw new Error('Only read-only Cypher is allowed (unterminated string literal)');
      }
      out += quote + quote;
      continue;
    }

    // -- backtick-quoted identifier (a literal backtick is DOUBLED) --------
    if (ch === '`') {
      i++;
      let closed = false;
      while (i < n) {
        if (query[i] === '`') {
          if (query[i + 1] === '`') {
            i += 2; // escaped backtick, identifier continues
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) {
        throw new Error('Only read-only Cypher is allowed (unterminated quoted identifier)');
      }
      out += '``';
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Split the SCRUBBED text on top-level semicolons and drop empty fragments, so a
 * single trailing `;` is tolerated while any interior statement is surfaced.
 */
function splitStatements(scrubbed: string): string[] {
  return scrubbed
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/**
 * Tokens that can legally FOLLOW a projection alias, and that no clause keyword
 * can be followed by while actually functioning as a clause. A clause always
 * takes an operand (`CALL db.x()`, `CREATE (n)`, `SET n.x = 1`, `DETACH DELETE
 * n`), so it is never followed by a projection separator, a closing bracket, an
 * ORDER/SKIP/LIMIT tail, or the end of the statement.
 */
const ALIAS_FOLLOWERS = ['ORDER', 'SKIP', 'LIMIT', 'UNION', 'ASC', 'DESC', 'RETURN', 'WHERE'] as const;

/**
 * Mask projection aliases (`… AS call`, `… AS start`) before the embedded-keyword
 * scan. An alias is a BINDING, not an executable token — same reasoning as the
 * `$param` scrubbing in `scrubCypher` — and real agent queries do write
 * `RETURN e.name AS call` / `RETURN f.startLine AS start`, which the whole-word
 * deny union otherwise rejects as if they were a `CALL` / `START` clause.
 *
 * This does NOT weaken the gate: exactly one identifier is consumed, and only
 * when the token after it proves the identifier cannot be a clause head (see
 * ALIAS_FOLLOWERS). `WITH n AS CALL db.x() YIELD v` keeps its `CALL` — the
 * follower is `db`, so no masking happens and the deny union still fires.
 *
 * Operates on the already-uppercased, already-scrubbed statement.
 */
function maskProjectionAliases(upperStatement: string): string {
  const followers = ALIAS_FOLLOWERS.join('|');
  const re = new RegExp(`\\bAS\\s+[A-Za-z_][A-Za-z0-9_]*(?=\\s*(?:$|[,)\\]}]|(?:${followers})\\b))`, 'g');
  return upperStatement.replace(re, 'AS ');
}

/**
 * Assert `query` is a single, read-only Cypher statement under the dual gate
 * (leading-token allowlist + embedded-keyword deny). Throws a caller-safe
 * `Error` otherwise. `dialect` is accepted for future dialect-specific
 * tightening; today both gates are the union across both dialects.
 */
export function assertReadOnlyCypherAllowlisted(query: string, _dialect: CypherDialect): void {
  const trimmed = query.trim();
  if (trimmed === '') {
    throw new Error('Cypher query is empty');
  }
  // Length cap before any scanning. Every surface that reaches this guard —
  // `run_cypher_query`, the REST `/graph/cypher` endpoint, the desktop NL box —
  // passes the string through unbounded, and the relationship-pattern scan below
  // is superlinear on input with many unclosed `-[`. A hand- or agent-written
  // read query is orders of magnitude under this; the cap only stops a payload
  // whose purpose is to occupy the event loop.
  if (trimmed.length > MAX_CYPHER_QUERY_LENGTH) {
    throw new Error(
      `Cypher query is too long (${trimmed.length} characters; the limit is ${MAX_CYPHER_QUERY_LENGTH}). ` +
        'Narrow the pattern or filter in the query instead of inlining a large literal.',
    );
  }

  const scrubbed = scrubCypher(trimmed);

  // Reject a caller-supplied EXPLAIN/PROFILE prefix — the tool adds its own
  // EXPLAIN for classification; a nested one would double-wrap or mislead.
  if (/^\s*(EXPLAIN|PROFILE)\b/i.test(scrubbed)) {
    throw new Error('Only read-only Cypher is allowed (remove the leading EXPLAIN/PROFILE)');
  }

  // Single statement only. Kùzu executes ;-separated statements; Neo4j would
  // error — reject uniformly.
  const statements = splitStatements(scrubbed);
  if (statements.length === 0) {
    throw new Error('Cypher query is empty');
  }
  if (statements.length > 1) {
    throw new Error('Only a single read-only Cypher statement is allowed (multiple statements rejected)');
  }

  const statement = statements[0];

  // -- gate (a): positive allowlist on the statement-leading keyword --------
  const leadingMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(statement);
  if (!leadingMatch) {
    throw new Error(
      `Only read-only Cypher is allowed (a statement must start with one of: ${ALLOWED_LEADING_KEYWORDS.join(', ')})`,
    );
  }
  const leading = leadingMatch[0].toUpperCase();
  if (!(ALLOWED_LEADING_KEYWORDS as readonly string[]).includes(leading)) {
    throw new Error(
      `Only read-only Cypher is allowed (statement starts with "${leading}"; allowed: ${ALLOWED_LEADING_KEYWORDS.join(', ')})`,
    );
  }

  // -- gate (b): embedded mutating/side-effect keyword deny union -----------
  const upper = maskProjectionAliases(statement.toUpperCase());
  for (const kw of FORBIDDEN) {
    // Word-boundary match so a keyword inside an identifier (e.g. SETTINGS,
    // CREATED_AT) does not false-positive. Underscore is a word char, so
    // \bLOAD\b does NOT match LOAD_EXTENSION — hence the explicit entries.
    const re = new RegExp(`\\b${kw}\\b`);
    if (re.test(upper)) {
      throw new Error(`Only read-only Cypher is allowed (found "${kw}")`);
    }
  }
}

/**
 * Back-compat wrapper for existing callers (Neo4j repository, REST endpoint).
 * Delegates to the dual gate so every surface inherits the same boundary.
 */
export function assertReadOnlyCypher(query: string): void {
  assertReadOnlyCypherAllowlisted(query, 'neo4j');
}

/**
 * Assert `query` does not reference a source-bearing property. Callers invoke
 * this ONLY when the source-in-graph serve flag is OFF.
 *
 * An output-scan (redacting rows on the way out) is not a boundary: an
 * adversarial review proved source can be projected under a different shape
 * in-engine — `RETURN n.sourceCode AS x` on Neo4j, or
 * `regexp_extract(n.properties, 'sourceCode":"([^"]*)')` on Ladybug, which never
 * emits a field the scanner recognises. So the QUERY is rejected instead.
 * Scrubbing shares the one scanner with the read-only gate, so a mention hidden
 * in a comment or string literal does not false-positive and a quote cannot
 * desync the scan.
 */
export function assertQueryDoesNotProjectSource(query: string): void {
  const scrubbed = scrubCypher(query);
  const relationshipVariables = relationshipOnlyVariables(scrubbed);

  // The whole-word field scan below only sees field names spelled as identifiers
  // in the source. Several Cypher constructs reach a property WITHOUT spelling its
  // name where the scan can read it, so each was proven to project source in an
  // adversarial pass and is rejected up front (serve-off is a locked-down mode, so
  // fail closed):
  //   - a backtick-quoted identifier — `scrubCypher` erases it to ``, so
  //     `RETURN n.`sourceCode`` carries no `sourceCode` token by the time we scan;
  //   - bracket property access — `n['sourceCode']` / `n[k]` pass the field name as
  //     a string literal (blanked by the scrubber) or a variable;
  //   - `keys(n)` combined with `n[k]` (e.g. inside `reduce(...)`) enumerates and
  //     concatenates EVERY property, sourceCode included, into one scalar;
  //   - map projection `n{.*}` / `n{.sourceCode}` expands node properties, and the
  //     `x.*` star-projection scan below does not see the `{.` form.
  if (scrubbed.includes('``')) {
    throw new Error(dynamicFieldAccessMessage('a backtick-quoted identifier'));
  }
  // `node[...]` is property access; `IN [...]` / `RETURN [...]` is a list literal.
  // The two are told apart by what PRECEDES the bracket, never by spacing —
  // openCypher's ListOperatorExpression admits `SP?` before the index operator, so
  // `n ['sourceCode']` and `n\t['sourceCode']` are property access too. Every `[`
  // is examined and rejected unless {@link opensListLiteral} can prove a list
  // literal is legal in that position, which makes the unrecognised case a
  // rejection rather than an admission (see that function for why the inverse
  // framing leaked). Indexing a projected LIST (`names[0]`) is the same syntax and
  // is rejected too; `bracketAccessMessage` states that collateral and names the
  // list-function alternative.
  for (let i = scrubbed.indexOf('['); i !== -1; i = scrubbed.indexOf('[', i + 1)) {
    if (!opensListLiteral(scrubbed, i)) {
      throw new Error(bracketAccessMessage());
    }
  }
  if (/\bkeys\s*\(/i.test(scrubbed)) {
    throw new Error(dynamicFieldAccessMessage('`keys(...)`'));
  }
  if (/\{\s*\./.test(scrubbed)) {
    throw new Error(dynamicFieldAccessMessage('map projection (`node{.*}`)'));
  }

  // `x.*` is the second route to the same columns: on Ladybug it expands to the
  // full node table — id, type, name, properties, summary, embedding, … — so a
  // guard that only rejects the field NAME leaves the blob reachable. Rejected
  // for everything except a proven relationship variable.
  for (const match of scrubbed.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*\*/g)) {
    const variable = match[1]!;
    if (!relationshipVariables.has(variable)) {
      throw new Error(starProjectionMessage(variable));
    }
  }

  for (const field of SOURCE_BEARING_FIELDS) {
    // Every mention rejects, EXCEPT `<relationshipVariable>.<field>` — the edge
    // property map, which is not source (see `relationshipOnlyVariables`). The
    // exemption is applied by blanking those occurrences before the whole-word
    // scan, so any OTHER mention in the same query still fires.
    const exempted =
      field === 'properties'
        ? scrubbed.replace(new RegExp(`\\b([A-Za-z_][A-Za-z0-9_]*)\\s*\\.\\s*${field}\\b`, 'gi'), (whole, variable) =>
            relationshipVariables.has(variable) ? ' ' : whole,
          )
        : scrubbed;
    if (new RegExp(`\\b${field}\\b`, 'i').test(exempted)) {
      throw new Error(sourceProjectionMessage(field));
    }
  }
}
