import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Magnifer } from '@solar-icons/react';
import { Input } from '../../../components/ui/input';
import { graphNodesByTypeQueryOptions, graphSearchQueryOptions } from '../../../api/graph.js';
import { graphOverviewQueryOptions } from '../../../api/graph.js';
import { humanizeType, nodeColor } from '../../../lib/viz-style.js';
import { useExplorer } from '../explorer-context.js';
import { seedKey, visibleCountOfType } from '../explorer-graph.js';
import { chipCounts, chipDisclosure, seedShare } from '../explorer-counts.js';
import { FilterChip } from './FilterChip';
import { AskGraphBox } from './AskGraphBox';
import { cn } from '../../../lib/utils';

/**
 * How many nodes ONE type chip may put on the canvas, across every repo.
 *
 * This is a rendering budget, not a data limit. It is sized against the whole
 * chip row, not against one click: there are ten node types, so 500 apiece is
 * what lets a user light several of them and still meet CANVAS_NODE_CAP rather
 * than a frozen canvas. The cap is the backstop; this is the number that keeps
 * ordinary use away from it.
 *
 * The budget is split evenly across the selected repos rather than spent per
 * repo — three repos get ~166 each, not 500 each — so a multi-repo workspace
 * does not multiply one chip click by its repo count.
 *
 * The main process clamps the per-repo ask to its own NODES_MAX (higher for
 * local than the cloud server's 200), so a share may come back short.
 */
const SEED_BUDGET = 500;

export interface ExplorerLeftPanelBodyProps {
  /** Repos the workspace knows about, from config — not from the graph. */
  workspaceRepoNames: string[];
}

