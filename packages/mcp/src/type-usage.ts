/**
 * Rendering of USES_TYPE consumer rows, shared by the tools that list them.
 *
 * A consumer that annotates with a type and a consumer that reads ONE enum
 * member answer different impact questions: the first breaks on a shape change,
 * the second is the one an added member silently bypasses. The graph now
 * distinguishes them (TypeUsage.useKind / .member), so the rendered rows must
 * too — and identically across find_dependents / analyze_change_impact, so the
 * same consumer never reads as two different facts.
 *
 * Honesty boundary: `useKind` is absent on rows stored before the distinction
 * existed and on substrates that do not detect value-position references.
 * Absent means "type-level or undetermined" — such a row renders exactly as it
 * always did, and the absence of value rows is never rendered as "no
 * member-value reads exist".
 *
 * Second honesty boundary: `ambiguous` marks a row the graph resolved by NAME
 * only (the import specifier named no repo file — a package or a path alias —
 * so symbol identity could not be checked). Such a row may name a different
 * symbol that happens to share the name, so it must never read like a proven
 * consumer.
 */

import { TypeUseKind } from '@coredoc/db/types';
import type { TypeUsage } from '@coredoc/db/types';

/** How many branched members the enum usage note names before eliding. */
const MAX_NAMED_MEMBERS = 5;

/** Suffix for a row (or a note covering rows) whose symbol identity was never verified. */
const UNVERIFIED_IDENTITY = ' — unverified identity (name-matched import)';

/**
 * Summary line for one consumer row: the existing `used as <usage> (<via>)`
 * idiom, plus a value-position suffix naming the member that is branched on.
 */
export function typeUsageSummary(usage: TypeUsage, typeName: string): string {
  const base = usage.via ? `used as ${usage.usage} (${usage.via})` : `used as ${usage.usage}`;
  const identity = usage.ambiguous ? UNVERIFIED_IDENTITY : '';
  // Construction and import name what the consumer DOES, not the syntactic slot it fills — "used
  // as construction" reads as a type position, which is exactly what these rows are not. Checked
  // before the value-position branch below, which is about enum members only.
  if (usage.usage === 'construction') return `constructs ${typeName}${identity}`;
  if (usage.usage === 'import') {
    // The local alias, when the importing module renamed the symbol, is the name a reader greps for.
    const alias = usage.via && usage.via !== typeName ? ` (as ${usage.via})` : '';
    return `imports ${typeName}${alias}${identity}`;
  }
  if (usage.useKind !== TypeUseKind.Value) return `${base}${identity}`;
  return usage.member
    ? `${base} — branches on ${typeName}.${usage.member} (value)${identity}`
    : `${base} — member-value read (value)${identity}`;
}

/**
 * Sub-line for an enum usage figure that mixes both relations: how many of the
 * counted usages are member-value reads, and which members they branch on.
 * Undefined when no value row is present — a silent absence, never a claim
 * that none exist.
 *
 * Only members from identity-VERIFIED rows are named: a name-matched row may be
 * about a different enum, and naming its member would assert a branch that may
 * not exist. Their presence is still declared by the suffix, so the mixture is
 * visible and the per-row summaries say which rows they are.
 */
export function memberValueUsageNote(usages: TypeUsage[], typeName: string): string | undefined {
  const valueRows = usages.filter((u) => u.useKind === TypeUseKind.Value);
  if (valueRows.length === 0) return undefined;

  const members = [
    ...new Set(
      valueRows
        .filter((u) => !u.ambiguous)
        .map((u) => u.member)
        .filter((m): m is string => Boolean(m)),
    ),
  ];
  const identity = valueRows.some((u) => u.ambiguous) ? UNVERIFIED_IDENTITY : '';
  const head = `${valueRows.length} of ${usages.length} usages are member-value reads`;
  if (members.length === 0) return `${head}${identity}`;

  const named = members.slice(0, MAX_NAMED_MEMBERS).map((m) => `${typeName}.${m}`);
  const overflow = members.length > MAX_NAMED_MEMBERS ? `, +${members.length - MAX_NAMED_MEMBERS} more` : '';
  return `${head} (branches on ${named.join(', ')}${overflow})${identity}`;
}
