/**
 * The right-hand column when a domain or feature is selected and no rule is:
 * what the node says, when it applies, and what that condition reaches.
 *
 * Read-only. Tree writes stay in the editor (admin) and in agent actions; this
 * pane only shows the node's own conditions and, for a feature, the domain's,
 * labelled by source — never merged, so a reader sees which level says what.
 */

import type { IntentCountCell } from './intent-panel-state.js';
import { conditionDimensions, contextConditionText, formatIntentTimestamp } from './intent-presentation.js';
import type { IntentDimension, IntentDomainView, IntentFeatureSeed } from './types.js';

interface IntentNodePanelProps {
  domain: IntentDomainView;
  /** `null` for a domain selection. */
  feature: IntentDomainView | null;
  dimensions: readonly IntentDimension[] | null;
  /** Live rules counted for this node by the tree read (a domain's whole subtree); `null` while unread. */
  count: IntentCountCell | null;
  seeds: IntentFeatureSeed[] | null;
  seedsTruncated: boolean;
}

export function IntentNodePanel({ domain, feature, dimensions, count, seeds, seedsTruncated }: IntentNodePanelProps) {
  const node = feature ?? domain;
  const level = feature ? 'feature' : 'domain';
  const own = node.appliesWhen ?? [];
  const inherited = feature ? (domain.appliesWhen ?? []) : [];
  const used = conditionDimensions([...inherited, ...own], dimensions);

  return (
    <div className="space-y-4 p-4 text-[13.5px]">
      <div>
        <h3 className="text-[15px] font-medium text-ink-1">{node.title}</h3>
        <p className="font-mono text-[11.5px] text-ink-4">{node.id}</p>
        {node.statement && <p className="mt-2 text-ink-2">{node.statement}</p>}
      </div>

      <section className="space-y-1">
        <h4 className="text-[11.5px] uppercase tracking-[0.04em] text-ink-4">Applies when</h4>
        {own.length === 0 && inherited.length === 0 ? (
          <p className="text-ink-3">Always — this {level} sets no conditions.</p>
        ) : (
          <>
            <ul className="space-y-0.5 text-ink-2">
              {inherited.map((clause) => (
                <li key={`domain:${JSON.stringify(clause)}`} className="flex flex-wrap items-baseline gap-1.5">
                  <span>{contextConditionText(clause)}</span>
                  <span className="text-[11.5px] text-ink-4">from domain {domain.title}</span>
                </li>
              ))}
              {own.map((clause) => (
                <li key={`own:${JSON.stringify(clause)}`}>{contextConditionText(clause)}</li>
              ))}
            </ul>
            <p className="text-[12px] text-ink-4">These conditions filter every rule below this {level}.</p>
          </>
        )}
      </section>

      <section className="space-y-1">
        <h4 className="text-[11.5px] uppercase tracking-[0.04em] text-ink-4">Rules in scope</h4>
        <p className="num text-ink-2">
          {count === null
            ? 'Not counted yet'
            : `${count.items} ${count.items === 1 ? 'rule' : 'rules'}${count.pending > 0 ? ` · ${count.pending} candidate` : ''}`}
        </p>
      </section>

      {used.length > 0 && (
        <section className="space-y-1">
          <h4 className="text-[11.5px] uppercase tracking-[0.04em] text-ink-4">Dimensions used</h4>
          <ul className="space-y-0.5">
            {used.map((dimension) => (
              <li key={dimension.id} title={dimension.id} className="text-ink-2">
                <span className="text-ink-1">{dimension.title}</span>: {dimension.values.join(', ')}
              </li>
            ))}
          </ul>
        </section>
      )}

      {feature && (
        <section className="space-y-1">
          <h4 className="text-[11.5px] uppercase tracking-[0.04em] text-ink-4">Seeds</h4>
          {seeds === null ? (
            <p className="text-[12px] text-ink-4">Loading seeds…</p>
          ) : seeds.length === 0 ? (
            <p className="text-[12px] text-ink-4">No seeds on this feature.</p>
          ) : (
            <ul className="space-y-1">
              {seeds.map((seed) => (
                <li key={`${seed.repoKey}\n${seed.nodeId}`}>
                  <span className="block truncate font-mono text-[12px] text-ink-2" title={seed.nodeId}>
                    {seed.repoKey} · {seed.nodeId}
                  </span>
                  <span className="text-[11.5px] text-ink-4">
                    {seed.note ? `${seed.note} · ` : ''}added {formatIntentTimestamp(seed.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {seedsTruncated && (
            <p className="text-[11.5px] text-warn-text">This feature has more seeds than one read returns.</p>
          )}
        </section>
      )}
    </div>
  );
}
