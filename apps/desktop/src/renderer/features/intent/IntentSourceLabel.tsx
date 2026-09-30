import { useState } from 'react';
import { externalHttpsUrl } from '../../../shared/external-url.js';
import type { IntentItemSource } from '../../../shared/intent-types';

export function IntentSourceLabel({ source }: { source: IntentItemSource }) {
  const url = externalHttpsUrl(source.url);
  const name = source.title ?? source.ref;
  const [openError, setOpenError] = useState<string | null>(null);
  return (
    <span className="flex min-w-0 flex-col">
      {url ? (
        <button
          type="button"
          className="truncate text-left text-[11px] leading-4 text-content-brand underline underline-offset-2"
          title={url}
          onClick={() =>
            void window.electronAPI.openDeliveryExternal({ externalUrl: url }).then((result) => {
              setOpenError(result.success ? null : (result.error ?? 'Could not open the link.'));
            })
          }
        >
          {name}
        </button>
      ) : (
        <span className="truncate text-[11px] leading-4 text-content-secondary">{name}</span>
      )}
      <span className="truncate font-mono text-[10px] leading-4 text-content-tertiary">
        {source.ref}#{source.localId}
        {source.revision ? ` @ ${source.revision}` : ''}
      </span>
      {openError && (
        <span role="alert" className="text-[10px] text-content-danger">
          {openError}
        </span>
      )}
    </span>
  );
}
