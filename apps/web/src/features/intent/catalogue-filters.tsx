/**
 * The catalogue list's production-status and source filters. The source picker
 * owns its own search box, debounce and read; it fetches only while open.
 */

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { intentSourceOptions, type IntentSourceOption } from '@/api/queries/intent';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { messageOf } from './intent-presentation.js';
import { effectivityLabels, type IntentEffectivity } from './release-types.js';

export interface IntentCatalogueFiltersProps {
  workspaceId: string;
  effectivity: IntentEffectivity | '';
  onEffectivityChange: (effectivity: IntentEffectivity | '') => void;
  source: IntentSourceOption | null;
  onSourceChange: (source: IntentSourceOption | null) => void;
}

export function IntentCatalogueFilters({
  workspaceId,
  effectivity,
  onEffectivityChange,
  source,
  onSourceChange,
}: IntentCatalogueFiltersProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1 text-xs text-ink-3">
          <span className="block">Production status</span>
          <Select
            value={effectivity || 'all'}
            onValueChange={(value) => onEffectivityChange(value === 'all' ? '' : (value as IntentEffectivity))}
          >
            <SelectTrigger aria-label="Production status" className="w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All production states</SelectItem>
              {Object.entries(effectivityLabels).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" size="default" onClick={() => setOpen(!open)}>
          {source ? `Source: ${source.title || source.ref}` : 'Choose spec or issue'}
        </Button>
        {source && (
          <Button variant="ghost" size="default" onClick={() => onSourceChange(null)}>
            Clear source filter
          </Button>
        )}
      </div>
      <IntentSourcePicker
        workspaceId={workspaceId}
        open={open}
        onPick={(option) => {
          onSourceChange(option);
          setOpen(false);
        }}
      />
    </>
  );
}

/** Stays mounted while closed, so a reopened picker keeps its search; it reads only while open. */
function IntentSourcePicker({
  workspaceId,
  open,
  onPick,
}: {
  workspaceId: string;
  open: boolean;
  onPick: (source: IntentSourceOption) => void;
}) {
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setTerm(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const sourcesQuery = useQuery(intentSourceOptions(workspaceId, term, open));
  if (!open) return null;

  return (
    <Card className="space-y-2 p-3">
      <Input
        type="search"
        aria-label="Find source"
        placeholder="Find a spec, issue or ADR by title or reference…"
        maxLength={200}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {sourcesQuery.isFetching || search.trim() !== term ? (
        <p className="text-xs text-ink-3">Finding sources…</p>
      ) : sourcesQuery.error ? (
        <p role="alert">{messageOf(sourcesQuery.error)}</p>
      ) : (
        <>
          <div className="max-h-60 space-y-1 overflow-y-auto">
            {sourcesQuery.data?.sources.map((option) => (
              <button
                type="button"
                key={`${option.kind}:${option.ref}`}
                className="block w-full rounded p-2 text-left text-sm text-ink-1 hover:bg-surface-2"
                onClick={() => onPick(option)}
              >
                <span className="block">{option.title || option.ref}</span>
                <span className="block break-all text-xs text-ink-3">
                  {option.kind} · {option.ref}
                </span>
              </button>
            ))}
          </div>
          {sourcesQuery.data?.sources.length === 0 && <p className="text-xs text-ink-3">No matching sources.</p>}
          {sourcesQuery.data?.truncated && (
            <p className="text-xs text-ink-3">Showing 50 sources. Narrow the search to find more.</p>
          )}
        </>
      )}
    </Card>
  );
}