/** Search, node-type chips and repo chips for the Graph tab. */
export function ExplorerLeftPanelBody({ workspaceRepoNames }: ExplorerLeftPanelBodyProps) {
  const { scope, allRepos, state, dispatch, source, setSource, canUseCloud, canUseLocal } = useExplorer();
  const { data: overview } = useQuery(graphOverviewQueryOptions(scope));

  const selectedRepos = useMemo(() => allRepos.filter((r) => !state.hiddenRepos.has(r)), [allRepos, state.hiddenRepos]);

  const counts = useMemo(
    () => chipCounts(overview, workspaceRepoNames.length > 0 ? workspaceRepoNames : allRepos, selectedRepos),
    [overview, workspaceRepoNames, allRepos, selectedRepos],
  );
  const inGraph = useMemo(() => new Set(overview?.repos.map((r) => r.name) ?? []), [overview]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-0.5 pb-4 pt-1.5">
      {/* Only a project with both graphs gets a switch. An invited member has no
          local project id to resolve at all, so a "local" option there is a dead
          control that lands on an empty canvas — the provider defaults such a
          project to cloud instead. */}
      {canUseCloud && canUseLocal && (
        <div className="mx-3 mt-3 flex items-center rounded-full border border-border-input bg-bg-primary p-0.5 text-xs">
          {(['local', 'cloud'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={source === option}
              onClick={() => setSource(option)}
              className={cn(
                'flex-1 cursor-pointer rounded-full px-2 py-1 capitalize transition-colors',
                source === option
                  ? 'bg-bg-action-primary text-content-inverted'
                  : 'text-content-secondary hover:bg-bg-primary-hover',
              )}
            >
              {option}
            </button>
          ))}
        </div>
      )}

      <SearchBox />

      <AskGraphBox />

      <section className="flex flex-col gap-2">
        <div className="px-3 pt-3">
          <h3 className="text-sm font-black leading-5 text-content-primary">Nodes:</h3>
          <p className="text-xs leading-4 text-content-quaternary">We show up to 200 nodes per type</p>
        </div>
        <div className="flex flex-wrap gap-x-1 gap-y-1.5 px-3">
          {counts.chips.map((chip) => (
            <NodeTypeChip key={chip.type} type={chip.type} count={chip.count} />
          ))}
        </div>
      </section>

      {allRepos.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="px-3 pt-3 text-sm font-black leading-5 text-content-primary">Repositories:</h3>
          <div className="flex flex-wrap gap-x-1 gap-y-1.5 px-3">
            {allRepos.map((repo) => {
              const missing = overview !== undefined && !inGraph.has(repo);
              return (
                <FilterChip
                  key={repo}
                  label={repo}
                  color="var(--color-content-quaternary)"
                  active={!state.hiddenRepos.has(repo)}
                  disabled={missing}
                  title={missing ? 'Not in the graph yet — push this repo first' : undefined}
                  onToggle={() => dispatch({ kind: 'toggleRepo', repo })}
                />
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * A type chip means "this type is on the canvas".
 *
 * First click marks the type seeded and un-hides it; later clicks toggle
 * visibility without refetching, because the nodes never left the reducer —
 * only `deriveVisible` stopped emitting them.
 *
 * The fetching is deliberately NOT in the click handler. A seeded type owes the
 * canvas one page per *selected* repo, and that debt outlives the click: showing
 * a repo the user had hidden when they seeded the type has to pull that repo's
 * page too. So the click only records the intent and the effect below settles
 * whatever is still owed, whenever it becomes owed.
 *
 * Fetching per repo (rather than one global page filtered down client-side) is
 * what makes the chip's "X of Y" honest: a shared page spends its cap on
 * whichever repos the backend returned first, so hiding one repo could drop the
 * canvas to a fraction of the count the chip was promising for the rest. Each
 * repo asks only for its share of SEED_BUDGET, so per-repo fairness does not
 * cost a canvas that grows with the repo count.
 */
function NodeTypeChip({ type, count }: { type: string; count: number | null }) {
  const { scope, state, dispatch, allRepos } = useExplorer();
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seeded = state.seededTypes.has(type);
  const active = seeded && !state.hiddenTypes.has(type);

  // '' stands for "no repo names in this graph" — one unscoped fetch covers it.
  const selectedRepos = useMemo(() => {
    const selected = allRepos.filter((r) => !state.hiddenRepos.has(r));
    return selected.length > 0 ? selected : [''];
  }, [allRepos, state.hiddenRepos]);

  // Recomputed per seed rather than frozen at first click: a repo revealed later
  // takes the share that is current then, so the budget still governs it.
  const perRepoLimit = seedShare(SEED_BUDGET, selectedRepos.length);

  // Serialised rather than kept as an array so the effect below has a dep that
  // compares by value. JSON, not a joined string: a repo name can hold anything
  // a directory name can, including whatever we would pick as a separator.
  const pending = useMemo(
    () => JSON.stringify(seeded ? selectedRepos.filter((r) => !state.seededTypeRepos.has(seedKey(type, r))) : []),
    [seeded, selectedRepos, state.seededTypeRepos, type],
  );

  useEffect(() => {
    const repos = JSON.parse(pending) as string[];
    if (repos.length === 0) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        for (const repo of repos) {
          const page = await queryClient.fetchQuery(
            graphNodesByTypeQueryOptions(scope, {
              type,
              scopeRepo: repo === '' ? undefined : repo,
              limit: perRepoLimit,
            }),
          );
          if (cancelled) return;
          dispatch({ kind: 'addNodes', nodes: page.nodes, seedKey: seedKey(type, repo) });
        }
      } catch (err) {
        // Fail loudly: a swallowed IPC error makes the chip a dead control.
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pending, perRepoLimit, queryClient, scope, type, dispatch]);

  // Derived from the canvas, not from a fetch result held in local state: the
  // disclosure has to survive this component unmounting (tab switch, collapse).
  //
  // Keyed on `active`, not `seeded`, and counting only un-hidden repos: the
  // number has to describe what is on the canvas right now. A type the user has
  // toggled off renders nothing, and nodes in a hidden repo render nothing, so
  // counting either would put "1,000 shown" on a chip with 15 dots behind it.
  // Memoised because it walks the whole canvas, and there is one chip per type.
  // Never let the cap be silent either: if the selected repos hold more of this
  // type than we pulled, `truncated` puts the shortfall on the chip.
  const { shown, truncated } = useMemo(
    // The walk is skipped for an inactive chip, whose disclosure ignores it.
    () => chipDisclosure(active, active ? visibleCountOfType(state, type) : 0, count),
    [active, state, type, count],
  );

  return (
    <FilterChip
      // The chip face is the type name and its tally, in both states and nothing else.
      // A cap is still never silent — it moves to the title below, which is where the
      // shortfall can be stated in full instead of squeezed into the label.
      label={humanizeType(type)}
      count={count}
      color={nodeColor(type)}
      active={active}
      disabled={loading}
      title={
        error
          ? error
          : truncated
            ? `Showing ${shown?.toLocaleString()} of ${count?.toLocaleString()} — one type is capped at ${SEED_BUDGET.toLocaleString()} nodes, split across the selected repositories`
            : count === 0
              ? 'No nodes of this type in the graph'
              : undefined
      }
      error={error !== null}
      onToggle={() => dispatch(seeded ? { kind: 'toggleType', type } : { kind: 'seedType', type })}
    />
  );
}

function SearchBox() {
  const { scope, state, addSeed } = useExplorer();
  const [term, setTerm] = useState('');
  const [committed, setCommitted] = useState('');
  const { data, isFetching } = useQuery(graphSearchQueryOptions(scope, committed));

  return (
    <section className="flex flex-col gap-2 px-3 pt-3">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setCommitted(term.trim());
        }}
      >
        <div className="relative">
          <Magnifer className="pointer-events-none absolute left-3 top-1/2 size-3 -translate-y-1/2 text-content-quaternary" />
          <Input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Search..."
            aria-label="Search symbols"
            className="pl-8"
          />
        </div>
      </form>

      {committed && (
        <div className="max-h-56 overflow-y-auto">
          {isFetching ? (
            <p className="px-1 py-2 text-xs text-content-quaternary">Searching…</p>
          ) : !data || data.length === 0 ? (
            <p className="px-1 py-2 text-xs text-content-quaternary">No matches.</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {data.map((hit) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    disabled={state.nodes.has(hit.id)}
                    onClick={() => void addSeed(hit.id)}
                    className="w-full cursor-pointer truncate rounded-md px-2 py-1 text-left font-mono text-xs text-content-primary hover:bg-bg-primary-hover disabled:cursor-default disabled:text-content-quaternary-disabled"
                    title={hit.filePath ?? hit.name}
                  >
                    {hit.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
