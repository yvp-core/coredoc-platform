import { describe, expect, it } from 'vitest';
import {
  assertQueryDoesNotProjectSource,
  assertReadOnlyCypher,
  assertReadOnlyCypherAllowlisted,
} from './cypher-guard.js';

describe('assertReadOnlyCypherAllowlisted', () => {
  describe('positive (read-only) cases pass', () => {
    it.each([
      ['MATCH (n:CodeNode) RETURN n LIMIT 25'],
      ['MATCH (a)-[r:CALLS]->(b) WHERE a.name = "createUser" RETURN a, r, b'],
      ['OPTIONAL MATCH (n)-[r]->(m) RETURN n, r, m'],
      ['MATCH (n) WITH n.type AS kind, count(*) AS c RETURN kind, c ORDER BY c DESC SKIP 5 LIMIT 10'],
      ['UNWIND [1,2,3] AS x RETURN x'],
      ['WITH 1 AS x RETURN x'],
      ['RETURN 1 AS answer'],
      ['MATCH (n) WHERE n.createdAt > 0 AND NOT n.hidden RETURN n.settings'],
      // a single trailing semicolon is tolerated
      ['MATCH (n) RETURN n;'],
    ])('passes: %s', (query) => {
      expect(() => assertReadOnlyCypherAllowlisted(query, 'neo4j')).not.toThrow();
      expect(() => assertReadOnlyCypherAllowlisted(query, 'ladybug')).not.toThrow();
    });

    it('does not trip on identifiers that merely contain a forbidden keyword substring', () => {
      // SETTINGS contains SET, CREATED_AT contains CREATE, DATABASE-ish names, etc.
      expect(() =>
        assertReadOnlyCypherAllowlisted('MATCH (n) WHERE n.settings > 0 AND n.created_at < 1 RETURN n', 'neo4j'),
      ).not.toThrow();
    });

    it('does not treat parameter names as executable keywords', () => {
      const query = 'MATCH (n) WHERE n.name = $set AND n.kind = $create RETURN $delete AS deleted, $call AS called';

      expect(() => assertReadOnlyCypherAllowlisted(query, 'neo4j')).not.toThrow();
      expect(() => assertReadOnlyCypherAllowlisted(query, 'ladybug')).not.toThrow();
    });

    it('does not treat a RETURN/WITH alias as an executable keyword', () => {
      // Measured MCP eval regressions: a projection alias is a BINDING, not a
      // clause, so `AS call` / `AS start` must not trip the embedded-keyword
      // deny union.
      const externalCalls =
        "MATCH (f:GraphNode)-[:MAKES_EXTERNAL_CALL]->(e:GraphNode) WHERE f.filePath CONTAINS 'data/auth/' " +
        'RETURN f.name AS func, f.filePath AS file, e.name AS call LIMIT 100';
      const lineRange =
        "MATCH (f:GraphNode) WHERE f.filePath = 'apps/studio/data/auth/users-count-query.ts' " +
        'RETURN f.name AS name, f.type AS type, f.startLine AS start, f.endLine AS end';

      for (const query of [externalCalls, lineRange]) {
        expect(() => assertReadOnlyCypherAllowlisted(query, 'neo4j')).not.toThrow();
        expect(() => assertReadOnlyCypherAllowlisted(query, 'ladybug')).not.toThrow();
      }
    });

    it('does not trip on a backtick-quoted alias that spells a forbidden keyword', () => {
      expect(() => assertReadOnlyCypherAllowlisted('MATCH (n) RETURN n.name AS `delete`', 'neo4j')).not.toThrow();
    });

    it('does not trip on a forbidden keyword inside a string literal', () => {
      expect(() =>
        assertReadOnlyCypherAllowlisted('MATCH (n) WHERE n.name = "please DELETE me" RETURN n', 'neo4j'),
      ).not.toThrow();
    });

    it('does not trip on a forbidden keyword inside a comment', () => {
      expect(() =>
        assertReadOnlyCypherAllowlisted('MATCH (n) RETURN n // TODO CREATE index later', 'neo4j'),
      ).not.toThrow();
      expect(() => assertReadOnlyCypherAllowlisted('MATCH (n) /* MERGE nothing */ RETURN n', 'neo4j')).not.toThrow();
    });
  });

  describe('C1 — single-pass scanner: sequential-regex desync payloads are rejected', () => {
    it.each([
      // `//` inside a string literal: the old line-comment pass ate it plus the
      // rest of the line, hiding both the `;` and the EXPORT DATABASE write.
      ["MATCH (n) WHERE n.name = 'a//b' RETURN n ; EXPORT DATABASE '/tmp/pwn'"],
      // A `'` inside a "…" literal opened a phantom single-quoted literal (the
      // single-quote pass ran before the double-quote pass), swallowing the
      // trailing COPY … TO arbitrary-file write.
      ["MATCH (n) WHERE n.name = \"'\" RETURN n ; COPY (MATCH (m) RETURN m) TO '/tmp/x.csv'"],
      // `/*` inside a string literal: the block-comment pass ran to the next
      // `*/` (or to EOF), blanking the statement separator and the DROP.
      ["MATCH (n) WHERE n.name = 'a/*b' RETURN n ; DROP INDEX foo"],
      ["MATCH (n) WHERE n.name = 'a/*b' RETURN n */ ; EXPORT DATABASE '/tmp/pwn'"],
      // Same trick, double-quoted, hiding an ATTACH of another workspace graph.
      ['MATCH (n) WHERE n.name = "x//y" RETURN n ; ATTACH \'/tmp/other.kz\' AS other'],
      // A `//` inside a backtick identifier must not be read as a comment.
      ['MATCH (n:`a//b`) RETURN n ; CHECKPOINT'],
    ])('rejects desync payload: %s', (query) => {
      expect(() => assertReadOnlyCypherAllowlisted(query, 'ladybug')).toThrow(/read-only|single|multiple/i);
      expect(() => assertReadOnlyCypherAllowlisted(query, 'neo4j')).toThrow(/read-only|single|multiple/i);
    });

    it('rejects the C1 flagship payload as MULTIPLE statements (the `;` stays visible)', () => {
      expect(() =>
        assertReadOnlyCypherAllowlisted(
          "MATCH (n) WHERE n.name = 'a//b' RETURN n ; EXPORT DATABASE '/tmp/pwn'",
          'ladybug',
        ),
      ).toThrow(/single read-only Cypher statement|multiple statements/i);
    });

    it('does not over-reject: // and quotes INSIDE literals are just data', () => {
      expect(() =>
        assertReadOnlyCypherAllowlisted("MATCH (n) WHERE n.name = 'http://x' RETURN n.id", 'neo4j'),
      ).not.toThrow();
      expect(() =>
        assertReadOnlyCypherAllowlisted('MATCH (n) WHERE n.name = "it\'s /* fine */ here" RETURN n.id', 'neo4j'),
      ).not.toThrow();
      expect(() =>
        assertReadOnlyCypherAllowlisted("MATCH (n) WHERE n.name = 'a\\'b' RETURN n.id", 'neo4j'),
      ).not.toThrow();
    });

    it('fails closed on an unterminated string literal', () => {
      expect(() => assertReadOnlyCypherAllowlisted("MATCH (n) WHERE n.name = 'oops RETURN n", 'neo4j')).toThrow(
        /unterminated/i,
      );
    });

    it('fails closed on an unterminated block comment', () => {
      expect(() => assertReadOnlyCypherAllowlisted('MATCH (n) RETURN n /* oops', 'neo4j')).toThrow(/unterminated/i);
    });

    // The third fail-closed throw, and the only one that had no test: an
    // unbalanced backtick would otherwise swallow the rest of the statement —
    // including a trailing `; EXPORT DATABASE` — before either gate reads it.
    it('fails closed on an unterminated quoted identifier', () => {
      expect(() => assertReadOnlyCypherAllowlisted('MATCH (n:`oops) RETURN n', 'neo4j')).toThrow(/unterminated/i);
      expect(() =>
        assertReadOnlyCypherAllowlisted("MATCH (n:`oops) RETURN n ; EXPORT DATABASE '/tmp/x'", 'ladybug'),
      ).toThrow(/unterminated|read-only/i);
    });

    // The scanners below this point are superlinear on adversarial input and every
    // caller passes the string through unbounded, so the cap is the bound on work.
    it('rejects a query past the length cap before scanning it', () => {
      const huge = `MATCH (n) WHERE n.name = '${'a'.repeat(20_000)}' RETURN n.id`;
      expect(() => assertReadOnlyCypherAllowlisted(huge, 'neo4j')).toThrow(/too long/i);
    });

    it('still accepts a long but reasonable query', () => {
      const names = Array.from({ length: 200 }, (_, i) => `'name${i}'`).join(', ');
      expect(() =>
        assertReadOnlyCypherAllowlisted(`MATCH (n) WHERE n.name IN [${names}] RETURN n.id`, 'neo4j'),
      ).not.toThrow();
    });
  });

  describe('C2 — leading-token allowlist (deny-by-default)', () => {
    it.each([
      ['CHECKPOINT'],
      ['ANALYZE'],
      ["EXPORT DATABASE '/tmp/pwn'"],
      ["COPY (MATCH (n) RETURN n) TO '/tmp/p.csv'"],
      ["ATTACH '/tmp/other.kz' AS other"],
      ['USE otherdb MATCH (n) RETURN n'],
      ['INSTALL httpfs'],
      ['SHOW DATABASES'],
      ['CREATE (n:Foo) RETURN n'],
      ['MERGE (n:Foo {id: 1}) RETURN n'],
      ["IMPORT DATABASE '/tmp/p'"],
      ['CALL dbms.components() YIELD name RETURN name'],
      ['CALL { MATCH (n) RETURN n } RETURN 1'],
      // an unknown / future statement type is rejected by construction
      ["FROBNICATE THE '/tmp/database'"],
      ['DEFRAGMENT'],
    ])('rejects non-allowlisted leading keyword: %s', (query) => {
      expect(() => assertReadOnlyCypherAllowlisted(query, 'ladybug')).toThrow(/read-only/i);
      expect(() => assertReadOnlyCypherAllowlisted(query, 'neo4j')).toThrow(/read-only/i);
    });

    it('names the offending leading keyword and the allowed set', () => {
      expect(() => assertReadOnlyCypherAllowlisted('CHECKPOINT', 'ladybug')).toThrow(/CHECKPOINT/);
      expect(() => assertReadOnlyCypherAllowlisted('CHECKPOINT', 'ladybug')).toThrow(/MATCH, OPTIONAL, WITH/);
    });

    it('rejects a statement that does not start with a keyword at all', () => {
      expect(() => assertReadOnlyCypherAllowlisted('(n) RETURN n', 'neo4j')).toThrow(/read-only/i);
      expect(() => assertReadOnlyCypherAllowlisted('`weird` RETURN 1', 'neo4j')).toThrow(/read-only/i);
    });
  });

  describe('embedded (mid-query) mutation keywords are rejected behind a legal leading token', () => {
    it.each([
      ['SET', 'MATCH (n) SET n.x = 1 RETURN n'],
      ['DELETE', 'MATCH (n) DELETE n'],
      ['DETACH', 'MATCH (n) DETACH DELETE n'],
      ['REMOVE', 'MATCH (n) REMOVE n.x RETURN n'],
      ['CREATE', 'MATCH (n) CREATE (m:Foo) RETURN m'],
      ['MERGE', 'MATCH (n) MERGE (m:Foo {id: n.id}) RETURN m'],
      ['FOREACH', 'MATCH (n) FOREACH (x IN [1] | SET n.x = x)'],
      ['CALL', 'MATCH (n) CALL db.x() YIELD v RETURN v'],
      ['LOAD', 'MATCH (n) WITH n LOAD CSV FROM "file:///x.csv" AS row RETURN row'],
      ['COPY', "MATCH (n) WITH n COPY (MATCH (m) RETURN m) TO '/tmp/x.csv'"],
      ['LOAD_EXTENSION', "MATCH (n) WITH LOAD_EXTENSION('/tmp/ext.so') AS x RETURN x"],
      ['CREATE_MACRO', 'MATCH (n) WITH CREATE_MACRO() AS x RETURN x'],
      ['CHECKPOINT', 'MATCH (n) WITH n RETURN n; CHECKPOINT'],
    ])('rejects embedded %s', (_label, query) => {
      expect(() => assertReadOnlyCypherAllowlisted(query, 'neo4j')).toThrow(/read-only|single|multiple/i);
      expect(() => assertReadOnlyCypherAllowlisted(query, 'ladybug')).toThrow(/read-only|single|multiple/i);
    });

    it.each([
      // Alias masking consumes exactly ONE identifier after AS, so a clause
      // that FOLLOWS an alias is still seen by the deny union.
      ['CALL after an alias', 'MATCH (n) WITH n.id AS id CALL db.x() YIELD v RETURN v'],
      ['CREATE after an alias', 'MATCH (n) WITH n.id AS id CREATE (m:Foo) RETURN m'],
      ['MERGE after an alias', 'MATCH (n) WITH n.id AS id MERGE (m:Foo {id: id}) RETURN m'],
      ['SET after an alias', 'MATCH (n) WITH n AS m SET m.x = 1 RETURN m'],
      // `AS` with no alias token cannot swallow the next clause either.
      ['CALL with a dangling AS', 'MATCH (n) WITH n AS CALL db.x() YIELD v RETURN v'],
    ])('still rejects %s', (_label, query) => {
      expect(() => assertReadOnlyCypherAllowlisted(query, 'neo4j')).toThrow(/read-only/i);
      expect(() => assertReadOnlyCypherAllowlisted(query, 'ladybug')).toThrow(/read-only/i);
    });
  });

  describe('structural rejections', () => {
    it('rejects an empty query', () => {
      expect(() => assertReadOnlyCypherAllowlisted('   ', 'neo4j')).toThrow(/empty/i);
    });

    it('rejects a query that is only semicolons', () => {
      expect(() => assertReadOnlyCypherAllowlisted(' ; ; ', 'neo4j')).toThrow(/empty/i);
    });

    it('rejects a leading EXPLAIN (the tool adds its own)', () => {
      expect(() => assertReadOnlyCypherAllowlisted('EXPLAIN MATCH (n) RETURN n', 'neo4j')).toThrow(/EXPLAIN|PROFILE/i);
    });

    it('rejects a leading PROFILE', () => {
      expect(() => assertReadOnlyCypherAllowlisted('PROFILE MATCH (n) RETURN n', 'neo4j')).toThrow(/EXPLAIN|PROFILE/i);
    });

    it('rejects multiple statements separated by a semicolon', () => {
      expect(() => assertReadOnlyCypherAllowlisted('MATCH (n) RETURN n; MATCH (m) RETURN m', 'ladybug')).toThrow(
        /single read-only Cypher statement|multiple/i,
      );
    });

    it('rejects a hidden second statement even if the first is read-only', () => {
      expect(() =>
        assertReadOnlyCypherAllowlisted("MATCH (n) RETURN n; COPY (MATCH (m) RETURN m) TO '/tmp/x.csv'", 'ladybug'),
      ).toThrow(/single|multiple|read-only/i);
    });
  });

  describe('backtick identifiers (Cypher/Kùzu escape a backtick by doubling)', () => {
    it('passes a query with a doubled backtick inside a backtick identifier', () => {
      expect(() => assertReadOnlyCypherAllowlisted('MATCH (n:`weird``label`) RETURN n', 'neo4j')).not.toThrow();
    });

    it('keeps a trailing clause visible after a doubled-backtick identifier', () => {
      // The identifier `weird``label` must close at its final single backtick so
      // the CREATE that follows stays visible to the deny union.
      expect(() =>
        assertReadOnlyCypherAllowlisted('MATCH (n:`weird``label`) CREATE (m:Foo) RETURN m', 'neo4j'),
      ).toThrow(/CREATE/);
    });

    it('rejects a CREATE that a backslash-escape reading would have hidden', () => {
      // Reading `\` as an escaped backtick swallowed everything up to the next
      // backtick, blanking out the CREATE in between → fail-open.
      const attack = 'MATCH (n) WITH n.`a\\` AS x CREATE (y)-[:R]->(z) WHERE z.`b` RETURN z';
      expect(() => assertReadOnlyCypherAllowlisted(attack, 'neo4j')).toThrow(/read-only/i);
    });
  });
});

