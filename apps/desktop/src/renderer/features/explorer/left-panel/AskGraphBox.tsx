import { useState } from 'react';
import { MagicStick, Play } from '@solar-icons/react';
import { Button } from '../../../components/ui/button';
import { Textarea } from '../../../components/ui/textarea';
import { useExplorer } from '../explorer-context.js';

interface GeneratedDraft {
  generationRevision: number;
  value: string;
}

export function syncGeneratedDraft(
  current: GeneratedDraft,
  generated: { generationRevision: number; query: string },
): GeneratedDraft {
  if (current.generationRevision === generated.generationRevision) return current;
  return { generationRevision: generated.generationRevision, value: generated.query };
}

/**
 * "Ask the graph" — a natural-language → Cypher seeding path, sibling to search
 * and the type chips.
 *
 * Show-the-query UX (spec decision 2026-08-20): the NL question generates a
 * Cypher query that is shown in an EDITABLE field so the user can correct an
 * off generation before running it. Running executes the (edited) query and
 * merges its result onto the same canvas via the context's `runCypher`.
 *
 * Gated on `caps.cypher`: only Ladybug/Neo4j (local) and the cloud graph render
 * this section; unsupported backends and unresolved capabilities keep it hidden.
 */
export function AskGraphBox() {
  const { caps, cypher, generateCypher, runCypher } = useExplorer();
  const [question, setQuestion] = useState('');

  // The editable draft is local. Generation revision, rather than string equality,
  // identifies a fresh result: the model can legitimately return the same Cypher
  // again, and that success must still replace a blank or previously edited draft.
  const [draft, setDraft] = useState<GeneratedDraft>({
    generationRevision: cypher.generationRevision,
    value: cypher.query,
  });
  const syncedDraft = syncGeneratedDraft(draft, cypher);
  if (syncedDraft !== draft) setDraft(syncedDraft);

  const enabled = caps?.cypher === true;

  return !enabled ? null : (
    <section className="flex flex-col gap-2 px-3 pt-4">
      <div aria-hidden className="mb-0.5 h-px rounded-[10px] bg-border-input" />
      <h3 className="text-sm font-black leading-5 text-content-primary">Ask the graph:</h3>
      <form
        className="flex flex-col gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = question.trim();
          if (trimmed) void generateCypher(trimmed);
        }}
      >
        <Textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. classes that call the push service"
          aria-label="Ask a question about the graph"
          className="min-h-14 text-xs"
        />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          className="w-full"
          disabled={cypher.generating || question.trim().length === 0}
        >
          <MagicStick />
          {cypher.generating ? 'Generating…' : 'Generate query'}
        </Button>
      </form>

      {cypher.query !== '' && (
        <div className="flex flex-col gap-1.5">
          <Textarea
            value={syncedDraft.value}
            onChange={(e) => setDraft({ generationRevision: cypher.generationRevision, value: e.target.value })}
            aria-label="Generated Cypher query"
            spellCheck={false}
            className="min-h-16 font-mono text-xs text-content-primary"
          />
          <Button
            type="button"
            size="sm"
            className="w-full"
            disabled={cypher.running || syncedDraft.value.trim().length === 0}
            onClick={() => void runCypher(syncedDraft.value)}
          >
            <Play />
            {cypher.running ? 'Running…' : 'Run query'}
          </Button>
          {cypher.truncated && (
            <p className="text-xs leading-4 text-content-tag-warning">
              Result was capped — refine with a smaller LIMIT to see it all.
            </p>
          )}
        </div>
      )}

      {cypher.error && (
        <p className="rounded-sm border border-content-tag-warning bg-bg-tag-warning px-3 py-1 text-xs leading-4 text-content-primary">
          {cypher.error}
        </p>
      )}
    </section>
  );
}
