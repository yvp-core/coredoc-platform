import type { IntentItemSource } from './types.js';

/** A server-supplied url becomes a link only when it is http(s) — never `javascript:`/`file:`. */
export const httpUrl = (value: string | null | undefined): string | null => {
  if (!value) return null;
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:' ? value : null;
  } catch {
    return null;
  }
};

export function IntentSourceLabel({ source }: { source: IntentItemSource }) {
  const url = httpUrl(source.url);
  const name = source.title ?? source.ref;
  return (
    <span className="flex min-w-0 flex-col">
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="break-words text-brand-text underline underline-offset-2"
        >
          {name}
        </a>
      ) : (
        <span className="break-words text-ink-2">{name}</span>
      )}
      <span className="break-all font-mono text-[10.5px] text-ink-4">
        {source.ref}#{source.localId}
        {source.revision ? ` @ ${source.revision}` : ''}
      </span>
    </span>
  );
}