describe('assertReadOnlyCypher (back-compat wrapper delegates to the dual gate)', () => {
  it('passes read-only queries', () => {
    expect(() => assertReadOnlyCypher('MATCH (n:CodeNode) RETURN n LIMIT 25')).not.toThrow();
  });

  it('rejects mutations and cross-db statements', () => {
    expect(() => assertReadOnlyCypher('CREATE (n:Foo) RETURN n')).toThrow(/read-only/i);
    expect(() => assertReadOnlyCypher('INSERT (n:Foo) RETURN n')).toThrow(/read-only/i);
    expect(() => assertReadOnlyCypher('USE otherdb MATCH (n) RETURN n')).toThrow(/read-only/i);
  });

  it('rejects an empty query', () => {
    expect(() => assertReadOnlyCypher('   ')).toThrow(/empty/i);
  });
});

describe('assertQueryDoesNotProjectSource', () => {
  it.each([
    ['MATCH (n:CodeNode) RETURN n.sourceCode'],
    ['MATCH (n:CodeNode) RETURN n.sourceCode AS x LIMIT 1'],
    ['MATCH (n) RETURN n.properties'],
    ["MATCH (n) WHERE n.properties CONTAINS 'x' RETURN n.name"],
    ['MATCH (n) RETURN regexp_extract(n.properties, \'sourceCode":"([^"]*)\') AS leaked'],
    ['MATCH (n) RETURN n.SOURCECODE'],
  ])('rejects: %s', (query) => {
    expect(() => assertQueryDoesNotProjectSource(query)).toThrow(/source/i);
  });

  it('uses a field-specific, actionable rejection message naming the offending field', () => {
    expect(() => assertQueryDoesNotProjectSource('MATCH (n) RETURN n.sourceCode')).toThrow(
      'Source-in-graph is disabled: this deployment does not serve function/method source bodies, so a Cypher query ' +
        'cannot reference "sourceCode" (a source-bearing field). Project other fields instead — name, type, filePath, ' +
        'startLine, endLine, summary, repoId — or call the describe_db_schema tool for the full field-level schema.',
    );
    expect(() => assertQueryDoesNotProjectSource('MATCH (n) RETURN n.properties')).toThrow(
      'Source-in-graph is disabled: this deployment does not serve function/method source bodies, so a Cypher query ' +
        'cannot reference "properties" (a source-bearing field). Project other fields instead — name, type, filePath, ' +
        'startLine, endLine, summary, repoId — or call the describe_db_schema tool for the full field-level schema.',
    );
  });

  it.each([
    ['MATCH (n:CodeNode) RETURN n.name, n.type, n.filePath'],
    ['MATCH (n) RETURN n.name, n.startLine, n.endLine ORDER BY n.name'],
    ['RETURN $properties AS propertiesParameter, $sourceCode AS sourceCodeParameter'],
    // a mention inside a string literal or comment is not a projection
    ["MATCH (n) WHERE n.name = 'sourceCode' RETURN n.name"],
    ['MATCH (n) RETURN n.name // no properties here'],
    ['MATCH (n) RETURN n.propertiesCount'],
  ])('passes: %s', (query) => {
    expect(() => assertQueryDoesNotProjectSource(query)).not.toThrow();
  });

  it('is not fooled by a quote-desync attempt hiding the projection', () => {
    expect(() => assertQueryDoesNotProjectSource("MATCH (n) WHERE n.name = 'a//b' RETURN n.sourceCode")).toThrow(
      /source/i,
    );
  });

  // `n.*` expands to the whole node table on Ladybug — id, type, name,
  // properties, summary, embedding — so it reaches exactly the blob that
  // `n.properties` is rejected for. Verified against a real graph before the
  // fix: the star projection returned the properties column verbatim.
  describe('star projections', () => {
    it.each([
      ['MATCH (n) RETURN n.*'],
      ['MATCH (n:CodeNode) RETURN n.* LIMIT 1'],
      ['MATCH (n) RETURN n .*'],
      ['MATCH (a)-[r:CALLS]->(b) RETURN b.*'],
      // `x` is bound by a list comprehension, not a relationship pattern, so it
      // is NOT a relationship variable even though it sits inside brackets.
      ['MATCH (n) WITH [x IN [n] | x] AS xs UNWIND xs AS x RETURN x.*'],
      // Rebinding a relationship to a new name loses the proof — blocked.
      ['MATCH (a)-[r:CALLS]->(b) WITH r AS e RETURN e.*'],
    ])('rejects a node-side star projection: %s', (query) => {
      expect(() => assertQueryDoesNotProjectSource(query)).toThrow(/expands to every column of the node table/i);
    });

    it('names the safe alternative instead of refusing bare', () => {
      expect(() => assertQueryDoesNotProjectSource('MATCH (n) RETURN n.*')).toThrow(/n\.name/);
      expect(() => assertQueryDoesNotProjectSource('MATCH (n) RETURN n.*')).toThrow(/describe_db_schema/);
    });
  });

  // Edge `properties` is operation metadata on a separate column of a separate
  // table (`{"operation":"read"}` on OPERATES_ON); it cannot carry source, and
  // blocking it made the guard read as "the whole properties vocabulary is
  // off-limits".
  describe('relationship property access', () => {
    it.each([
      ['MATCH (a)-[r:OPERATES_ON]->(b) RETURN r.properties'],
      ['MATCH (a)-[r:OPERATES_ON]->(b) RETURN r.*'],
      ['MATCH (a)<-[r:RESOLVES_TO]-(b) RETURN a.name, r.properties, b.name'],
      ['MATCH (a)-[rel:CALLS]->(b) RETURN rel.properties AS meta'],
    ])('allows: %s', (query) => {
      expect(() => assertQueryDoesNotProjectSource(query)).not.toThrow();
    });

    it.each([
      // Same name used in node position somewhere in the query → not proven.
      ['MATCH (r)-[e:CALLS]->(b), (a)-[r2:CALLS]->(c) RETURN r.properties'],
      // A node projection alongside an allowed edge projection still fires.
      ['MATCH (a)-[r:CALLS]->(b) RETURN r.properties, b.properties'],
      ['MATCH (a)-[r:CALLS]->(b) RETURN r.properties, b.sourceCode'],
    ])('still rejects: %s', (query) => {
      expect(() => assertQueryDoesNotProjectSource(query)).toThrow(/source-bearing field/i);
    });
  });

  // A field name that never reaches the identifier-scan: verified to project
  // source in an adversarial pass. The scrubber blanks backtick identifiers and
  // string literals, so the field name is invisible by the time the scan runs;
  // bracket access and keys()/reduce name the field via a variable, not a literal.
  describe('dynamic and quoted field access (fail closed)', () => {
    it.each([
      // backtick-quoted property name — scrubbed to `` before the field scan
      ['MATCH (n) RETURN n.`sourceCode`'],
      ['MATCH (n) RETURN n.`properties`'],
      // bracket property access with a string-literal or variable key
      ["MATCH (n) RETURN n['sourceCode']"],
      ['MATCH (n) UNWIND keys(n) AS k RETURN n[k]'],
      // …and the SPACED forms. openCypher admits `SP?` before the index operator,
      // so requiring the bracket to be glued to the identifier let every one of
      // these reach a source-bearing field past both gates.
      ["MATCH (n) RETURN n ['sourceCode']"],
      ["MATCH (n) RETURN n\t['sourceCode']"],
      ["MATCH (n) WITH n AS x RETURN x  ['sourceCode']"],
      // a call RESULT is indexable too, so `)` is an operand like any identifier
      ["MATCH (n) RETURN head(collect(n))['sourceCode']"],
      // the key never appears as an identifier: it is a blanked string literal
      // carried in through a list, then applied with a space
      ["MATCH (n) UNWIND ['sourceCode'] AS k RETURN n [k]"],
      // CHAINED subscripting. The receiver ends in `]` or `}` rather than an
      // identifier, so a guard that enumerated receiver SHAPES admitted these —
      // the reason the rule is now stated as "prove a list literal is legal here".
      ["MATCH (n) RETURN [n][0]['sourceCode']"],
      ["MATCH (n) RETURN {x:n}['x']['sourceCode']"],
      ["MATCH (n) RETURN [n][0] ['sourceCode']"],
      ["MATCH (n) RETURN [[n]][0][0]['sourceCode']"],
      ["MATCH (n) RETURN collect(n)[0]['sourceCode']"],
      // …and admitting DISTINCT / ORDER BY as list-literal positions must not open
      // a subscript behind them: the operand there is the variable, not the keyword.
      ["MATCH (n) RETURN DISTINCT n['sourceCode']"],
      ["MATCH (n) RETURN n.id ORDER BY n['sourceCode']"],
      ["MATCH (n) RETURN DISTINCT [n][0]['sourceCode']"],
      ["MATCH (n) RETURN reduce(a = '', k IN ['sourceCode'] | a + n [k])"],
      // keys()+reduce concatenates EVERY property into one scalar
      ["MATCH (n) RETURN reduce(acc = '', k IN keys(n) | acc + toString(n[k])) AS blob"],
      // map projection expands node properties; `{.` is not seen by the `x.*` scan
      ['MATCH (n) RETURN n{.*}'],
      ['MATCH (n) RETURN n{.sourceCode}'],
    ])('rejects: %s', (query) => {
      expect(() => assertQueryDoesNotProjectSource(query)).toThrow(/source-bearing field|source-field guard/i);
    });

    // The bracket rule is deliberately fail-closed, so it also rejects LIST indexing
    // on a projected alias (`names[0]`) — syntactically identical to `n[k]`. The
    // rejection message must SAY so and name the way out, instead of reading as a
    // bare "bracket property access" complaint about a query that touched no property.
    it('names list indexing in the bracket-access rejection message', () => {
      const query = 'MATCH (n) WITH collect(n.name) AS names RETURN names[0]';
      expect(() => assertQueryDoesNotProjectSource(query)).toThrow(/list indexing/i);
      expect(() => assertQueryDoesNotProjectSource(query)).toThrow(/head\(/i);
    });

    it.each([
      // `IN [...]` is a list literal, not property access
      ['MATCH (n) WHERE n.id IN [1, 2, 3] RETURN n.name'],
      ['MATCH (n) WHERE n.type IN ["function", "method"] RETURN n.name'],
      // list comprehension / relationship metadata stay allowed
      ['MATCH (a)-[r:OPERATES_ON]->(b) RETURN r.properties'],
      // A list built directly in a clause is a literal too — these are the shapes
      // the operand allowlist has to keep working now that spacing no longer
      // distinguishes a literal from an index.
      ['MATCH (n) RETURN [1, 2, 3] AS xs'],
      ['UNWIND [1, 2, 3] AS x RETURN x'],
      ['MATCH (n) WITH [n.name] AS xs RETURN size(xs)'],
      ["MATCH (n) WHERE n.type IN ['function'] AND n.name CONTAINS 'x' RETURN n.name"],
      // A list literal is legal wherever an expression begins, so the inverted
      // rule has to keep every one of these positions open.
      ['MATCH (n) RETURN size([1, 2])'],
      ['MATCH (n) RETURN coalesce(n.name, [1])'],
      ['MATCH (n) RETURN [[1], [2]] AS nested'],
      ['MATCH (n) RETURN {a: [1, 2]} AS m'],
      // `-[` is a relationship pattern, not a subscript.
      ['MATCH (a)-[r:CALLS]->(b) WHERE r.line > 1 RETURN a.name, b.name'],
      ['MATCH (p)-[:HAS_METHOD]->(m) RETURN p.name, m.name'],
      // A list literal may also follow DISTINCT / ORDER BY / CASE — the keyword
      // sits immediately before the bracket in those, so they need naming or an
      // ordinary source-free projection is refused.
      ['MATCH (n) RETURN DISTINCT [n.type] AS xs'],
      ['MATCH (n) RETURN [n.type] AS xs ORDER BY [n.type]'],
      ['MATCH (n) WITH DISTINCT [n.type] AS t RETURN t'],
      ['MATCH (n) RETURN CASE [1, 2] WHEN [1, 2] THEN 1 ELSE 0 END AS c'],
    ])('still allows: %s', (query) => {
      expect(() => assertQueryDoesNotProjectSource(query)).not.toThrow();
    });
  });

  // The reverse of `WITH r AS n`: aliasing a NODE *into* a name the relationship
  // pattern proved. Verified live against Ladybug before the binder rule existed —
  // `WITH a AS r RETURN r.properties` returned the node blob (sourceCode included)
  // with the serve flag off.
  describe('rebinding a trusted relationship name (fail closed)', () => {
    it.each([
      // WITH aliases a node onto the relationship name.
      ['MATCH (a)-[r:CALLS]->(b) WITH a AS r RETURN r.properties'],
      ['MATCH (a)-[r:CALLS]->(b) WITH a AS r RETURN r.*'],
      // Lowercase keyword, and the alias masking used by the read-only gate must
      // not hide the binding from this scan either.
      ['MATCH (a)-[r:CALLS]->(b) with a as r return r.properties'],
      // UNWIND rebinds the name to a list element (which can be a node).
      ['MATCH (a)-[r:CALLS]->(b) WITH collect(a) AS xs UNWIND xs AS r RETURN r.properties'],
      // Multi-WITH chain: the rebinding hop is not adjacent to the projection.
      ['MATCH (a)-[r:CALLS]->(b) WITH a AS m, r WITH m AS r RETURN r.properties'],
      // A UNION branch rebinds the name the other branch proved.
      ['MATCH (a)-[r:CALLS]->(b) RETURN r.properties UNION MATCH (n) WITH n AS r RETURN r.properties'],
      // A list-comprehension binder can bind a node to the name too.
      ['MATCH (a)-[r:CALLS]->(b) RETURN [r IN collect(a) | r.properties]'],
      // A backtick-quoted alias hides the bound name from the scrubber, so no
      // name in the query is provable.
      ['MATCH (a)-[r:CALLS]->(b) WITH a AS `r` RETURN r.properties'],
    ])('rejects: %s', (query) => {
      expect(() => assertQueryDoesNotProjectSource(query)).toThrow(/source/i);
    });

    it('still allows a relationship projection that is never a binder target', () => {
      expect(() =>
        assertQueryDoesNotProjectSource('MATCH (a)-[r:OPERATES_ON]->(b) WITH a, r WHERE a.name = b.name RETURN r.*'),
      ).not.toThrow();
      expect(() =>
        assertQueryDoesNotProjectSource(
          'MATCH (a)-[r:OPERATES_ON]->(b) WITH a, r, b ORDER BY a.name WITH r, b RETURN r.properties',
        ),
      ).not.toThrow();
    });
  });
});
