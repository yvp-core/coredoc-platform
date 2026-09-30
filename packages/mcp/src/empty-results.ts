/**
 * Explicit-emptiness vocabulary for tool responses.
 *
 * Several list-shaped tools used to render an empty result as nothing but the
 * provenance banner plus a title — the agent saw no statement of emptiness, and
 * the eval gap detector counted those calls as successes. Every empty response
 * must therefore carry this marker in its body.
 *
 * A leaf module (no imports) so tool handlers can use the marker in tests that
 * mock `response-formatter` away.
 */

/** The literal every empty list-shaped response must contain. */
export const ZERO_RESULTS_MARKER = '**0 results**';

/**
 * One explicit zero-result line: the marker plus what was searched, so the
 * agent can see WHICH filter produced the emptiness without re-reading its own
 * tool call.
 */
export function zeroResultsLine(what: string): string {
  return `${ZERO_RESULTS_MARKER} — ${what}`;
}

/**
 * The sentence an empty SCOPED lookup adds when the same name is declared in
 * sibling repositories: an emptiness that is only an emptiness *here* reads as
 * "this symbol does not exist" unless the response names where it does exist.
 * Callers pass repo names already resolved and sorted.
 */
export function declaredElsewhereLine(name: string, repos: string[]): string {
  return (
    `"${name}" is not in this scope, but the name is declared in: ${repos.join(', ')}` +
    ` (re-call with scope="${repos[0]}", or treat it as an external import here).`
  );
}
