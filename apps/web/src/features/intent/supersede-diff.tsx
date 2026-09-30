/**
 * The supersede diff.
 *
 * A replacement candidate offers to retire an accepted item, and without this
 * the reviewer approves that swap blind: the card names the predecessor and
 * nothing else. This shows what actually changes — statement, every payload
 * field, and the sources — with the old value struck through and the new one on
 * the brand wash.
 *
 * Two rules the rendering follows:
 *
 * 1. **Unchanged fields are collapsed, never dropped**, and the count is stated.
 * 2. **A record that is not loaded says so.** The by-id read is bounded and can
 *    legitimately miss an entry; that renders as a plain sentence, never as an
 *    empty diff that would read as "nothing changes".
 */

import { useState } from 'react';
import { contextConditionText } from './intent-presentation.js';
import type { ContextCondition, IntentContextMatch, IntentItemSource } from './types.js';

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

/** An array is one field with one line per element — not N fields. */
const formatArray = (values: readonly unknown[]): string => values.map(formatScalar).join('\n');

/**
 * Flatten a payload into `key -> printable value`, dotted through nested
 * objects. A payload is free-form, so this asserts no kind-specific shape.
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
 * payloads' keys (predecessor order first), then the sources.
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
  /** The by-id read is still in flight — a different sentence from "could not be read". */
  predecessorLoading?: boolean;
}

export function IntentSupersedeDiff({
  predecessorId,
  predecessorVersion,
  predecessor,
  successor,
  predecessorLoading = false,
}: IntentSupersedeDiffProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-2 rounded-lg bg-surface-2 px-2.5 py-2 text-[11.5px]" data-intent-supersede-diff={predecessorId}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-ink-2">
          Proposes to replace <span className="font-mono text-ink-1">{predecessorId}</span>
          {predecessorVersion === undefined ? '' : ` (v${predecessorVersion})`}
        </span>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="rounded-md px-2 py-0.5 text-[11.5px] text-ink-3 transition-colors hover:bg-surface hover:text-ink-1"
        >
          {open ? 'Hide diff' : 'Show diff'}
        </button>
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
      <p className="mt-2 text-[11px] text-ink-4">
        {predecessorLoading
          ? 'Reading the predecessor…'
          : 'Predecessor not loaded — its current content could not be read, so this swap cannot be compared here.'}
      </p>
    );
  }
  if (successor === undefined) {
    return (
      <p className="mt-2 text-[11px] text-ink-4">
        Successor detail not loaded — the queue row carries no statement or payload to compare.
      </p>
    );
  }

  const rows = supersedeDiffRows(predecessor, successor);
  const changed = rows.filter((row) => row.changed);
  const unchanged = rows.length - changed.length;

  return (
    <div className="mt-[7px] flex flex-col gap-[5px] text-[12px]">
      {changed.length === 0 ? (
        <p className="text-[11px] text-ink-4">
          Nothing changes between the two — the successor restates the predecessor.
        </p>
      ) : (
        changed.map((row) => (
          <div key={row.label} className="flex flex-col gap-[5px]">
            <span className="font-mono text-[10.5px] text-ink-4">{row.label}</span>
            <span className="whitespace-pre-wrap rounded-md bg-danger-wash px-[9px] py-[5px] text-ink-2 line-through decoration-danger-text">
              {row.before === '' ? '—' : row.before}
            </span>
            <span className="whitespace-pre-wrap rounded-md bg-brand-wash px-[9px] py-[5px] text-ink-1">
              {row.after === '' ? '—' : row.after}
            </span>
          </div>
        ))
      )}
      {unchanged > 0 && (
        <p className="num text-[10.5px] text-ink-4">
          {unchanged} unchanged {unchanged === 1 ? 'field' : 'fields'}
        </p>
      )}
    </div>
  );
}
