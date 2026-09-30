/**
 * The supersede diff (issue v1.1-01).
 *
 * A replacement candidate offers to retire an accepted item, and before this
 * existed the reviewer approved that swap blind: the card named the predecessor
 * and nothing else. This shows what actually changes — statement, every payload
 * field, and the sources — with the old value struck through and the new one on
 * the brand wash.
 *
 * Two rules the rendering follows:
 *
 * 1. **Unchanged fields are collapsed, never dropped.** A diff that hides how
 *    much stayed the same reads as a bigger change than it is, so the count is
 *    always stated.
 * 2. **A record that is not loaded says so.** `predecessorItems` is bounded (one
 *    context read by exact id) and can legitimately miss an entry — that is
 *    `predecessorsTruncated`. It renders as a plain sentence, never as an empty
 *    diff that would read as "nothing changes".
 */

import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { contextConditionText } from './intent-presentation';
import type { ContextCondition, IntentContextMatch, IntentItemSource } from '../../../shared/intent-types.js';

/** One field, as the predecessor and the successor state it. */
export interface IntentDiffRow {
  label: string;
  before: string;
  after: string;
  changed: boolean;
}

const formatScalar = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

/** An array is one field with one line per element — not N fields (spec §3.3). */
const formatArray = (values: readonly unknown[]): string => values.map(formatScalar).join('\n');

/**
 * Flatten a payload into `key -> printable value`, dotted through nested
 * objects. A payload is free-form (spec D9), so this asserts no kind-specific
 * shape: whatever keys are there are the keys that get compared.
 */
export function flattenPayload(payload: unknown, prefix = ''): Record<string, string> {
  if (payload === null || payload === undefined) return {};
  if (Array.isArray(payload)) return { [prefix === '' ? 'value' : prefix]: formatArray(payload) };
  if (typeof payload !== 'object') return { [prefix === '' ? 'value' : prefix]: formatScalar(payload) };

  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (Array.isArray(value)) flat[path] = formatArray(value);
    else if (value !== null && typeof value === 'object') Object.assign(flat, flattenPayload(value, path));
    else flat[path] = formatScalar(value);
  }
  return flat;
}

const formatSources = (sources: readonly IntentItemSource[]): string =>
  sources.map((source) => `${source.kind} ${source.ref}#${source.localId}`).join('\n');

/** Item-level `appliesWhen`, one clause per line — the same shape a payload array gets. */
const formatConditions = (conditions: readonly ContextCondition[] | undefined): string =>
  (conditions ?? []).map(contextConditionText).join('\n');

/**
 * Predecessor vs successor, field by field: statement first, `appliesWhen`
 * (item-level, not part of the payload — ADR-1), then the union of the two
 * payloads' keys (predecessor order first, successor-only keys after), then
 * the sources.
 */
export function supersedeDiffRows(predecessor: IntentContextMatch, successor: IntentContextMatch): IntentDiffRow[] {
  const before = flattenPayload(predecessor.payload);
  const after = flattenPayload(successor.payload);
  const keys = [...Object.keys(before), ...Object.keys(after).filter((key) => !(key in before))];

  const rows: IntentDiffRow[] = [
    { label: 'Statement', before: predecessor.statement, after: successor.statement, changed: false },
    {
      label: 'Applies when',
      before: formatConditions(predecessor.appliesWhen),
      after: formatConditions(successor.appliesWhen),
      changed: false,
    },
    ...keys.map((key) => ({ label: key, before: before[key] ?? '', after: after[key] ?? '', changed: false })),
    {
      label: 'Sources',
      before: formatSources(predecessor.sources),
      after: formatSources(successor.sources),
      changed: false,
    },
  ];

  return rows.map((row) => ({ ...row, changed: row.before !== row.after }));
}

export interface IntentSupersedeDiffProps {
  predecessorId: string;
  /** The predecessor's currently loaded version; absent when it could not be read. */
  predecessorVersion?: number;
  predecessor?: IntentContextMatch;
  successor?: IntentContextMatch;
  /**
   * The by-id read that would supply the predecessor is still in flight. A
   * record that has not arrived yet is not a record that could not be read, so
   * the two say different sentences.
   */
  predecessorLoading?: boolean;
  /** Open on first render. The toggle owns the state after that. */
  defaultOpen?: boolean;
}

export function IntentSupersedeDiff({
  predecessorId,
  predecessorVersion,
  predecessor,
  successor,
  predecessorLoading = false,
  defaultOpen = false,
}: IntentSupersedeDiffProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="flex flex-col gap-2" data-intent-supersede-diff={predecessorId}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] leading-4 text-content-secondary">
          Proposes to replace <span className="font-mono text-content-primary">{predecessorId}</span>
          {predecessorVersion === undefined ? '' : ` (v${predecessorVersion})`}
        </span>
        <Button type="button" variant="ghost" size="xs" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide diff' : 'Show diff'}
        </Button>
      </div>

      {open && (
        <SupersedeDiffBody predecessor={predecessor} successor={successor} predecessorLoading={predecessorLoading} />
      )}
    </div>
  );
}

function SupersedeDiffBody({
  predecessor,
  successor,
  predecessorLoading,
}: {
  predecessor?: IntentContextMatch;
  successor?: IntentContextMatch;
  predecessorLoading: boolean;
}) {
  if (predecessor === undefined) {
    return (
      <p className="rounded-lg border border-border-tertiary px-3 py-2 text-[11px] leading-4 text-content-tertiary">
        {predecessorLoading
          ? 'Reading the predecessor…'
          : 'Predecessor not loaded — its current content could not be read, so this swap cannot be compared here.'}
      </p>
    );
  }
  if (successor === undefined) {
    return (
      <p className="rounded-lg border border-border-tertiary px-3 py-2 text-[11px] leading-4 text-content-tertiary">
        Successor detail not loaded — the queue row carries no statement or payload to compare.
      </p>
    );
  }

  const rows = supersedeDiffRows(predecessor, successor);
  const changed = rows.filter((row) => row.changed);
  const unchanged = rows.length - changed.length;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border-tertiary p-3">
      {changed.length === 0 ? (
        <p className="text-[11px] leading-4 text-content-tertiary">
          Nothing changes between the two — the successor restates the predecessor.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {changed.map((row) => (
            <li key={row.label} className="flex flex-col gap-1">
              <span className="font-mono text-[11px] leading-4 text-content-quaternary">{row.label}</span>
              {/* Shipped tag washes, not ad-hoc alpha over a fill token: amber
                  is the "changed / old" tag, green the "new" one. */}
              <span className="whitespace-pre-wrap rounded-md bg-bg-tag-warning px-2 py-1 text-[11px] leading-4 text-content-primary line-through">
                {row.before === '' ? '—' : row.before}
              </span>
              <span className="whitespace-pre-wrap rounded-md bg-bg-tag-success px-2 py-1 text-[11px] leading-4 text-content-primary">
                {row.after === '' ? '—' : row.after}
              </span>
            </li>
          ))}
        </ul>
      )}
      {unchanged > 0 && (
        <p className="text-[11px] leading-4 text-content-quaternary tabular-nums">
          {unchanged} unchanged {unchanged === 1 ? 'field' : 'fields'}
        </p>
      )}
    </div>
  );
}
